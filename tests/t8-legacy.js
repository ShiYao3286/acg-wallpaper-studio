// 第八部分:真实旧脚本(PS 5.1)产物驱动 —— 【直接测试生产代码】+ 真实外部工具产物
//   用 Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 真实生成带 BOM 文件,
//   再用真实 main.js 读取,完全复现"旧脚本单独换图"这一主用例。不联网、不改用户数据。
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { group, ok, mkTmp, cleanupTmp, fakeJpeg, sleep, listFiles, summarize } = require('./common');
const { loadMain, waitBoot, setWallpaperBehavior, closeAllWatchers } = require('./harness');

const ESC = '\uFEFF';
const PS = 'powershell.exe';

function runPs(script) {
  return execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
}

async function mkEnv() {
  const root = mkTmp('acg-legacy-');
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
  return { root, userData, pictures, wallDir, confDir, win, ...loaded, call };
}

(async () => {
  group('AF 真实 PowerShell 5.1 旧脚本产物');
  let ps53 = true;
  try { runPs('$PSVersionTable.PSVersion.Major'); } catch { ps53 = false; }
  ok('AF0', '本机可用 Windows PowerShell 生成真实旧脚本产物', ps53);
  if (!ps53) { const s0 = summarize(); console.log('跳过 AF 组'); process.exit(0); }

  const env = await mkEnv();
  const wall = env.wallDir;
  const img = fakeJpeg(24000, 'legacy');
  fs.writeFileSync(path.join(wall, 'current.jpg'), img);

  // 完整复刻旧脚本第 5 步:ordered 哈希 + ConvertTo-Json + Set-Content -Encoding UTF8
  const metaPath = path.join(wall, 'wallpaper_meta.json');
  const psMeta = `
$meta = [ordered]@{
    time   = '2026-11-10 10:24:12'
    source = 'script'
    tag    = '蔚蓝档案'
    title  = 'Kisaki'
    author = 'Love Aru'
    pid    = 110231852
    file   = 'current.jpg'
    bytes  = ${img.length}
}
$meta | ConvertTo-Json | Set-Content -Path '${metaPath.replace(/'/g, "''")}' -Encoding UTF8
Write-Output "written"
`;
  const psOut = runPs(psMeta);
  ok('AF1', 'PowerShell 5.1 成功写出回执', /written/.test(psOut), psOut.trim());
  const bytes = fs.readFileSync(metaPath);
  ok('AF2', '真实 PS 5.1 产物确实带 UTF-8 BOM(EF BB BF)', bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, bytes.slice(0, 3).toString('hex'));
  ok('AF3', '对照:裸 JSON.parse 该真实产物抛 SyntaxError(BOM 缺陷可复现)', (() => {
    try { JSON.parse(fs.readFileSync(metaPath, 'utf8')); return false; } catch (e) { return e.name === 'SyntaxError'; }
  })());
  const st = await env.call('get-status');
  ok('AF4', 'get-status 正确读出真实旧脚本回执(修复生效)', !!st.scriptMeta && st.scriptMeta.source === 'script' && st.scriptMeta.pid === 110231852,
    JSON.stringify(st.scriptMeta));
  ok('AF5', '回执字段完整(时间/来源/tag/title/author/pid/file/bytes)',
    !!st.scriptMeta && ['time', 'source', 'tag', 'title', 'author', 'pid', 'file', 'bytes'].every(k => k in st.scriptMeta),
    Object.keys(st.scriptMeta || {}).join(','));

  // 真实 PS 5.1 写出的 history.jsonl(首行带 BOM),模拟旧脚本代际数据
  const histPath = path.join(wall, 'history.jsonl');
  const psHist = `
$rows = @(
  '{"file":"hist_20261110_102412.jpg","time":"2026-11-10T02:24:12Z","source":"script","title":"旧脚本图","bytes":24000}',
  '{"file":"current.jpg","time":"2026-11-10T02:30:00Z","source":"script","title":"另一张","bytes":25000}'
)
$rows | Set-Content -Path '${histPath.replace(/'/g, "''")}' -Encoding UTF8
Write-Output "ok"
`;
  runPs(psHist);
  const hb = fs.readFileSync(histPath);
  ok('AF6', 'PS 5.1 写出的 history.jsonl 首行带 BOM', hb[0] === 0xEF && hb[1] === 0xBB && hb[2] === 0xBF, hb.slice(0, 3).toString('hex'));
  const m1 = await env.call('read-meta', 'hist_20261110_102412.jpg');
  ok('AF7', 'read-meta 能命中 PS 5.1 写出的首行(带 BOM)记录', !!m1 && m1.title === '旧脚本图', JSON.stringify(m1));
  const m2 = await env.call('read-meta', 'current.jpg');
  ok('AF8', 'read-meta 能命中带 BOM 文件的第二行记录', !!m2 && m2.title === '另一张', JSON.stringify(m2));

  // 旧脚本产生的 hist 文件可被软件应用(用户切回旧图)
  setWallpaperBehavior(undefined);
  const legacyHist = path.join(wall, 'hist_20261110_102412.jpg');
  fs.writeFileSync(legacyHist, fakeJpeg(24000, 'legacy-old'));
  const rUse = await env.call('use-history', 'hist_20261110_102412.jpg');
  ok('AF9', '软件可应用旧脚本产生的 hist 图', rUse && rUse.ok === true, JSON.stringify(rUse));
  ok('AF10', '应用旧脚本 hist 后该文件仍存在(不删用户数据)', fs.existsSync(legacyHist));
  const afterUse = await env.call('read-meta', 'hist_20261110_102412.jpg');
  ok('AF11', '应用后 read-meta 仍可命中旧格式记录', !!afterUse && afterUse.title === '旧脚本图', JSON.stringify(afterUse));

  // 旧脚本"单独换图"(外部写入)后,软件应能感知
  await sleep(5300); // 越过 SELF_WRITE_WINDOW=5s,确保判为 external
  env.win.sentMessages.length = 0;
  const meta2 = `
$meta = [ordered]@{ time = '2026-11-10 11:00:00'; source = 'script'; tag = '东方'; title = '外部换图'; author = 'x'; pid = 1; file = 'current.jpg'; bytes = ${img.length} }
$meta | ConvertTo-Json | Set-Content -Path '${metaPath.replace(/'/g, "''")}' -Encoding UTF8
`;
  runPs(meta2);
  await sleep(1200);
  const reasons = env.win.sentMessages.filter(m => m.channel === 'ui-refresh').map(m => m.payload);
  ok('AF12', '旧脚本单独换图触发 ui-refresh 且被判为 external', reasons.length > 0 && reasons.every(x => x === 'external'), JSON.stringify(reasons));
  const st2 = await env.call('get-status');
  ok('AF13', '旧脚本单独换图后 get-status 读到新回执(带 BOM)', !!st2.scriptMeta && st2.scriptMeta.title === '外部换图', JSON.stringify(st2.scriptMeta));

  // 首字节/编码协议未被破坏:软件自身写回执应为无 BOM UTF-8
  const beforeSelf = fs.readFileSync(metaPath);
  await env.call('use-history', 'current.jpg'); // 捷径路径不写回执,改用切换
  fs.writeFileSync(path.join(wall, 'hist_src_self.jpg'), fakeJpeg(25000, 'self-write'));
  await env.call('use-history', 'hist_src_self.jpg');
  const selfBytes = fs.readFileSync(metaPath);
  ok('AF14', '软件自身写出的回执仍为 UTF-8 无 BOM(与旧脚本可共存)',
    !(selfBytes[0] === 0xEF && selfBytes[1] === 0xBB && selfBytes[2] === 0xBF), selfBytes.slice(0, 3).toString('hex'));
  const selfMeta = (() => { try { return JSON.parse(fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } })();
  ok('AF15', '软件自身回执 source 为 app(与旧脚本 script 区分)', !!selfMeta && selfMeta.source === 'app', JSON.stringify(selfMeta));

  const s = summarize();
  console.log('\n---- 第八部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  closeAllWatchers();
  await sleep(120);
  cleanupTmp();
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); closeAllWatchers(); cleanupTmp(); process.exit(2); });
