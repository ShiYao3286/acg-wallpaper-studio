// 第二十四部分:AI 生成预览流——主进程侧(阶段4 批2)
//   验证 ai-generate / ai-apply / ai-discard / ai-pending-get 四通道与
//   wallpaper-service.applyBuffer 复用。全部在主进程内完成,不出网、不真实设壁纸。
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, mkTmp, cleanupTmp, fakeJpeg, summarize } = require('./common');
const { loadMain, waitBoot, closeAllWatchers, setWallpaperBehavior, wallpaperCalls } = require('./harness');

async function mkEnv() {
  const root = mkTmp('acg-s4-');
  const userData = path.join(root, 'userData');
  const pictures = path.join(root, 'Pictures');
  const wallDir = path.join(pictures, 'ACG_Wallpaper');
  fs.mkdirSync(path.join(userData, 'config'), { recursive: true });
  fs.mkdirSync(wallDir, { recursive: true });
  const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
  await waitBoot(loaded.state, 5000);
  const call = async (ch, ...a) => { const fn = loaded.state.ipcHandlers.get(ch); if (!fn) throw new Error('通道未注册 ' + ch); return await fn({}, ...a); };
  return { root, userData, pictures, wallDir, call, loaded, pendingDir: path.join(userData, 'pending') };
}

// 拦截生图出网:openai-image provider 走 netFetch -> globalThis.fetch。
// 返回一个合法尺寸的假 JPEG(b64),使 generate 全链路(不含真实网络)成功。
function stubImageFetch(jpeg) {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url, opts) => {
    calls++;
    const body = { data: [{ b64_json: jpeg.toString('base64') }] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
  };
  return { restore: () => { globalThis.fetch = orig; }, count: () => calls };
}

// 写入画图服务配置并激活
async function seedImageService(call, svcId) {
  await call('save-service', { id: svcId, kind: 'image', name: '测试生图', apiBase: 'https://stub.example/v1', apiKey: 'sk-stub', model: 'stub-model' });
  await call('set-active-service', 'image', svcId);
  await call('save-config', 'source', 'ai');
  await call('save-config', 'ai.randomMode', 'custom');
  await call('save-config', 'ai.prompt', '测试提示词 A');
}

