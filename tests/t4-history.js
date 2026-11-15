// 第四部分:use-history sameContent / read-meta 两级匹配 / 归档重名防护 / markSelfWrite 时序
// —— 全部【直接测试生产代码】(真实 main.js,IPC 通道驱动,真实文件系统)
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, mkTmp, cleanupTmp, fakeJpeg, sleep, listFiles, summarize } = require('./common');
const { loadMain, waitBoot, setWallpaperBehavior, closeAllWatchers } = require('./harness');

const ESC = '\uFEFF';

async function mkEnv() {
  const root = mkTmp('acg-hist-');
  const userData = path.join(root, 'userData');
  const pictures = path.join(root, 'Pictures');
  const wallDir = path.join(pictures, 'ACG_Wallpaper');
  const confDir = path.join(userData, 'config');
  fs.mkdirSync(confDir, { recursive: true });
  fs.mkdirSync(wallDir, { recursive: true });
  const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
  await waitBoot(loaded.state, 5000);
  const call = async (channel, ...args) => {
    const fn = loaded.state.ipcHandlers.get(channel);
    if (!fn) throw new Error('通道未注册: ' + channel);
    return await fn({}, ...args);
  };
  const win = loaded.state.windows[0];
  return { root, userData, pictures, wallDir, confDir, confFile: path.join(confDir, 'config.json'), win, ...loaded, call };
}
const readJsonl = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

(async () => {
  // ---------- N. use-history sameContent 两条路径 ----------
  group('N use-history sameContent');
  {
    const env = await mkEnv();
    const cur = path.join(env.wallDir, 'current.jpg');
    const histFile = path.join(env.wallDir, 'history.jsonl');
    const img = fakeJpeg(26000, 'same-N');
    // 场景 N1:来源是"另外一张与 current 内容完全相同"的历史图 -> sameContent=true
    fs.writeFileSync(cur, img);
    fs.writeFileSync(path.join(env.wallDir, 'hist_20260101_010000.jpg'), img);
    fs.writeFileSync(histFile, '', 'utf8');
    const curMtimeBefore = fs.statSync(cur).mtimeMs;
    const histMtimeBefore = fs.statSync(path.join(env.wallDir, 'hist_20260101_010000.jpg')).mtimeMs;
    const r1 = await env.call('use-history', 'hist_20260101_010000.jpg');
    ok('N1', 'sameContent=true 路径返回成功', r1 && r1.ok === true, JSON.stringify(r1));
    ok('N2', 'sameContent=true 时不重复归档(无新增 hist_ 文件)',
      fs.readdirSync(env.wallDir).filter(f => f.startsWith('hist_') && f !== 'hist_20260101_010000.jpg').length === 0,
      '目录: [' + listFiles(env.wallDir).join(', ') + ']');
    ok('N3', 'sameContent=true 时不重写 current(内容与 mtime 都不变)',
      fs.readFileSync(cur).equals(img) && fs.statSync(cur).mtimeMs === curMtimeBefore,
      'mtime 前 ' + curMtimeBefore + ' 后 ' + fs.statSync(cur).mtimeMs);
    ok('N4', 'sameContent=true 时来源历史文件未被移动/删除',
      fs.existsSync(path.join(env.wallDir, 'hist_20260101_010000.jpg')) && fs.statSync(path.join(env.wallDir, 'hist_20260101_010000.jpg')).mtimeMs === histMtimeBefore);
    ok('N5', 'sameContent=true 时仍写了历史记录与回执',
      readJsonl(histFile).length === 1 && fs.existsSync(path.join(env.wallDir, 'wallpaper_meta.json')),
      'history 行数=' + readJsonl(histFile).length);
    ok('N6', 'sameContent=true 时 setWallpaper 仍被调用(应用已有 current)', (globalThis.__wallpaperCalls || []).length === 1, JSON.stringify(globalThis.__wallpaperCalls));

    // 场景 N2:来源与 current 内容不同 -> sameContent=false,归档 + 写入
    globalThis.__wallpaperCalls = [];
    const img2 = fakeJpeg(27000, 'diff-N');
    fs.writeFileSync(path.join(env.wallDir, 'hist_20260101_010100.jpg'), img2);
    const r2 = await env.call('use-history', 'hist_20260101_010100.jpg');
    const histNow = fs.readdirSync(env.wallDir).filter(f => f.startsWith('hist_'));
    ok('N7', 'sameContent=false 路径返回成功', r2 && r2.ok === true, JSON.stringify(r2));
    ok('N8', 'sameContent=false 时归档了原 current(新增 1 个 hist 文件)', histNow.length === 3, 'hist 文件: [' + histNow.join(', ') + ']');
    ok('N9', 'sameContent=false 时 current 被更新为新内容', fs.readFileSync(cur).equals(img2));
    ok('N10', 'sameContent=false 时原 current 内容保留在归档里', histNow.some(f => {
      const p = path.join(env.wallDir, f);
      return !/hist_20260101_010(000|100)/.test(f) && fs.readFileSync(p).equals(img);
    }), '归档文件: [' + histNow.join(', ') + ']');
    ok('N11', '两次调用累计 2 条历史记录', readJsonl(histFile).length === 2, '行数=' + readJsonl(histFile).length);

    // 场景 N3:来源就是 current 自己 -> current:true 捷径,不归档不写
    const n3before = readJsonl(histFile).length;
    const r3 = await env.call('use-history', 'current.jpg');
    ok('N12', '来源为 current 自身时走捷径返回 {ok:true,current:true}', r3 && r3.ok === true && r3.current === true, JSON.stringify(r3));
    ok('N13', '捷径路径不新增历史记录', readJsonl(histFile).length === n3before, n3before + ' -> ' + readJsonl(histFile).length);
  }

  // ---------- O. use-history 元数据匹配(histFile 优先 / bytes 兜底) ----------
  group('O use-history 元数据匹配');
  {
    const env = await mkEnv();
    const histFile = path.join(env.wallDir, 'history.jsonl');
    const src = fakeJpeg(33000, 'meta-O');
    fs.writeFileSync(path.join(env.wallDir, 'hist_20260101_020000.jpg'), src);
    // 构造:一条精确记录(histFile 匹配,bytes 故意写错) + 一条 bytes 匹配的干扰记录
    fs.writeFileSync(histFile, [
      JSON.stringify({ file: 'current.jpg', source: 'lolicon', title: '干扰项-同字节', bytes: 33000 }),
      JSON.stringify({ file: 'current.jpg', source: 'ai', title: '精确项', prompt: 'exact-prompt', bytes: 999, histFile: 'hist_20260101_020000.jpg' }),
    ].join('\n') + '\n', 'utf8');
    const r = await env.call('use-history', 'hist_20260101_020000.jpg');
    const rows = readJsonl(histFile);
    const last = rows[rows.length - 1];
    ok('O1', 'use-history 成功', r && r.ok === true, JSON.stringify(r));
    ok('O2', '元数据按 histFile 精确匹配(命中"精确项"而非"干扰项")',
      last.title === '精确项' && last.source === 'ai' && last.prompt === 'exact-prompt', JSON.stringify(last));
    ok('O3', '精确匹配时不被 bytes 相同的干扰记录劫持', last.title !== '干扰项-同字节', last.title);
  }

  // ---------- P. read-meta 两级匹配与优先级 ----------
  group('P read-meta 两级匹配');
  {
    const env = await mkEnv();
    const histFile = path.join(env.wallDir, 'history.jsonl');
    // 构造真实存在的三代数据形态
    fs.writeFileSync(histFile, ESC + [
      // 行1:旧脚本格式(file 直接等于 hist 文件名),带 BOM 首行
      JSON.stringify({ file: 'hist_20260101_030000.jpg', time: 'old-script', source: 'script', bytes: 111 }),
      // 行2:损坏行(并发写半行),必须跳过且不影响后续
      '{"file":"hist_broken.jpg","time":"半行',  
      // 行3:新格式 histFile 指向同一文件名(优先级应更高)
      JSON.stringify({ file: 'current.jpg', time: 'new-format', source: 'app', bytes: 222, histFile: 'hist_20260101_030000.jpg' }),
      // 行4:非 JSON 垃圾
      'not json at all',
      // 行5:旧脚本另一种(file 就是 hist 名,但更早)
      JSON.stringify({ file: 'hist_20260101_030000.jpg', time: 'old-script-earlier', source: 'script', bytes: 333 }),
    ].join('\n') + '\n', 'utf8');

    const m = await env.call('read-meta', 'hist_20260101_030000.jpg');
    ok('P1', '同一文件名同时存在两级记录时,histFile 一级优先', m && m.time === 'new-format', JSON.stringify(m));
    ok('P2', '一级命中时不会落到二级(file 匹配)', m && m.source === 'app', JSON.stringify(m));

    const m2 = await env.call('read-meta', 'hist_20260101_039999.jpg');
    ok('P3', '两级都不匹配返回 null', m2 === null, JSON.stringify(m2));

    // 只有旧格式的记录
    fs.writeFileSync(histFile, [
      JSON.stringify({ file: 'hist_old_only.jpg', time: 'old', source: 'script', bytes: 1 }),
    ].join('\n') + '\n', 'utf8');
    const m3 = await env.call('read-meta', 'hist_old_only.jpg');
    ok('P4', '仅旧格式记录时二级匹配生效', m3 && m3.time === 'old', JSON.stringify(m3));

    // 倒序优先:多条相同 file,取最后一条
    fs.writeFileSync(histFile, [
      JSON.stringify({ file: 'hist_dup.jpg', time: 'v1' }),
      JSON.stringify({ file: 'hist_dup.jpg', time: 'v2' }),
      JSON.stringify({ file: 'hist_dup.jpg', time: 'v3' }),
    ].join('\n') + '\n', 'utf8');
    const m4 = await env.call('read-meta', 'hist_dup.jpg');
    ok('P5', '同名多条记录取最后一条(倒序优先)', m4 && m4.time === 'v3', JSON.stringify(m4));

    // 损坏行容错:整体读失败以外的损坏均跳过
    fs.writeFileSync(histFile, [
      '{"broken": ',
      JSON.stringify({ file: 'hist_after_broken.jpg', time: 'ok' }),
      '}{',
    ].join('\n') + '\n', 'utf8');
    const m5 = await env.call('read-meta', 'hist_after_broken.jpg');
    ok('P6', '损坏行被跳过、后续合法行仍可命中', m5 && m5.time === 'ok', JSON.stringify(m5));

    // 空文件 / 不存在
    fs.writeFileSync(histFile, '', 'utf8');
    ok('P7', 'history.jsonl 为空时返回 null', (await env.call('read-meta', 'x.jpg')) === null);
    fs.unlinkSync(histFile);
    ok('P8', 'history.jsonl 不存在时返回 null 且不抛错', (await env.call('read-meta', 'x.jpg')) === null);

    // bytes 兜底确认已移除:仅字节数相同不应命中
    fs.writeFileSync(histFile, [JSON.stringify({ file: 'current.jpg', bytes: 424242, time: 'bytes-only' })].join('\n') + '\n', 'utf8');
    const m6 = await env.call('read-meta', 'hist_20260101_039998.jpg');
    ok('P9', 'read-meta 无 bytes 兜底(字节数相同不会误关联)', m6 === null, JSON.stringify(m6));
  }

  // ---------- Q. 归档重名防护 ----------
  group('Q archiveCurrent 重名防护');
  {
    const env = await mkEnv();
    const cur = path.join(env.wallDir, 'current.jpg');
    const histFile = path.join(env.wallDir, 'history.jsonl');
    const A = fakeJpeg(15000, 'Q-A');
    const B = fakeJpeg(16000, 'Q-B');
    fs.writeFileSync(cur, A);
    fs.writeFileSync(histFile, JSON.stringify({ file: 'current.jpg', time: 'q0', bytes: A.length }) + '\n', 'utf8');
    // 连续两次 use-history,间隔极短,极可能落在同一秒(触发同名归档)
    fs.writeFileSync(path.join(env.wallDir, 'hist_src1.jpg'), B);
    fs.writeFileSync(path.join(env.wallDir, 'hist_src2.jpg'), fakeJpeg(17000, 'Q-C'));
    const r1 = await env.call('use-history', 'hist_src1.jpg');
    const r2 = await env.call('use-history', 'hist_src2.jpg');
    ok('Q1', '两次连续 use-history 均成功', r1 && r1.ok && r2 && r2.ok, JSON.stringify([r1, r2]));
    const archived = fs.readdirSync(env.wallDir).filter(f => f.startsWith('hist_2') );
    // 找两次归档产生的文件(排除两个来源文件 hist_src*)
    const produced = fs.readdirSync(env.wallDir).filter(f => /^hist_\d{8}_\d{6}(_\d+)?\.jpg$/.test(f));
    ok('Q2', '两次归档产生 2 个归档文件(未互相覆盖)', produced.length === 2, '归档: [' + produced.join(', ') + ']');
    ok('Q3', '同秒归档时第二个带 _1 去重后缀', (() => {
      const bases = produced.map(f => f.replace(/_\d+\.jpg$/, '').replace(/\.jpg$/, ''));
      const hasSuffix = produced.some(f => /_1\.jpg$/.test(f));
      const sameBase = new Set(bases).size === 1;
      return hasSuffix || !sameBase; // 同秒时必须出现 _1;跨秒时自然不重名,同样不算覆盖
    })(), '归档文件: [' + produced.join(', ') + ']');
    ok('Q4', '第一次归档的 A 图内容仍可完整找回(未被覆盖)',
      produced.some(f => fs.readFileSync(path.join(env.wallDir, f)).equals(A)),
      '归档大小: ' + produced.map(f => f + '=' + fs.statSync(path.join(env.wallDir, f)).size).join(', '));
    ok('Q5', '第二次归档的 B 图内容仍可完整找回',
      produced.some(f => fs.readFileSync(path.join(env.wallDir, f)).equals(B)));
    ok('Q6', 'history.jsonl 中两次归档的 histFile 指向不同文件', (() => {
      const rows = readJsonl(histFile).filter(r => r.histFile);
      const names = rows.map(r => r.histFile);
      return new Set(names).size === names.length && names.every(n => fs.existsSync(path.join(env.wallDir, n)));
    })(), JSON.stringify(readJsonl(histFile).map(r => r.histFile)));
  }

  // ---------- R. markSelfWrite 时序(自身写入不被误判成外部写入) ----------
  group('R markSelfWrite 与 watcher 来源判定');
  {
    const env = await mkEnv();
    const cur = path.join(env.wallDir, 'current.jpg');
    fs.writeFileSync(cur, fakeJpeg(12000, 'R-old'));
    env.win.sentMessages.length = 0;
    fs.writeFileSync(path.join(env.wallDir, 'hist_src_r.jpg'), fakeJpeg(13000, 'R-new'));
    await env.call('use-history', 'hist_src_r.jpg');
    await sleep(1200); // watcher 防抖 500ms + 余量
    const reasons = env.win.sentMessages.filter(m => m.channel === 'ui-refresh').map(m => m.payload);
    ok('R1', '本程序换图产生的文件事件全部被判为 self', reasons.length > 0 && reasons.every(x => x === 'self'),
      'ui-refresh 原因序列: ' + JSON.stringify(reasons));

    // 5 秒窗口内的外部写入:会被判为 self —— 这是 SELF_WRITE_WINDOW 的设计权衡,不是缺陷,
    // 记录下来作为"已知窗口期限制"(旧脚本若恰好在换图后 5 秒内换图,UI 不提示"外部更新")。
    const tInWindow = Date.now();
    const beforeIn = env.win.sentMessages.length;
    fs.writeFileSync(path.join(env.wallDir, 'wallpaper_meta.json'), ESC + JSON.stringify({ time: 'in-window', source: 'script' }), 'utf8');
    await sleep(900);
    const inWindow = env.win.sentMessages.slice(beforeIn).filter(m => m.channel === 'ui-refresh').map(m => m.payload);
    ok('R2a', '已知限制:自身写入后 5 秒窗口内的外部写入被判为 self(设计权衡,记录不判缺陷)',
      inWindow.length > 0 && inWindow.every(x => x === 'self'),
      '距上次 markSelfWrite 约 ' + (Date.now() - tInWindow) + 'ms, 原因序列: ' + JSON.stringify(inWindow));

    // 窗口外的外部写入(模拟旧脚本单独换图):必须判为 external
    const waitMore = Math.max(0, 5200 - (Date.now() - tInWindow));
    await sleep(waitMore);
    env.win.sentMessages.length = 0;
    fs.writeFileSync(path.join(env.wallDir, 'wallpaper_meta.json'), ESC + JSON.stringify({ time: 'ext', source: 'script' }), 'utf8');
    await sleep(1200);
    const after = env.win.sentMessages.filter(m => m.channel === 'ui-refresh').map(m => m.payload);
    ok('R2b', '超出 5 秒窗口的外部写入被判为 external', after.length > 0 && after.every(x => x === 'external'),
      '原因序列: ' + JSON.stringify(after));

    const st = await env.call('get-status');
    ok('R4', '外部写的带 BOM 回执经 get-status 可见', !!st.scriptMeta && st.scriptMeta.source === 'script', JSON.stringify(st.scriptMeta));
  }

  const s = summarize();
  console.log('\n---- 第四部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title).join(' | '));
  closeAllWatchers();
  await sleep(120);
  cleanupTmp();
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); closeAllWatchers(); cleanupTmp(); process.exit(2); });
