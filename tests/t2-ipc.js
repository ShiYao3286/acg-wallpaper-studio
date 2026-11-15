// 第二部分:真实 main.js 加载 + IPC 参数校验 + 配置/回执 BOM —— 全部【直接测试生产代码】
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, mkTmp, cleanupTmp, listFiles, sleep, summarize } = require('./common');
const { loadMain, waitBoot, closeAllWatchers } = require('./harness');

const REPO = path.resolve(__dirname, '..');
const ESC = '\uFEFF';

// 构建一个真实启动的测试环境:
//   - 真实 main.js,whenReady 正常执行(窗口/托盘/定时器/文件监听都走生产路径)
//   - 独立的临时 userData / Pictures 目录,不触碰真实用户数据
async function mkEnv() {
  const root = mkTmp('acg-ipc-');
  const userData = path.join(root, 'userData');
  const pictures = path.join(root, 'Pictures');
  const wallDir = path.join(pictures, 'ACG_Wallpaper');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(wallDir, { recursive: true });
  const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
  await waitBoot(loaded.state, 5000);
  return { root, userData, pictures, wallDir, confDir: path.join(userData, 'config'), confFile: path.join(userData, 'config', 'config.json'), ...loaded };
}
const envCall = (env) => async (channel, ...args) => {
  const fn = env.state.ipcHandlers.get(channel);
  if (!fn) throw new Error('通道未注册: ' + channel);
  return await fn({}, ...args);
};
const isArgFail = (r) => r && r.ok === false && r.code === 'E_INVALID_ARG' && typeof r.error === 'string' && r.error.startsWith('参数无效: ');

