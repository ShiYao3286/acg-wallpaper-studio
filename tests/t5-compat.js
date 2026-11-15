// 第五部分:旧数据兼容(真实用户数据只读副本) + 单实例锁 + 启动自愈 + 文件安全
//   兼容性/数据层:【直接测试生产代码】(真实 main.js 驱动)
//   真实数据来源:运行时探测到的旧数据目录的**副本**,绝不修改原件
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { group, ok, skip, mkTmp, cleanupTmp, fakeJpeg, sleep, listFiles, snapshotDir, diffSnapshot, summarize, firstExistingWallDir, legacyScriptWallDir } = require('./common');
const { loadMain, waitBoot, setWallpaperBehavior, closeAllWatchers } = require('./harness');

const ESC = '\uFEFF';
// 真实旧数据目录:运行时探测,不硬编码开发者本机路径(见 common.js 说明)。
// 找不到就跳过兼容性组并显式打印 [SKIP],不伪造通过。
const REAL_D = firstExistingWallDir();
const REAL_C = legacyScriptWallDir();

async function mkEnv(wallDirSeed) {
  const root = mkTmp('acg-compat-');
  const userData = path.join(root, 'userData');
  const pictures = path.join(root, 'Pictures');
  const wallDir = path.join(pictures, 'ACG_Wallpaper');
  const confDir = path.join(userData, 'config');
  fs.mkdirSync(confDir, { recursive: true });
  fs.mkdirSync(wallDir, { recursive: true });
  if (wallDirSeed) fs.cpSync(wallDirSeed, wallDir, { recursive: true });
  const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
  await waitBoot(loaded.state, 5000);
  const call = async (channel, ...args) => {
    const fn = loaded.state.ipcHandlers.get(channel);
    if (!fn) throw new Error('通道未注册: ' + channel);
    return await fn({}, ...args);
  };
  return { root, userData, pictures, wallDir, confDir, confFile: path.join(confDir, 'config.json'), ...loaded, call };
}
const readJsonl = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l.startsWith('\uFEFF') ? l.slice(1) : l); } catch { return null; } }).filter(Boolean);