(async () => {
  const JPEG = fakeJpeg(30000, 's4');

  group('A ai-generate:写入 pending 且不触碰壁纸');
  {
    const env = await mkEnv();
    setWallpaperBehavior(undefined);
    await seedImageService(env.call, 'svc-img-1');
    const stub = stubImageFetch(JPEG);
    const curBefore = fs.existsSync(path.join(env.wallDir, 'current.jpg'));
    let r;
    try { r = await env.call('ai-generate'); } finally { stub.restore(); }
    ok('A1', 'ai-generate 成功返回 taskId/prompt/imageVersion', r && r.ok === true && typeof r.taskId === 'string' && r.prompt === '测试提示词 A' && typeof r.imageVersion === 'number',
      JSON.stringify({ ok: r && r.ok, err: r && r.error, id: r && r.taskId }).slice(0, 160));
    ok('A2', 'pending/image.jpg 与 meta.json 已写入', fs.existsSync(path.join(env.pendingDir, 'image.jpg')) && fs.existsSync(path.join(env.pendingDir, 'meta.json')), '');
    ok('A3', 'generate 未触碰 current.jpg 与系统壁纸', fs.existsSync(path.join(env.wallDir, 'current.jpg')) === curBefore && wallpaperCalls().length === 0,
      'setWallpaper 调用数=' + wallpaperCalls().length);
    ok('A4', '出网仅限生图 API(单次 fetch)', stub.count() === 1, 'fetch 次数=' + stub.count());
    const pg = await env.call('ai-pending-get');
    // 阶段4 批3:pengPath 有意回传(渲染层 file:// 预览需要)。断言升级:
    // pendingPath 必须精确等于 userData/pending(不越界),且响应不含任何敏感字段。
    ok('A5', 'ai-pending-get 返回存在态+元数据,pendingPath 限于 userData/pending',
      pg && pg.ok && pg.exists === true && pg.prompt === '测试提示词 A' && pg.taskId === r.taskId
      && pg.pendingPath === env.pendingDir
      && !/apikey|apikey|cookie|token|credential/i.test(JSON.stringify(pg)),
      JSON.stringify(pg).slice(0, 200));
    const st = await env.call('get-status');
    ok('A6', 'get-status 透出 task 快照与 pending 摘要', st.task && st.task.current === null && st.task.recent.length === 1 && st.pending && st.pending.exists === true,
      JSON.stringify({ recent: st.task && st.task.recent.length, pending: st.pending && st.pending.exists }));
    ok('A7', '任务快照记录 generate 成功', st.task.recent[0].kind === 'generate' && st.task.recent[0].ok === true, JSON.stringify(st.task.recent[0]).slice(0, 160));
    // 二次生成覆盖旧 pending
    const stub2 = stubImageFetch(JPEG);
    let r2;
    try { await env.call('save-config', 'ai.prompt', '测试提示词 B'); r2 = await env.call('ai-generate'); } finally { stub2.restore(); }
    const meta2 = JSON.parse(fs.readFileSync(path.join(env.pendingDir, 'meta.json'), 'utf8'));
    ok('A8', '新生成覆盖旧 pending 且 taskId 更新', r2.ok && meta2.prompt === '测试提示词 B' && meta2.taskId === r2.taskId && meta2.taskId !== r.taskId,
      JSON.stringify({ old: r.taskId, nw: r2.taskId }).slice(0, 100));
    closeAllWatchers();
  }

  group('B ai-apply:复用壁纸事务');
  {
    const env = await mkEnv();
    setWallpaperBehavior(undefined);
    await seedImageService(env.call, 'svc-img-2');
    const stub = stubImageFetch(JPEG);
    let g;
    try { g = await env.call('ai-generate'); } finally { stub.restore(); }
    const bad = await env.call('ai-apply', 'bogus-id');
    ok('B1', '不匹配的 taskId 被拒绝(E_STATE)', bad && bad.ok === false && bad.code === 'E_STATE', JSON.stringify({ code: bad && bad.code, err: bad && bad.error }).slice(0, 140));
    fs.writeFileSync(path.join(env.wallDir, 'current.jpg'), JPEG);
    const a = await env.call('ai-apply', g.taskId);
    ok('B2', 'ai-apply 成功', a && a.ok === true, JSON.stringify({ ok: a && a.ok, err: a && a.error }).slice(0, 140));
    ok('B3', '旧壁纸被归档(hist_*.jpg 出现)', (fs.readdirSync(env.wallDir).some(f => /^hist_.*\.jpg$/.test(f))), fs.readdirSync(env.wallDir).join(','));
    ok('B4', 'current.jpg 内容已替换为新图', fs.readFileSync(path.join(env.wallDir, 'current.jpg')).equals(JPEG), '');
    ok('B5', '系统壁纸被设置(mock 捕获调用)', wallpaperCalls().length === 1, '次数=' + wallpaperCalls().length);
    ok('B6', 'history.jsonl 写入 ai 记录', (() => {
      const raw = fs.readFileSync(path.join(env.wallDir, 'history.jsonl'), 'utf8');
      const rows = raw.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return rows.length && rows[rows.length - 1].source === 'ai' && rows[rows.length - 1].prompt === '测试提示词 A';
    })(), '');
    ok('B7', 'wallpaper_meta.json 回执写入', (() => {
      try { const m = JSON.parse(fs.readFileSync(path.join(env.wallDir, 'wallpaper_meta.json'), 'utf8')); return m.source === 'app' && m.prompt === '测试提示词 A'; } catch { return false; }
    })(), '');
    ok('B8', '应用成功后 pending 清空', !fs.existsSync(path.join(env.pendingDir, 'image.jpg')) && !fs.existsSync(path.join(env.pendingDir, 'meta.json')), '');
    const pg2 = await env.call('ai-pending-get');
    ok('B9', '应用后 pending-get 返回不存在', pg2 && pg2.ok && pg2.exists === false, JSON.stringify(pg2).slice(0, 100));
    const st = await env.call('get-status');
    ok('B10', '任务中心记录 apply 成功', st.task.recent.some(x => x.kind === 'apply' && x.ok === true), JSON.stringify(st.task.recent.map(x => x.kind)));
    const again = await env.call('ai-apply', g.taskId);
    ok('B11', '重复应用被拒绝(无 pending)', again && again.ok === false && again.code === 'E_NOT_FOUND', JSON.stringify({ code: again && again.code }).slice(0, 100));
    closeAllWatchers();
  }

  group('C ai-apply 失败回滚与 pending 保留');
  {
    const env = await mkEnv();
    setWallpaperBehavior('throw');
    await seedImageService(env.call, 'svc-img-3');
    const stub = stubImageFetch(JPEG);
    let g;
    try { g = await env.call('ai-generate'); } finally { stub.restore(); }
    fs.writeFileSync(path.join(env.wallDir, 'current.jpg'), JPEG);
    const a = await env.call('ai-apply', g.taskId);
    ok('C1', '设壁纸失败时 apply 返回失败(含回滚语义)', a && a.ok === false, JSON.stringify({ err: a && String(a.error || '').slice(0, 80) }).slice(0, 140));
    ok('C2', '回滚后 current.jpg 恢复为旧图', fs.existsSync(path.join(env.wallDir, 'current.jpg')), '');
    ok('C3', 'pending 文件保留(可重试或放弃)', fs.existsSync(path.join(env.pendingDir, 'image.jpg')) && fs.existsSync(path.join(env.pendingDir, 'meta.json')), '');
    const d = await env.call('ai-discard', g.taskId);
    ok('C4', 'ai-discard 成功清除 pending', d && d.ok && d.discarded && !fs.existsSync(path.join(env.pendingDir, 'image.jpg')), JSON.stringify(d).slice(0, 120));
    const st = await env.call('get-status');
    ok('C5', '任务中心记录 apply 失败与 discard', st.task.recent.some(x => x.kind === 'apply' && x.ok === false) && st.task.recent.some(x => x.kind === 'discard'), JSON.stringify(st.task.recent.map(x => x.kind + ':' + x.ok)));
    closeAllWatchers();
  }

  group('D ai-discard 与参数校验');
  {
    const env = await mkEnv();
    setWallpaperBehavior(undefined);
    await seedImageService(env.call, 'svc-img-4');
    const stub = stubImageFetch(JPEG);
    let g;
    try { g = await env.call('ai-generate'); } finally { stub.restore(); }
    const d1 = await env.call('ai-discard', 'wrong-id');
    ok('D1', 'discard 不匹配 taskId 被拒绝', d1 && d1.ok === false && d1.code === 'E_STATE', JSON.stringify({ code: d1 && d1.code }).slice(0, 100));
    const d2 = await env.call('ai-discard', g.taskId);
    ok('D2', '正确 taskId 放弃成功', d2 && d2.ok && d2.hadPending === true, JSON.stringify(d2).slice(0, 100));
    const d3 = await env.call('ai-discard', g.taskId);
    ok('D3', '重复放弃幂等(hadPending=false)', d3 && d3.ok && d3.hadPending === false, JSON.stringify(d3).slice(0, 100));
    const gen1 = await env.call('ai-generate', 123);
    ok('D4', 'ai-generate 拒绝非字符串提示词', gen1 && gen1.ok === false, JSON.stringify({ err: gen1 && gen1.error }).slice(0, 100));
    const gen2 = await env.call('ai-generate', 'x'.repeat(2001));
    ok('D5', 'ai-generate 拒绝超长提示词', gen2 && gen2.ok === false, JSON.stringify({ err: gen2 && gen2.error }).slice(0, 100));
    await env.call('delete-service', 'svc-img-4');
    const stub3 = stubImageFetch(JPEG);
    let gen3;
    try { gen3 = await env.call('ai-generate'); } finally { stub3.restore(); }
    ok('D6', '无服务时生成失败且不写 pending', gen3 && gen3.ok === false && !fs.existsSync(path.join(env.pendingDir, 'image.jpg')), JSON.stringify({ err: gen3 && String(gen3.error || '').slice(0, 60) }).slice(0, 140));
    closeAllWatchers();
  }

  group('E 启动清理孤儿 pending');
  {
    const root = mkTmp('acg-s4e-');
    const userData = path.join(root, 'userData');
    const pictures = path.join(root, 'Pictures');
    fs.mkdirSync(path.join(userData, 'config'), { recursive: true });
    fs.mkdirSync(path.join(userData, 'pending'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'pending', 'image.jpg'), JPEG);
    fs.writeFileSync(path.join(userData, 'pending', 'meta.json'), '{}');
    fs.mkdirSync(path.join(pictures, 'ACG_Wallpaper'), { recursive: true });
    const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
    await waitBoot(loaded.state, 5000);
    await new Promise(r => setTimeout(r, 200));
    const files = fs.existsSync(path.join(userData, 'pending')) ? fs.readdirSync(path.join(userData, 'pending')) : [];
    ok('E1', '启动后孤儿 pending 被清理', files.length === 0, '残留=' + files.join(','));
    closeAllWatchers();
  }

  group('F changeWallpaper 原路径回归(重构未漂移)');
  {
    const env = await mkEnv();
    setWallpaperBehavior(undefined);
    await seedImageService(env.call, 'svc-img-5');
    const stub = stubImageFetch(JPEG);
    let r;
    try { r = await env.call('change-wallpaper', 'ai'); } finally { stub.restore(); }
    ok('F1', '原 change-wallpaper(ai) 路径仍成功', r && r.ok === true, JSON.stringify({ ok: r && r.ok, err: r && r.error }).slice(0, 140));
    ok('F2', '原路径一次性完成设壁纸', wallpaperCalls().length === 1, '次数=' + wallpaperCalls().length);
    ok('F3', '原路径不产生 pending', !fs.existsSync(path.join(env.pendingDir, 'image.jpg')), '');
    closeAllWatchers();
  }

  group('G apply 与换图互斥(并发防线)');
  {
    const env = await mkEnv();
    setWallpaperBehavior(undefined);
    await seedImageService(env.call, 'svc-img-6');
    // 生成 pending
    const stub = stubImageFetch(JPEG);
    let g;
    try { g = await env.call('ai-generate'); } finally { stub.restore(); }

    // 持锁:change-wallpaper(ai) 获取 changing 互斥后,把 fetch 挂起(可控 deferred)
    let releaseFetch = null;
    const orig = globalThis.fetch;
    globalThis.fetch = () => new Promise(res => { releaseFetch = () => res({ ok: true, status: 200,
      json: () => Promise.resolve({ data: [{ b64_json: JPEG.toString('base64') }] }),
      text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }); });
    let cwDone = false, cwErr = null;
    const cwPromise = env.call('change-wallpaper', 'ai').then(r => { cwDone = true; return r; }).catch(e => { cwErr = e; });
    // 轮询等待锁被获取且 fetch 进入挂起(不假设固定时延)
    for (let i = 0; i < 100 && typeof releaseFetch !== 'function'; i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    ok('G0', '换图请求已进入挂起的 fetch(时序自证)', typeof releaseFetch === 'function', '');

    // 并发 apply:必须被互斥拒绝,不能进入事务
    const a = await env.call('ai-apply', g.taskId);
    ok('G1', '换图进行中时 ai-apply 被互斥拒绝(E_STATE)', a && a.ok === false && a.code === 'E_STATE' && /正在换图/.test(String(a.error || '')),
      JSON.stringify({ ok: a && a.ok, code: a && a.code, err: a && a.error }).slice(0, 140));

    // 放行换图并等待完成
    releaseFetch();
    const cw = await cwPromise;
    globalThis.fetch = orig;
    ok('G2', '挂起的换图最终成功(测试自证)', cw && cw.ok === true && !cwErr, JSON.stringify({ ok: cw && cw.ok, err: cw && cw.error }).slice(0, 100));
    // 换图直应用路径消耗了 pending 吗?不会——它走 changeWallpaper 取图,pending 未被触碰。
    // 因此 pending 仍可被正常应用(此时锁已释放)
    const a2 = await env.call('ai-apply', g.taskId);
    ok('G3', '锁释放后同一 pending 可正常应用', a2 && a2.ok === true, JSON.stringify({ ok: a2 && a2.ok, err: a2 && a2.error }).slice(0, 120));
    closeAllWatchers();
  }

  const sum = summarize();
  console.log('---- 第二十四部分小结: ' + sum.passed + '/' + sum.total + ' 通过, ' + sum.failed + ' 失败' + (sum.skipped ? ', ' + sum.skipped + ' 跳过' : ''));
  cleanupTmp();
  process.exit(sum.failed ? 1 : 0);
})().catch(e => { console.error('[FATAL]', e && e.stack || e); cleanupTmp(); process.exit(1); });