(async () => {
  // ---------- D. 加载真实 main.js,30 通道注册 ----------
  group('D 真实 main.js 加载与通道注册');
  const envMain = await mkEnv();
  const call = envCall(envMain);
  {
    const chans = [...envMain.state.ipcHandlers.keys()].sort();
    // 不写死数量:通道会随阶段增长(阶段2 新增 list-plugins / set-plugin-enabled)。
  // 真正要保障的是"注册了通道"以及"与 preload 双向齐平"(见 D3),数量本身不是契约。
  ok('D1', '真实 main.js 可加载且注册了 IPC 通道', chans.length > 0, '实际 ' + chans.length + ' 个: ' + chans.join(','));
    const expect = ['get-config', 'save-config', 'change-wallpaper', 'list-history', 'use-history', 'get-status',
      'get-autorun', 'set-autorun', 'open-wallpaper-dir', 'add-tag', 'remove-tag', 'disable-old-task', 'list-services',
      'save-service', 'delete-service', 'set-active-service', 'test-service', 'fetch-models', 'ai-assist-prompt',
      'save-preset', 'delete-preset', 'favorite-current', 'list-favorites', 'delete-favorite', 'read-meta',
      'detect-proxy', 'roll-random-prompt', 'query-old-task', 'win-minimize', 'win-close'];
    const missing = expect.filter(c => !chans.includes(c));
    ok('D2', '审计列出的 30 个通道全部在 main.js 注册', missing.length === 0, missing.length ? '缺失: ' + missing.join(',') : '全齐');
    const preloadSrc = fs.readFileSync(path.join(REPO, 'src/main/preload.js'), 'utf8');
    const preloadChans = [...preloadSrc.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]);
    const preloadMissing = preloadChans.filter(c => !chans.includes(c));
    ok('D3', 'preload 每个 invoke 通道都有主进程 handler(双向齐平)',
      preloadMissing.length === 0 && preloadChans.length > 0,
      'preload ' + preloadChans.length + ' 个, 缺失 ' + preloadMissing.length + ' 个');
    const extra = chans.filter(c => !preloadChans.includes(c));
    ok('D4', '主进程无 preload 之外的孤儿通道', extra.length === 0, extra.length ? '孤儿: ' + extra.join(',') : '无孤儿');
  }

  // ---------- E. IPC 参数校验:非法入参一律拦截 ----------
  group('E IPC 参数校验拦截');
  {
    const r1 = await call('change-wallpaper', 'hack-the-planet');
    ok('E1', 'change-wallpaper 非法 reason 被拦截', isArgFail(r1), JSON.stringify(r1));
    const r2 = await call('change-wallpaper', 123);
    ok('E2', 'change-wallpaper 非字符串 reason 被拦截', isArgFail(r2), JSON.stringify(r2));
    const r3 = await call('use-history', '');
    ok('E3', 'use-history 空文件名被拦截', isArgFail(r3), JSON.stringify(r3));
    const r4 = await call('use-history', { evil: 1 });
    ok('E4', 'use-history 非字符串文件名被拦截', isArgFail(r4), JSON.stringify(r4));
    const r4b = await call('use-history', '..\\..\\Windows\\System32\\drivers\\etc\\hosts');
    ok('E4b', 'use-history 路径穿越尝试不会读到目录外文件', r4b && r4b.ok === false && /文件不存在/.test(String(r4b.error)), JSON.stringify(r4b));

    const badSvc = { id: 's1', kind: 'image', name: 'x', apiBase: 'file:///C:/Windows', apiKey: 'k', model: 'm' };
    const r5 = await call('save-service', badSvc);
    ok('E5', 'save-service file: 协议被拦截', isArgFail(r5), JSON.stringify(r5));
    const r6 = await call('fetch-models', badSvc);
    ok('E6', 'fetch-models file: 协议被拦截', isArgFail(r6), JSON.stringify(r6));
    const r7 = await call('test-service', badSvc);
    ok('E7', 'test-service file: 协议被拦截', isArgFail(r7), JSON.stringify(r7));
    const r8 = await call('save-service', { ...badSvc, kind: 'video', apiBase: 'http://127.0.0.1:8326/v1' });
    ok('E8', 'save-service 坏 kind 被拦截', isArgFail(r8), JSON.stringify(r8));
    const r9 = await call('delete-service', '');
    ok('E9', 'delete-service 空 id 被拦截', isArgFail(r9), JSON.stringify(r9));
    const r10 = await call('set-active-service', 'video', 'x');
    ok('E10', 'set-active-service 坏 kind 被拦截', isArgFail(r10), JSON.stringify(r10));
    const r11 = await call('save-preset', { id: 'p', name: 'n', prompt: '' });
    ok('E11', 'save-preset 空 prompt 被拦截', isArgFail(r11), JSON.stringify(r11));
    const r12 = await call('delete-preset', '');
    ok('E12', 'delete-preset 空 id 被拦截', isArgFail(r12), JSON.stringify(r12));
    const r13 = await call('read-meta', '');
    ok('E13', 'read-meta 空文件名被拦截', isArgFail(r13), JSON.stringify(r13));
    ok('E14', '被拦截的服务未落盘到 config.json',
      !fs.existsSync(envMain.confFile) || !fs.readFileSync(envMain.confFile, 'utf8').includes('file:///C:/Windows'));
    const t0 = Date.now();
    await call('fetch-models', badSvc);
    ok('E15', 'fetch-models 拦截发生在出网之前(耗时 < 300ms)', Date.now() - t0 < 300, (Date.now() - t0) + 'ms');
  }

  // ---------- F. 合法调用不被误拦 ----------
  group('F 合法调用不被误拦');
  {
    const goodSvc = { id: 'svc-local', kind: 'image', name: '本地网关', apiBase: 'http://127.0.0.1:8326/v1', apiKey: 'sk-local-test', model: 'anime-xl' };
    const r1 = await call('save-service', goodSvc);
    ok('F1', 'save-service 合法服务保存成功', r1 && r1.ok === true, JSON.stringify(r1));
    ok('F2', 'config.json 已落盘且可解析', (() => {
      try { const j = JSON.parse(fs.readFileSync(envMain.confFile, 'utf8')); return j.services.some(s => s.id === 'svc-local' && s.apiBase === 'http://127.0.0.1:8326/v1'); } catch { return false; }
    })());
    ok('F3', '原子写后无 config.json.tmp 残留', !fs.existsSync(envMain.confFile + '.tmp'), '配置目录内容: [' + listFiles(envMain.confDir).join(', ') + ']');
    ok('F4', 'http://127.0.0.1:8326/v1 未被白名单误拦(本地 http 放行)', (() => {
      const j = JSON.parse(fs.readFileSync(envMain.confFile, 'utf8'));
      const s = j.services.find(x => x.id === 'svc-local');
      return s && s.apiBase === 'http://127.0.0.1:8326/v1';
    })());
    const r5 = await call('set-active-service', 'image', 'svc-local');
    ok('F5', 'set-active-service 合法 id 通过', r5 && r5.ok === true, JSON.stringify(r5));
    const r6 = await call('set-active-service', 'image', '');
    ok('F6', 'set-active-service 空 id 放行(取消选中语义保留)', r6 && r6.ok === true, JSON.stringify(r6));
    const r7 = await call('save-preset', { id: 'preset-x', name: '测试', prompt: '1girl, solo' });
    ok('F7', 'save-preset 合法预设通过', r7 && r7.ok === true, JSON.stringify(r7));
    const r8 = await call('list-services');
    ok('F8', 'list-services 返回已保存服务', Array.isArray(r8) && r8.some(s => s.id === 'svc-local'), JSON.stringify(r8 && r8.map(s => s.id)));
    const r9 = await call('delete-preset', 'preset-x');
    ok('F9', 'delete-preset 合法 id 通过', r9 && r9.ok === true, JSON.stringify(r9));
    const r10 = await call('delete-service', 'svc-local');
    ok('F10', 'delete-service 合法 id 通过', r10 && r10.ok === true, JSON.stringify(r10));
    const r11 = await call('fetch-models', { ...goodSvc, apiBase: 'http://127.0.0.1:1/v1' });
    ok('F11', 'fetch-models 校验通过后失败原因来自网络层(非"参数无效")',
      r11 && r11.ok === false && !String(r11.error).startsWith('参数无效'), JSON.stringify(r11).slice(0, 200));
  }

  // ---------- G. BOM 端到端 ----------
  group('G BOM 端到端(真实 main.js)');
  {
    const env = await mkEnv();
    const c = envCall(env);
    fs.mkdirSync(env.confDir, { recursive: true });
    const cfgObj = { services: [{ id: 'bom-svc', kind: 'image', name: '带BOM的配置', apiBase: 'http://127.0.0.1:8326/v1', apiKey: 'k', model: 'm' }], activeImageService: 'bom-svc', history: { keepCount: 7 } };
    fs.writeFileSync(env.confFile, ESC + JSON.stringify(cfgObj, null, 2), 'utf8');
    const bytes = fs.readFileSync(env.confFile);
    ok('G1', '测试素材确实以 EF BB BF 开头', bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, bytes.slice(0, 3).toString('hex'));
    ok('G2', '对照:裸 JSON.parse 同一文件必抛 SyntaxError', (() => { try { JSON.parse(fs.readFileSync(env.confFile, 'utf8')); return false; } catch (e) { return e.name === 'SyntaxError'; } })());
    const cfg = await c('get-config');
    ok('G3', 'get-config 正确读出带 BOM 的配置(未回落默认值)', cfg.activeImageService === 'bom-svc' && cfg.history.keepCount === 7, 'activeImageService=' + cfg.activeImageService + ' keepCount=' + cfg.history.keepCount);

    const receipt = { time: '2026-11-10 10:24:12', source: 'script', tag: '蔚蓝档案', title: '旧脚本回执', file: 'current.jpg', bytes: 729087 };
    fs.writeFileSync(path.join(env.wallDir, 'wallpaper_meta.json'), ESC + JSON.stringify(receipt, null, 2), 'utf8');
    const st = await c('get-status');
    ok('G4', 'get-status 的 scriptMeta 不为 null(带 BOM 回执可读)', st.scriptMeta !== null && st.scriptMeta !== undefined, JSON.stringify(st.scriptMeta));
    ok('G5', 'scriptMeta 内容与旧脚本回执一致', !!st.scriptMeta && st.scriptMeta.source === 'script' && st.scriptMeta.tag === '蔚蓝档案' && st.scriptMeta.bytes === 729087, JSON.stringify(st.scriptMeta));
    fs.writeFileSync(path.join(env.wallDir, 'wallpaper_meta.json'), JSON.stringify({ time: 't2', source: 'app' }), 'utf8');
    const st2 = await c('get-status');
    ok('G6', '无 BOM 回执同样可读', !!st2.scriptMeta && st2.scriptMeta.source === 'app', JSON.stringify(st2.scriptMeta));

    fs.writeFileSync(path.join(env.wallDir, 'history.jsonl'), ESC + JSON.stringify({ file: 'hist_bom.jpg', source: 'script', bytes: 1 }) + '\n', 'utf8');
    const m = await c('read-meta', 'hist_bom.jpg');
    ok('G7', 'read-meta 可命中带 BOM 的首行记录', !!m && m.file === 'hist_bom.jpg' && m.source === 'script', JSON.stringify(m));
    const mNull = await c('read-meta', 'hist_not_exist.jpg');
    ok('G8', 'read-meta 对不存在文件名返回 null(不误命中)', mNull === null, JSON.stringify(mNull));
    await sleep(50);
  }

  const s = summarize();
  console.log('\n---- 第二部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id).join(', '));
  closeAllWatchers();
  await sleep(100);
  cleanupTmp();
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); cleanupTmp(); process.exit(2); });