(async () => {
  // ---------- 真实用户数据只读快照(测试前后比对,证明未被触碰) ----------
  // REAL_D/REAL_C 可能是 null(本机无旧数据),snapshotDir(null) 会返回 exists:false,不抛错
  const snapD0 = snapshotDir(REAL_D);
  const snapC0 = snapshotDir(REAL_C);
  const hasD = snapD0.exists && snapD0.entries.length > 0;
  const hasC = snapC0.exists && snapC0.entries.length > 0;
  // S0/S0b 是"环境探测结果",不是被测行为。
  // 本机没有旧数据不是缺陷,因此找到时 PASS,找不到时 SKIP —— 绝不判 FAIL,
  // 否则换一台干净机器跑测试会因缺少素材而整体变红。
  const probe = (id, title, has, label, n) => {
    if (has) ok(id, title, true, label + ': ' + n + ' 个文件');
    else skip(id, title, '未探测到真实目录(本机无该素材)');
  };
  probe('S0', '真实数据目录 D 存在且有文件', hasD, 'D', snapD0.entries.length);
  probe('S0b', '真实数据目录 C 存在且有文件', hasC, 'C', snapC0.entries.length);

  // ---------- S. 旧数据兼容:真实 24 行 history(副本上验证) ----------
  group('S 旧数据兼容(真实 history.jsonl 副本)');
  if (!hasD || !hasC) {
    // 本机缺少真实旧数据:显式跳过整组,不伪造通过
    skip('S1-S13', '旧数据兼容性组(需真实旧数据)', '未探测到真实壁纸目录(D=' + REAL_D + ', C=' + REAL_C + ')');
  } else {
    const env = await mkEnv(REAL_D);
    const rows = readJsonl(path.join(env.wallDir, 'history.jsonl'));
    ok('S1', '副本 history.jsonl 可完整解析 24 行', rows.length === 24, '解析出 ' + rows.length + ' 行');
    const oldFmt = rows.filter(r => /^hist_/.test(String(r.file)));
    const newFmt = rows.filter(r => r.histFile);
    ok('S2', '真实数据同时含旧格式(file=hist_*)与新格式(histFile)', oldFmt.length > 0 && newFmt.length > 0,
      '旧格式 ' + oldFmt.length + ' 行, 新格式 ' + newFmt.length + ' 行');

    // 旧格式记录:read-meta 应能按 file 二级匹配命中
    const oldName = oldFmt[0].file;
    const mOld = await env.call('read-meta', oldName);
    ok('S3', '旧格式记录 read-meta 命中(file 二级匹配)', !!mOld && mOld.file === oldName, '查询 ' + oldName + ' -> ' + JSON.stringify(mOld && { file: mOld.file, title: mOld.title, bytes: mOld.bytes }));

    // 新格式记录:read-meta 应能按 histFile 一级匹配命中
    const newName = newFmt[0].histFile;
    const mNew = await env.call('read-meta', newName);
    ok('S4', '新格式记录 read-meta 命中(histFile 一级匹配)', !!mNew && mNew.histFile === newName, '查询 ' + newName + ' -> ' + JSON.stringify(mNew && { histFile: mNew.histFile, bytes: mNew.bytes }));

    // 每条真实历史文件名都能在 read-meta 中找到对应记录(旧+新)
    const allNames = [...new Set([...oldFmt.map(r => r.file), ...newFmt.map(r => r.histFile)])];
    const misses = [];
    for (const n of allNames) { const m = await env.call('read-meta', n); if (!m) misses.push(n); }
    ok('S5', '真实历史中所有 hist 文件名均可 read-meta 命中', misses.length === 0,
      '共 ' + allNames.length + ' 个名, 未命中 ' + misses.length + (misses.length ? ': ' + misses.join(',') : ''));

    // 真实 D 盘 wallpaper_meta.json(无 BOM)可读
    const st = await env.call('get-status');
    ok('S6', '真实 D 盘回执(无 BOM)经 get-status 可读', !!st.scriptMeta && typeof st.scriptMeta === 'object', JSON.stringify(st.scriptMeta));
    ok('S7', '真实 D 盘 current.jpg 被识别', !!st.currentPath && fs.existsSync(st.currentPath), 'currentPath=' + st.currentPath);

    // 真实 C 盘(旧脚本产物,带 BOM)副本
    const envC = await mkEnv(REAL_C);
    const stC = await envC.call('get-status');
    ok('S8', '真实 C 盘旧脚本回执(带 BOM)经 get-status 可读', !!stC.scriptMeta && stC.scriptMeta.source === 'script', JSON.stringify(stC.scriptMeta));
    const metaBytes = fs.readFileSync(path.join(envC.wallDir, 'wallpaper_meta.json'));
    ok('S9', 'C 盘回执原件确以 EF BB BF 开头(能暴露 BOM 缺陷的真实素材)', metaBytes[0] === 0xEF && metaBytes[1] === 0xBB && metaBytes[2] === 0xBF, metaBytes.slice(0, 3).toString('hex'));
    // 旧脚本只写 wallpaper_meta.json / current.jpg,没有 history.jsonl
    ok('S10', 'C 盘无 history.jsonl 时 read-meta 返回 null 而非抛错',
      !fs.existsSync(path.join(envC.wallDir, 'history.jsonl')) && (await envC.call('read-meta', 'x.jpg')) === null);
    // C 盘目录用真实旧脚本产物驱动 use-history
    setWallpaperBehavior(undefined);
    const rUse = await envC.call('use-history', 'current.jpg');
    ok('S11', 'C 盘旧脚本产物的 current.jpg 可被 use-history 应用(捷径路径)', rUse && rUse.ok === true && rUse.current === true, JSON.stringify(rUse));
    const rUse2 = await envC.call('use-history', 'hist_20261110_101418.jpg');
    ok('S12', 'C 盘旧脚本 hist 文件可被 use-history 切换且成功', rUse2 && rUse2.ok === true, JSON.stringify(rUse2));
    ok('S13', 'C 盘旧脚本 hist 源文件在切换后仍存在(用户数据不删)',
      fs.existsSync(path.join(envC.wallDir, 'hist_20261110_101418.jpg')));
  }

  // ---------- T. 启动自愈 healInterruptedTransaction ----------
  group('T 启动自愈');
  {
    const root = mkTmp('acg-heal-');
    const userData = path.join(root, 'userData');
    const pictures = path.join(root, 'Pictures');
    const wallDir = path.join(pictures, 'ACG_Wallpaper');
    fs.mkdirSync(path.join(userData, 'config'), { recursive: true });
    fs.mkdirSync(wallDir, { recursive: true });
    const lost = fakeJpeg(22000, 'heal');
    fs.writeFileSync(path.join(wallDir, 'hist_20260101_040000.jpg'), lost);
    fs.writeFileSync(path.join(wallDir, 'history.jsonl'), JSON.stringify({ file: 'current.jpg', time: 't', bytes: 22000, histFile: 'hist_20260101_040000.jpg' }) + '\n', 'utf8');
    ok('T0', '前置:current.jpg 不存在但归档存在(模拟中断)', !fs.existsSync(path.join(wallDir, 'current.jpg')) && fs.existsSync(path.join(wallDir, 'hist_20260101_040000.jpg')));
    setWallpaperBehavior(undefined); // 重置跨环境的 setWallpaper 调用记录,保证本组断言隔离
    const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
    await waitBoot(loaded.state, 5000);
    await sleep(300);
    ok('T1', '启动后自愈把归档复制回 current.jpg', fs.existsSync(path.join(wallDir, 'current.jpg')), 'current 存在=' + fs.existsSync(path.join(wallDir, 'current.jpg')));
    ok('T2', '恢复的 current 内容与归档一致', fs.existsSync(path.join(wallDir, 'current.jpg')) && fs.readFileSync(path.join(wallDir, 'current.jpg')).equals(lost));
    ok('T3', '自愈保留归档文件(不删除)', fs.existsSync(path.join(wallDir, 'hist_20260101_040000.jpg')));
    ok('T4', '自愈不改动 history.jsonl', readJsonl(path.join(wallDir, 'history.jsonl')).length === 1);
    ok('T5', '自愈未设置系统壁纸(交给 UI 常规刷新)', (globalThis.__wallpaperCalls || []).length === 0, JSON.stringify(globalThis.__wallpaperCalls));
    // 自愈信息通过 get-status 的 lastInfo 暴露给 UI(渲染层据此提示)
    const stHeal = await (async () => { const fn = loaded.state.ipcHandlers.get('get-status'); return await fn({}); })();
    ok('T6', '自愈信息通过 get-status.lastInfo 暴露给 UI', /中断/.test(String(stHeal.lastInfo)) && /恢复/.test(String(stHeal.lastInfo)), JSON.stringify(stHeal.lastInfo));
    // 原观察项已修复:buildTrayMenu 的 tooltip 此前只读 lastRun,自愈写的是 lastInfo,
    // 导致"已从归档恢复 current.jpg"这条消息永远显示不出来、托盘一直停在"就绪"。
    // 现改为 lastRun 优先 → lastInfo → 就绪,故此处由"记录缺陷"改为"验证修复生效"。
    ok('T6b', '修复验证:托盘 tooltip 已包含自愈信息(lastInfo 回退生效)',
      loaded.state.trays.length > 0 && /中断|恢复/.test(loaded.state.trays[0].tooltip),
      'tooltip=' + (loaded.state.trays.length ? loaded.state.trays[0].tooltip : '无托盘'));
    closeAllWatchers();
    await sleep(80);
  }

  // ---------- T2. 自愈不误判:末条无 histFile ----------
  group('T2 自愈不误判');
  {
    const root = mkTmp('acg-heal2-');
    const userData = path.join(root, 'userData');
    const pictures = path.join(root, 'Pictures');
    const wallDir = path.join(pictures, 'ACG_Wallpaper');
    fs.mkdirSync(path.join(userData, 'config'), { recursive: true });
    fs.mkdirSync(wallDir, { recursive: true });
    // 存在历史归档,但末条记录没有 histFile(正常完成) -> 不应恢复
    fs.writeFileSync(path.join(wallDir, 'hist_20260101_050000.jpg'), fakeJpeg(1000, 'x'));
    fs.writeFileSync(path.join(wallDir, 'history.jsonl'), JSON.stringify({ file: 'current.jpg', time: 't', bytes: 1234 }) + '\n', 'utf8');
    const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
    await waitBoot(loaded.state, 5000);
    await sleep(300);
    ok('T7', '末条无 histFile 时不恢复(避免误判)', !fs.existsSync(path.join(wallDir, 'current.jpg')));
    closeAllWatchers();
    await sleep(80);
  }

  // ---------- U. 单实例锁 ----------
  group('U 单实例锁');
  {
    // U1:拿不到锁
    const root1 = mkTmp('acg-lock1-');
    const ud1 = path.join(root1, 'userData'), pic1 = path.join(root1, 'Pictures');
    fs.mkdirSync(path.join(ud1, 'config'), { recursive: true });
    fs.mkdirSync(path.join(pic1, 'ACG_Wallpaper'), { recursive: true });
    const l1 = loadMain({ userDataDir: ud1, picturesDir: pic1, holdReady: false, singleInstanceLock: false });
    await sleep(400);
    ok('U1', '拿不到单实例锁时调用 app.quit()', l1.state.quitCalled >= 1, 'quit 调用次数: ' + l1.state.quitCalled);
    ok('U2', '拿不到锁时不进入 whenReady 分支', l1.state.whenReadyCalled === 0, 'whenReady 调用次数: ' + l1.state.whenReadyCalled);
    ok('U3', '拿不到锁时不创建窗口/托盘', l1.state.windows.length === 0 && l1.state.trays.length === 0,
      '窗口 ' + l1.state.windows.length + ' 托盘 ' + l1.state.trays.length);

    // U4:拿到锁 -> 正常启动,并注册 second-instance
    const root2 = mkTmp('acg-lock2-');
    const ud2 = path.join(root2, 'userData'), pic2 = path.join(root2, 'Pictures');
    fs.mkdirSync(path.join(ud2, 'config'), { recursive: true });
    fs.mkdirSync(path.join(pic2, 'ACG_Wallpaper'), { recursive: true });
    const l2 = loadMain({ userDataDir: ud2, picturesDir: pic2, holdReady: false, singleInstanceLock: true });
    await waitBoot(l2.state, 5000);
    ok('U4', '拿到锁时进入 whenReady 并创建 1 个窗口', l2.state.whenReadyCalled === 1 && l2.state.windows.length === 1,
      'whenReady ' + l2.state.whenReadyCalled + ' 窗口 ' + l2.state.windows.length);
    ok('U5', '拿到锁时不调用 quit', l2.state.quitCalled === 0, 'quit 次数: ' + l2.state.quitCalled);
    ok('U6', '注册了 second-instance 事件', typeof l2.electron.app.__emit === 'function' && !!l2.state.appEvents.get('second-instance'));
    // 触发 second-instance:窗口应被拉到前台
    const w = l2.state.windows[0];
    w.hide(); w._minimized = true; w._focused = false;
    l2.electron.app.__emit('second-instance');
    ok('U7', '第二次启动时已有窗口被 restore/show/focus', w._minimized === false && w._visible === true && w._focused === true,
      'minimized=' + w._minimized + ' visible=' + w._visible + ' focused=' + w._focused);
    ok('U8', 'BrowserWindow 使用 contextIsolation:true / nodeIntegration:false', (() => {
      const wp = l2.state.browserWindowOptions[0] && l2.state.browserWindowOptions[0].webPreferences;
      return !!wp && wp.contextIsolation === true && wp.nodeIntegration === false;
    })(), JSON.stringify(l2.state.browserWindowOptions[0] && l2.state.browserWindowOptions[0].webPreferences));
    closeAllWatchers();
    await sleep(80);
  }

  // ---------- V. 真实用户数据零触碰验证 ----------
  group('V 真实用户数据零触碰');
  if (!hasD && !hasC) {
    // 目录不存在时"前后一致"恒真,没有证明力,显式跳过而不是白送通过
    skip('V1-V5', '真实用户数据零触碰', '未探测到真实壁纸目录,无法进行前后比对');
  } else {
    const snapD1 = snapshotDir(REAL_D);
    const snapC1 = snapshotDir(REAL_C);
    const diffD = diffSnapshot(snapD0, snapD1);
    const diffC = diffSnapshot(snapC0, snapC1);
    if (hasD) {
      ok('V1', 'D 盘真实壁纸目录测试前后完全一致(名/大小/mtime/内容哈希)', diffD === null, diffD ? JSON.stringify(diffD) : '无差异');
      ok('V3', 'D 盘文件数与测试前一致', snapD0.entries.length === snapD1.entries.length, snapD0.entries.length + ' -> ' + snapD1.entries.length);
    } else {
      skip('V1', 'D 盘真实壁纸目录测试前后完全一致', '未探测到 D 盘真实目录');
      skip('V3', 'D 盘文件数与测试前一致', '未探测到 D 盘真实目录');
    }
    if (hasC) {
      ok('V2', 'C 盘真实壁纸目录测试前后完全一致', diffC === null, diffC ? JSON.stringify(diffC) : '无差异');
    } else {
      skip('V2', 'C 盘真实壁纸目录测试前后完全一致', '未探测到 C 盘真实目录');
    }
    if (hasD) {
      ok('V4', 'D 盘 history.jsonl 哈希未变', (() => {
        const a = snapD0.entries.find(e => e.name === 'history.jsonl');
        const b = snapD1.entries.find(e => e.name === 'history.jsonl');
        return a && b && a.hash === b.hash;
      })());
      ok('V5', '未在真实目录产生 .tmp 残留', !snapD1.entries.some(e => /\.tmp$/.test(e.name)),
        snapD1.entries.map(e => e.name).join(', '));
    } else {
      skip('V4', 'D 盘 history.jsonl 哈希未变', '未探测到 D 盘真实目录');
      skip('V5', '未在真实目录产生 .tmp 残留', '未探测到 D 盘真实目录');
    }
  }

  const s = summarize();
  console.log('\n---- 第五部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败' + (s.skipped ? ', ' + s.skipped + ' 跳过' : '') + ' ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  closeAllWatchers();
  await sleep(120);
  cleanupTmp();
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); closeAllWatchers(); cleanupTmp(); process.exit(2); });
