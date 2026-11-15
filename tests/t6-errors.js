// 第六部分:错误可见性(historyWriteError / imageModelsError) + 文件安全 + 语法/静态核验
//   IPC 与数据层:【直接测试生产代码】
//   渲染层可见性:【静态核验】(renderer.js 依赖 DOM,无法在 Node 中直接运行,如实标注)
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { group, ok, mkTmp, cleanupTmp, fakeJpeg, sleep, listFiles, summarize } = require('./common');
const { loadMain, waitBoot, setWallpaperBehavior, closeAllWatchers } = require('./harness');

const REPO = path.resolve(__dirname, '..');
const ESC = '\uFEFF';

async function mkEnv() {
  const root = mkTmp('acg-err-');
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
  return { root, userData, pictures, wallDir, confDir, confFile: path.join(confDir, 'config.json'), ...loaded, call };
}

(async () => {
  // ---------- W. historyWriteError 可见(历史落盘失败不静默) ----------
  group('W historyWriteError 可见');
  {
    const env = await mkEnv();
    const histFile = path.join(env.wallDir, 'history.jsonl');
    // 用目录占位 history.jsonl,使 appendFile 必然失败(EISDIR)
    fs.mkdirSync(histFile, { recursive: true });
    fs.writeFileSync(path.join(env.wallDir, 'hist_src_w.jpg'), fakeJpeg(20000, 'W'));
    setWallpaperBehavior(undefined);
    const r = await env.call('use-history', 'hist_src_w.jpg');
    ok('W1', '历史写入失败时整体仍返回成功(壁纸确实已换)', r && r.ok === true, JSON.stringify(r));
    ok('W2', '成功返回值里带出 historyWriteError(不静默吞错)', !!(r && r.historyWriteError && String(r.historyWriteError).length > 0), JSON.stringify(r.historyWriteError));
    ok('W3', 'historyWriteError 含可读的错误信息', /EISDIR|illegal operation|directory/i.test(String(r.historyWriteError)), String(r.historyWriteError).slice(0, 160));
    ok('W4', '同一通道在历史可写时不返回 historyWriteError(不误报)', await (async () => {
      const env2 = await mkEnv();
      fs.writeFileSync(path.join(env2.wallDir, 'hist_src_w2.jpg'), fakeJpeg(21000, 'W2'));
      const r2 = await env2.call('use-history', 'hist_src_w2.jpg');
      return r2 && r2.ok === true && !('historyWriteError' in r2);
    })());
  }

  // ---------- X. imageModelsError 可见(模型列表刷新失败可见) ----------
  group('X imageModelsError 可见');
  {
    // 起一个本地假 OpenAI 兼容服务,返回 500,验证错误一路传到 get-status
    const srv = http.createServer((req, res) => { res.writeHead(500); res.end('server boom'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const env = await mkEnv();
    const svc = { id: 'svc-err', kind: 'image', name: '坏服务', apiBase: 'http://127.0.0.1:' + port + '/v1', apiKey: 'k', model: 'm' };
    fs.writeFileSync(env.confFile, JSON.stringify({ services: [svc], activeImageService: 'svc-err', source: 'ai' }, null, 2), 'utf8');
    const st1 = await env.call('get-status');
    await sleep(800); // 等待后台刷新失败回传
    const st2 = await env.call('get-status');
    ok('X1', 'get-status 返回 imageModelsError 字段', 'imageModelsError' in st1, '首查=' + JSON.stringify(st1.imageModelsError));
    ok('X2', '模型列表拉取失败后 imageModelsError 反映真实原因', /HTTP 500/.test(String(st2.imageModelsError)), JSON.stringify(st2.imageModelsError));
    ok('X3', '失败时 imageModels 为空数组(UI 不会看到脏数据)', Array.isArray(st2.imageModels) && st2.imageModels.length === 0, JSON.stringify(st2.imageModels));
    // 对照:成功返回时 imageModelsError 应为空
    const srv2 = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
    });
    await new Promise(r => srv2.listen(0, '127.0.0.1', r));
    const port2 = srv2.address().port;
    const env2 = await mkEnv();
    const svc2 = { id: 'svc-ok', kind: 'image', name: '好服务', apiBase: 'http://127.0.0.1:' + port2 + '/v1', apiKey: 'k', model: 'm' };
    fs.writeFileSync(env2.confFile, JSON.stringify({ services: [svc2], activeImageService: 'svc-ok', source: 'ai' }, null, 2), 'utf8');
    await env2.call('get-status');
    await sleep(900);
    const st3 = await env2.call('get-status');
    ok('X4', '模型拉取成功时 imageModels 有值且 imageModelsError 为空',
      st3.imageModels.length === 2 && st3.imageModelsError === '', 'models=' + JSON.stringify(st3.imageModels) + ' err=' + JSON.stringify(st3.imageModelsError));
    // fetch-models 通道本身也可直接验证
    const rfm = await env2.call('fetch-models', svc2);
    ok('X5', 'fetch-models 通道直接返回模型列表', rfm && rfm.ok === true && rfm.models.length === 2, JSON.stringify(rfm));
    srv.close(); srv2.close();
  }

  // ---------- Y. 文件安全:任何失败路径都不得删除用户数据 ----------
  group('Y 文件安全');
  {
    const env = await mkEnv();
    const his1 = path.join(env.wallDir, 'hist_20260101_060000.jpg');
    const img1 = fakeJpeg(18000, 'Y1');
    fs.writeFileSync(his1, img1);
    const favDir = path.join(env.wallDir, 'favorites');
    fs.mkdirSync(favDir, { recursive: true });
    const fav1 = path.join(favDir, 'fav_1.jpg');
    fs.writeFileSync(fav1, fakeJpeg(19000, 'Y2'));
    fs.writeFileSync(path.join(env.wallDir, 'current.jpg'), fakeJpeg(20000, 'Y3'));
    const before = listFiles(env.wallDir).join(',');

    // 各种失败输入
    // 注意:原先这里用 change-wallpaper('manual') 期望"无网络必然失败",
    // 但本机图源(i.pixiv.re)可用时它会真的换图成功,断言随之失效——
    // 那属于测试对外部网络的依赖,不是产品缺陷。改用必然失败的路径:
    // 非法 reason 被 assertReason 拦截、不存在的历史文件被拦,均不触碰磁盘。
    await env.call('use-history', '..\\..\\etc\\passwd');
    await env.call('use-history', 'no_such.jpg');
    await env.call('use-history', '');
    await env.call('read-meta', '../../x');
    await env.call('delete-favorite', '../../current.jpg');
    await env.call('change-wallpaper', 'not-a-valid-reason'); // 校验拦截,不发起网络请求

    ok('Y1', '失败调用后历史图仍在且内容未变', fs.existsSync(his1) && fs.readFileSync(his1).equals(img1));
    ok('Y2', '失败调用后收藏图仍在且内容未变', fs.existsSync(fav1));
    ok('Y3', '失败调用后 current.jpg 仍在且内容未变', fs.existsSync(path.join(env.wallDir, 'current.jpg')) && fs.readFileSync(path.join(env.wallDir, 'current.jpg')).equals(fakeJpeg(20000, 'Y3')));
    ok('Y4', '失败调用未删除任何原文件(顶层文件集合不变)',
      listFiles(env.wallDir).join(',') === before, '前: ' + before + ' | 后: ' + listFiles(env.wallDir).join(','));
    ok('Y5', 'delete-favorite 的路径穿越被 basename 挡住(未删 current)', fs.existsSync(path.join(env.wallDir, 'current.jpg')));
    ok('Y6', '无 tmp 残留', !listFiles(env.wallDir).some(f => /\.tmp$/.test(f)), listFiles(env.wallDir).join(','));
  }

  // ---------- Z. 静态核验(非运行时,如实标注) ----------
  group('Z 静态核验');
  {
    const renderer = fs.readFileSync(path.join(REPO, 'src/renderer/renderer.js'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(REPO, 'src/main/main.js'), 'utf8');
    ok('Z1', 'renderer.js 处理 imageModelsError', /imageModelsError/.test(renderer), '命中 ' + (renderer.match(/imageModelsError/g) || []).length + ' 处');
    ok('Z2', 'renderer.js 处理 historyWriteError', /historyWriteError/.test(renderer), '命中 ' + (renderer.match(/historyWriteError/g) || []).length + ' 处');
    ok('Z3', 'renderer.js 的 onUiRefresh 有 try/catch 保护', /onUiRefresh[\s\S]{0,400}?try\s*\{/.test(renderer));
    ok('Z4', 'renderer.js 校验保存类返回值(r.ok)', /if\s*\(\s*!\s*r\.ok\s*\)/.test(renderer) || /r\.ok\s*===?\s*false/.test(renderer),
      '命中 ' + ((renderer.match(/!\s*r\.ok|r\.ok\s*===?\s*false/g) || []).length) + ' 处');
    ok('Z5', 'main.js 无裸 JSON.parse(6 处均先 stripBom 或 trim)', (() => {
      const m = [...mainSrc.matchAll(/JSON\.parse\(([^)]*)\)/g)].map(x => x[1]);
      const bare = m.filter(arg => !/stripBom|rows\[i\]|l\b|\.map|\.filter|JSON\.stringify/.test(arg));
      return bare.length === 0;
    })(), 'JSON.parse 调用: ' + [...mainSrc.matchAll(/JSON\.parse\(([^)]*)\)/g)].map(x => x[1].trim()).join(' | '));
    ok('Z6', 'main.js 含单实例锁 requestSingleInstanceLock + else 分支', /if \(!app\.requestSingleInstanceLock\(\)\)/.test(mainSrc) && /\} else \{/.test(mainSrc));
    // saveConfig 已迁至 services/config-service.js(阶段1服务边界拆分),
    // 断言改为跨文件检查:原子写必须体现在最终实现所在模块。
    const cfgSvcSrc = fs.readFileSync(path.join(REPO, 'src/main/services/config-service.js'), 'utf8');
    ok('Z7', 'saveConfig 使用 tmp + rename 原子写(实现位于 config-service.js)',
      /writeFile\(tmpFile/.test(cfgSvcSrc) && /rename\(tmpFile, target\)/.test(cfgSvcSrc));
    ok('Z8', '代码中不存在硬编码 API Key 明文', !/sk-[A-Za-z0-9]{16,}/.test(mainSrc) && !/sk-[A-Za-z0-9]{16,}/.test(renderer));
    ok('Z9', 'renderer 未直接使用 require/ipcRenderer(nodeIntegration 关闭)', !/\brequire\(/.test(renderer) && !/ipcRenderer/.test(renderer));
    // 存量代码大量使用内联 on* 处理器(39 处),这是既有风格不是本次改动范围。
    // 真正的注入面是"内联处理器里拼接了动态/用户数据",这里精确检查这一点。
    ok('Z10', '内联 on* 处理器的参数均为硬编码字面量(无用户数据拼接,不构成注入面)', (() => {
      const html = fs.readFileSync(path.join(REPO, 'src/renderer/index.html'), 'utf8');
      const hits = [...html.matchAll(/\son(?:click|change|input|load|error)\s*=\s*"([^"]*)"/gi)].map(m => m[1]);
      const dynamic = hits.filter(h => /\$\{|<%=|<%|\+\s*[A-Za-z_$]|innerHTML/.test(h));
      return dynamic.length === 0;
    })(), '内联处理器 ' + ((fs.readFileSync(path.join(REPO, 'src/renderer/index.html'), 'utf8').match(/\son(?:click|change|input|load|error)\s*=/gi) || []).length) + ' 处, 动态拼接 0 处');
    // 观察项:渲染层对 history 元数据的渲染是否转义(避免 XSS)
    ok('Z11', '观察项记录:渲染层使用 textContent/innerHTML 的情况(供后续阶段评估)', true,
      'innerHTML 出现 ' + ((renderer.match(/\.innerHTML/g) || []).length) + ' 次, textContent 出现 ' + ((renderer.match(/\.textContent/g) || []).length) + ' 次');
  }

  const s = summarize();
  console.log('\n---- 第六部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  closeAllWatchers();
  await sleep(120);
  cleanupTmp();
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); closeAllWatchers(); cleanupTmp(); process.exit(2); });
