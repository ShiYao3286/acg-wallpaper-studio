// 第十六部分:只读通道失败可观测性(阶段 2 第 5 步)
//   背景:旧实现 catch { return [] } 使"磁盘读不了"与"本来就没数据"在渲染层同形。
//   本步不改返回形状(避免破坏 17 处调用与 42 处断言),而是把失败原因经 get-status.readErrors 暴露。
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, mkTmp, cleanupTmp, summarize } = require('./common');
const { loadMain, waitBoot, closeAllWatchers } = require('./harness');

const ROOT = path.resolve(__dirname, '..');

async function mkEnv() {
  const root = mkTmp('acg-ro-');
  const userData = path.join(root, 'userData');
  const pictures = path.join(root, 'Pictures');
  const wallDir = path.join(pictures, 'ACG_Wallpaper');
  fs.mkdirSync(path.join(userData, 'config'), { recursive: true });
  fs.mkdirSync(wallDir, { recursive: true });
  const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
  await waitBoot(loaded.state, 5000);
  const call = async (ch, ...a) => { const fn = loaded.state.ipcHandlers.get(ch); if (!fn) throw new Error('通道未注册 ' + ch); return await fn({}, ...a); };
  return { root, userData, pictures, wallDir, call, loaded };
}

(async () => {
  group('A 正常情况不产生错误记录');
  {
    const env = await mkEnv();
    const st0 = await env.call('get-status');
    ok('A1', '空目录首次 list-history 不算错误', (await env.call('list-history')).length === 0 && Object.keys(st0.readErrors).length === 0,
      'readErrors=' + JSON.stringify(st0.readErrors));
    fs.writeFileSync(path.join(env.wallDir, 'hist_20260101_000000.jpg'), Buffer.from([0xFF,0xD8,0xFF,0xD9]));
    const files = await env.call('list-history');
    const st1 = await env.call('get-status');
    ok('A2', '正常读取后 readErrors 为空', files.length === 1 && Object.keys(st1.readErrors).length === 0, JSON.stringify(st1.readErrors));
    closeAllWatchers();
  }

  group('B 失败可观测');
  {
    const env = await mkEnv();
    // 用"壁纸目录被一个同名文件占据"制造 readdir 失败(ENOTDIR),这在真实环境也会发生
    fs.rmSync(env.wallDir, { recursive: true, force: true });
    fs.writeFileSync(env.wallDir, 'not a dir');
    const list = await env.call('list-history');
    const st = await env.call('get-status');
    ok('B1', 'list-history 读取失败仍返回空数组(保持向后兼容)', Array.isArray(list) && list.length === 0);
    ok('B2', '失败原因记录在 readErrors 中,不再静默吞掉',
      !!st.readErrors['list-history'] && st.readErrors['list-history'].length > 0,
      'readErrors=' + JSON.stringify(st.readErrors));
    ok('B3', '失败信息是可读字符串,可直接展示给用户',
      typeof st.readErrors['list-history'] === 'string');
    closeAllWatchers();
  }

  group('C renderer 区分空数据与读取失败');
  {
    const js = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');
    ok('C1', 'renderer 有 emptyTipOrError 辅助函数', js.indexOf('async function emptyTipOrError') >= 0);
    ok('C2', 'loadHistory 走 emptyTipOrError', /loadHistory[\s\S]{0,400}emptyTipOrError\(box, 'list-history'/.test(js));
    ok('C3', 'loadFavorites 走 emptyTipOrError', /loadFavorites[\s\S]{0,400}emptyTipOrError\(box, 'list-favorites'/.test(js));
    ok('C4', '失败提示明确区分"不是没有数据"', js.indexOf('不是"没有数据"') >= 0);
  }

  group('D get-status 契约');
  {
    const env = await mkEnv();
    const st = await env.call('get-status');
    ok('D1', 'get-status 恒返回 readErrors 对象', st.readErrors && typeof st.readErrors === 'object' && !Array.isArray(st.readErrors));
    ok('D2', '无错误时 readErrors 为空对象', Object.keys(st.readErrors).length === 0);
    ok('D3', '原有字段未受影响', typeof st.sourceLabel === 'string' && 'lastInfo' in st && 'imageModels' in st);
    closeAllWatchers();
  }

  cleanupTmp();
  const s = summarize();
  console.log('');
  console.log('---- 第十六部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败' + (s.skipped ? ', ' + s.skipped + ' 跳过' : '') + ' ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); cleanupTmp(); process.exit(2); });