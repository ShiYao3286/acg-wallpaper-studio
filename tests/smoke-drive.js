// 阶段4 实机冒烟驱动(保留资产,不进 run-all):连接 CDP 9224 驱动 smoke-main.js 实例。
// UI 重构版:六页导航点检 + 图片库 tab + 插件中心 + 预览流。
const http = require('node:http');
function getJson(u) { return new Promise((res, rej) => { http.get(u, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch (e) { rej(e); } }); }).on('error', rej); }); }
(async () => {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJson('http://127.0.0.1:9224/json'); if (targets.some(t => t.type === 'page' && t.url.includes('index.html'))) break; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  if (!targets) { console.error('CDP-TIMEOUT'); process.exit(1); }
  const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
  ws.addEventListener('message', ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } });
  await new Promise(r => ws.addEventListener('open', r));
  const ev = async (fn, arg) => {
    const r = await send('Runtime.evaluate', { expression: '(' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')', returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { ERR: ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 300) };
    return r && r.result ? r.result.value : undefined;
  };

  // 1. 界面启动完好性(六页 nav 齐,预览元素齐)
  console.log('R1', JSON.stringify(await ev(async () => ({
    title: document.title,
    navs: [...document.querySelectorAll('.nav-item')].map(n => n.dataset.page),
    hasCard: !!document.getElementById('ai-preview-card'),
    hasBtn: !!document.getElementById('btn-ai'),
    hasSw: !!document.getElementById('sw-preview'),
  }))));

  // 2. 六页导航点检
  console.log('R2', JSON.stringify(await ev(async () => {
    const pages = ['workbench', 'creation', 'library', 'desktop', 'plugins', 'settings'];
    const out = {};
    for (const pg of pages) {
      const nav = document.querySelector('.nav-item[data-page="' + pg + '"]');
      const pageEl = document.getElementById('page-' + pg);
      if (!nav || !pageEl) { out[pg] = 'MISSING'; continue; }
      nav.click();
      await new Promise(r => setTimeout(r, 120));
      out[pg] = pageEl.classList.contains('active') ? 'OK' : 'NOT-ACTIVE';
    }
    return out;
  })));

  // 3. 图片库 tab 切换 + 插件中心内容
  console.log('R3', JSON.stringify(await ev(async () => {
    document.querySelector('.nav-item[data-page="library"]').click();
    await new Promise(r => setTimeout(r, 150));
    const favBtn = document.querySelectorAll('#lib-seg button')[1];
    if (favBtn) favBtn.click();
    await new Promise(r => setTimeout(r, 400));
    const favShown = document.getElementById('lib-favorites').style.display !== 'none';
    const histHidden = document.getElementById('lib-history').style.display === 'none';
    document.querySelector('.nav-item[data-page="plugins"]').click();
    await new Promise(r => setTimeout(r, 600));
    const pluginRows = document.querySelectorAll('#plugin-list .svc-card').length;
    const doubaoVisible = !!document.getElementById('doubao-card');
    const svcVisible = !!document.getElementById('svc-list');
    document.querySelector('.nav-item[data-page="workbench"]').click();
    await new Promise(r => setTimeout(r, 150));
    return { favShown, histHidden, pluginRows, doubaoVisible, svcVisible };
  })));

  // 4. 预览开关初始态(配置 previewMode=true)
  console.log('R4', JSON.stringify(await ev(async () => ({ swOn: document.getElementById('sw-preview').classList.contains('on') }))));

  // 5. 触发 AI 生成(预览模式路径)
  console.log('R5', JSON.stringify(await ev(async () => {
    document.getElementById('btn-ai').click();
    await new Promise(r => setTimeout(r, 2500));
    const card = document.getElementById('ai-preview-card');
    const img = document.getElementById('ai-preview-img');
    return { cardShown: card && card.style.display !== 'none', imgSrc: (img && img.src || '').slice(0, 60), meta: (document.getElementById('ai-preview-meta') || {}).textContent || '' };
  })));

  // 6. pending 状态与放弃
  console.log('R6', JSON.stringify(await ev(async () => {
    const p = await window.api.aiPendingGet();
    const r = await window.api.aiDiscard(p.taskId);
    return { exists: p.exists, taskId: (p.taskId || '').length > 0, hasPendingPath: !!p.pendingPath, discardOk: r.ok };
  })));

  // 7. 运行时错误收集
  console.log('R7', JSON.stringify(await ev(async () => (window.__smokeErrors || []))));
  ws.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });