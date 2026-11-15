// 第三部分:换图事务 / 回滚 / 历史应用 —— 全部【直接测试生产代码】(真实 main.js + IPC 通道驱动)
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, mkTmp, cleanupTmp, fakeJpeg, sleep, listFiles, summarize } = require('./common');
const { loadMain, waitBoot, setWallpaperBehavior, closeAllWatchers, setReadFileHook, setRenameFailPredicate } = require('./harness');

const ESC = '\uFEFF';

async function mkEnv() {
  const root = mkTmp('acg-tx-');
  const userData = path.join(root, 'userData');
  const pictures = path.join(root, 'Pictures');
  const wallDir = path.join(pictures, 'ACG_Wallpaper');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(wallDir, { recursive: true });
  const confDir = path.join(userData, 'config');
  fs.mkdirSync(confDir, { recursive: true });
  const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
  await waitBoot(loaded.state, 5000);
  const call = async (channel, ...args) => {
    const fn = loaded.state.ipcHandlers.get(channel);
    if (!fn) throw new Error('通道未注册: ' + channel);
    return await fn({}, ...args);
  };
  return { root, userData, pictures, wallDir, confDir, confFile: path.join(confDir, 'config.json'), ...loaded, call };
}
const exists = (p) => fs.existsSync(p);
const writeCfg = (env, obj) => {
  fs.mkdirSync(env.confDir ? path.dirname(env.confFile) : '', { recursive: true });
  fs.writeFileSync(env.confFile, JSON.stringify(obj, null, 2), 'utf8');
};

(async () => {
  // ---------- H. saveConfig 原子写与失败保护 ----------
  group('H saveConfig 原子写');
  {
    const env = await mkEnv();
    env.confFile = path.join(env.userData, 'config', 'config.json');
    const r1 = await env.call('save-config', 'history.keepCount', 42);
    ok('H1', 'save-config 成功返回配置对象', r1 && r1.history && r1.history.keepCount === 42, JSON.stringify(r1 && r1.history));
    const before = fs.readFileSync(env.confFile, 'utf8');
    ok('H2', '写入后无 .tmp 残留', !exists(env.confFile + '.tmp'), '配置目录: [' + listFiles(path.dirname(env.confFile)).join(', ') + ']');
    // 让 rename 失败,验证原 config.json 不被破坏
    setRenameFailPredicate((a, b) => b === env.confFile);
    // save-config 现在会把落盘异常转成契约结构返回(不让异常穿透 IPC),
    // 因此这里断言"返回 ok:false"而不是"抛错";两种都表示失败对渲染层可见。
    let threw = false, rFail = null;
    try { rFail = await env.call('save-config', 'history.keepCount', 99); } catch { threw = true; }
    setRenameFailPredicate(null);
    const after = fs.readFileSync(env.confFile, 'utf8');
    ok('H3', 'rename 失败时原 config.json 内容未被破坏', before === after, '原长度 ' + before.length + ' 现长度 ' + after.length);
    ok('H4', 'rename 失败时失败对调用方可见(返回 ok:false 或抛错)',
      threw === true || (rFail && rFail.ok === false), 'threw=' + threw + ' 返回=' + JSON.stringify(rFail).slice(0, 90));
    // 临时文件名现在是 pid+随机后缀(避免并发互相 rename),失败时会被主动清理。
    // 因此断言改为:配置目录里不留任何 .tmp 残片,且主文件仍是上一次成功写入的内容。
    const leftover = listFiles(path.dirname(env.confFile)).filter(f => f.includes('.tmp'));
    ok('H5', 'rename 失败后不残留 .tmp 且主文件完好', leftover.length === 0 && JSON.parse(after).history.keepCount === 42,
      'tmp残片=[' + leftover.join(',') + '] 主文件 keepCount=' + JSON.parse(after).history.keepCount);
  }

  // ---------- I. rollbackWallpaper:情况 A(有归档,从 hist 恢复) ----------
  group('I rollback 情况 A(有归档)');
  {
    const env = await mkEnv();
    env.confFile = path.join(env.userData, 'config', 'config.json');
    const cur = path.join(env.wallDir, 'current.jpg');
    const oldImg = fakeJpeg(20000, 'old-A');
    fs.writeFileSync(cur, oldImg);
    fs.writeFileSync(env.confFile, JSON.stringify({ source: 'ai', services: [{ id: 'svcA', kind: 'image', name: 'n', apiBase: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' }], activeImageService: 'svcA', ai: { prompt: 'x', size: '512x512', randomMode: 'custom' }, history: { keepCount: 30 } }, null, 2), 'utf8');
    setWallpaperBehavior({ failTimes: 1 }); // 第 1 次(设置新壁纸)失败,回滚里的重设成功
    const r = await env.call('change-wallpaper', 'ai');
    const histFiles = fs.readdirSync(env.wallDir).filter(f => f.startsWith('hist_'));
    ok('I1', 'AI 网络失败时返回 ok:false 且带原始错误', r && r.ok === false && typeof r.error === 'string', JSON.stringify(r).slice(0, 200));
    ok('I2', '失败后 current.jpg 仍在(未被删除)', exists(cur), 'current 存在=' + exists(cur));
    ok('I3', '失败后 current.jpg 内容仍是原图(未落空)', exists(cur) && fs.readFileSync(cur).equals(oldImg), '大小 ' + (exists(cur) ? fs.statSync(cur).size : -1));
    ok('I4', '失败后无 current.tmp.jpg 残留', !exists(path.join(env.wallDir, 'current.tmp.jpg')), '目录: [' + listFiles(env.wallDir).join(', ') + ']');
    ok('I5', '下载阶段失败不应产生 hist 归档(未走到归档)', histFiles.length === 0, 'hist 文件: [' + histFiles.join(', ') + ']');
  }

  // ---------- J. rollbackWallpaper:情况 A 真实触发(归档已发生,后续失败) ----------
  group('J rollback 情况 A 真实触发(setWallpaper 强制失败)');
  {
    const env = await mkEnv();
    env.confFile = path.join(env.userData, 'config', 'config.json');
    const cur = path.join(env.wallDir, 'current.jpg');
    const historyFile = path.join(env.wallDir, 'history.jsonl');
    const oldImg = fakeJpeg(30000, 'old-J');
    fs.writeFileSync(cur, oldImg);
    // 预置一条 history 记录,归档时会回写 histFile
    fs.writeFileSync(historyFile, JSON.stringify({ file: 'current.jpg', time: 't-old', source: 'lolicon', bytes: oldImg.length }) + '\n', 'utf8');
    // 直接驱动 use-history:它同样是"归档 -> 写 current -> setWallpaper -> 失败回滚"的事务
    const srcImg = fakeJpeg(31000, 'src-J');
    fs.writeFileSync(path.join(env.wallDir, 'hist_20260101_000000.jpg'), srcImg);
    setWallpaperBehavior('throw');
    const r = await env.call('use-history', 'hist_20260101_000000.jpg');
    setWallpaperBehavior(undefined);
    const histFiles = fs.readdirSync(env.wallDir).filter(f => f.startsWith('hist_'));
    ok('J1', 'setWallpaper 失败时返回 ok:false', r && r.ok === false, JSON.stringify(r).slice(0, 300));
    ok('J2', '失败后 current.jpg 恢复为调用前内容(情况 A 生效)', exists(cur) && fs.readFileSync(cur).equals(oldImg), 'current 大小 ' + (exists(cur) ? fs.statSync(cur).size : -1) + ' 期望 ' + oldImg.length);
    ok('J3', '回滚保留归档 hist 文件(不删除,避免 histFile 悬空)', histFiles.length === 2, 'hist 文件: [' + histFiles.join(', ') + ']');
    ok('J4', '回滚后无 tmp 残留', !exists(path.join(env.wallDir, 'current.tmp.jpg')));
    ok('J5', '失败结果未伪报成功', r.ok !== true);
    ok('J6', '历史来源文件未被删除/移动(用户数据安全)', exists(path.join(env.wallDir, 'hist_20260101_000000.jpg')) && fs.readFileSync(path.join(env.wallDir, 'hist_20260101_000000.jpg')).equals(srcImg));
  }

  // ---------- K. rollbackWallpaper:情况 B(原本无 current,清理新写入) ----------
  group('K rollback 情况 B(原本无壁纸)');
  {
    const env = await mkEnv();
    env.confFile = path.join(env.userData, 'config', 'config.json');
    const cur = path.join(env.wallDir, 'current.jpg');
    const srcImg = fakeJpeg(25000, 'src-K');
    fs.writeFileSync(path.join(env.wallDir, 'hist_20260101_000100.jpg'), srcImg);
    ok('K0', '前置:调用前 current 不存在', !exists(cur));
    setWallpaperBehavior('throw');
    const r = await env.call('use-history', 'hist_20260101_000100.jpg');
    setWallpaperBehavior(undefined);
    ok('K1', 'setWallpaper 失败返回 ok:false', r && r.ok === false, JSON.stringify(r).slice(0, 300));
    ok('K2', '失败后 current.jpg 被清理(回到操作前"无壁纸"状态)', !exists(cur), 'current 存在=' + exists(cur));
    ok('K3', '来源 hist 文件保持完好', exists(path.join(env.wallDir, 'hist_20260101_000100.jpg')) && fs.readFileSync(path.join(env.wallDir, 'hist_20260101_000100.jpg')).equals(srcImg));
    ok('K4', '无 hist 归档产生(原本无 current 无需归档)', fs.readdirSync(env.wallDir).filter(f => f.startsWith('hist_')).length === 1, '目录: [' + listFiles(env.wallDir).join(', ') + ']');
  }

  // ---------- L. rollbackWallpaper:情况 C(磁盘未变化) ----------
  group('L rollback 情况 C(磁盘未变化)');
  {
    const env = await mkEnv();
    env.confFile = path.join(env.userData, 'config', 'config.json');
    const cur = path.join(env.wallDir, 'current.jpg');
    const oldImg = fakeJpeg(40000, 'old-L');
    fs.writeFileSync(cur, oldImg);
    // 改变 current 的 mtime 便于对比"未被触碰"
    const beforeMtime = fs.statSync(cur).mtimeMs;
    fs.writeFileSync(env.confFile, JSON.stringify({ source: 'ai', services: [{ id: 'sL', kind: 'image', name: 'n', apiBase: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' }], activeImageService: 'sL', ai: { prompt: 'x', size: '512x512', randomMode: 'custom' }, history: { keepCount: 30 } }, null, 2), 'utf8');
    const r = await env.call('change-wallpaper', 'ai');
    const afterMtime = fs.statSync(cur).mtimeMs;
    ok('L1', '下载阶段失败返回 ok:false', r && r.ok === false);
    ok('L2', 'current 内容与 mtime 均未变化(未误删未误写)', fs.readFileSync(cur).equals(oldImg) && beforeMtime === afterMtime,
      'mtime 前 ' + beforeMtime + ' 后 ' + afterMtime);
    ok('L3', '失败结果未把回滚错误混入(无"回滚也出现问题")', !String(r.error).includes('回滚也出现问题'), JSON.stringify(r.error));
    ok('L4', '未调用 setWallpaper 重设未经确认的壁纸', (globalThis.__wallpaperCalls || []).length === 0, 'setWallpaper 调用: ' + JSON.stringify(globalThis.__wallpaperCalls));
  }

  // ---------- M. rollbackWallpaper:情况 B2(有 current 但无归档凭据) ----------
  group('M rollback 情况 B2(归档凭据缺失)');
  {
    const env = await mkEnv();
    env.confFile = path.join(env.userData, 'config', 'config.json');
    const cur = path.join(env.wallDir, 'current.jpg');
    const oldImg = fakeJpeg(20000, 'old-M');
    fs.writeFileSync(cur, oldImg);
    const srcImg = fakeJpeg(21000, 'src-M');
    fs.writeFileSync(path.join(env.wallDir, 'hist_20260101_000200.jpg'), srcImg);
    // 竞态注入:事务快照(hadCurrent=true)之后、归档之前,current 被外部删除。
    // 这样 archiveCurrent() 返回 null -> 无归档凭据,新图仍会被 rename 成 current -> 落入 B2。
    let injected = false;
    setReadFileHook(async (p) => {
      if (!injected && p === path.join(env.wallDir, 'hist_20260101_000200.jpg')) {
        injected = true;
        try { fs.unlinkSync(cur); } catch {}
      }
    });
    setWallpaperBehavior('throw');
    const r = await env.call('use-history', 'hist_20260101_000200.jpg');
    setWallpaperBehavior(undefined);
    setReadFileHook(null);
    ok('M0', '前置:竞态注入确实生效(current 在归档前被删)', injected === true);
    ok('M1', 'setWallpaper 失败返回 ok:false', r && r.ok === false, JSON.stringify(r).slice(0, 400));
    ok('M2', '错误信息包含"原壁纸归档凭据缺失，无法安全恢复"', String(r.error).includes('原壁纸归档凭据缺失，无法安全恢复'), JSON.stringify(r.error));
    ok('M3', '错误同时包含原始错误(未被回滚信息覆盖)', String(r.error).includes('mock setWallpaper'), JSON.stringify(r.error));
    ok('M4', 'current.jpg 未被擅自删除(用户目录文件不擅自删)', exists(cur), 'current 存在=' + exists(cur) + ' 大小 ' + (exists(cur) ? fs.statSync(cur).size : -1));
    ok('M5', 'B2 未重设系统壁纸(磁盘状态未知,禁止 setWallpaper)', (globalThis.__wallpaperCalls || []).length === 0, '成功调用: ' + JSON.stringify(globalThis.__wallpaperCalls) + ' 尝试次数: ' + globalThis.__wallpaperAttempts);
    ok('M6', '来源 hist 文件完好', exists(path.join(env.wallDir, 'hist_20260101_000200.jpg')));
  }

  const s = summarize();
  console.log('\n---- 第三部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title).join(' | '));
  closeAllWatchers();
  await sleep(100);
  cleanupTmp();
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); closeAllWatchers(); cleanupTmp(); process.exit(2); });
