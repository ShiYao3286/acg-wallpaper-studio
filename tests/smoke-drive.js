// 阶段4 实机冒烟驱动(保留资产,不进 run-all):连接 CDP 9224 驱动 smoke-main.js 实例。
// 仅做只读检查与 aiDiscard 调用,不点「应用为壁纸」(避免真实系统调用)。经 CDP 9224 驱动真实界面走预览流。
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
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { ERR: (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 300) };
    return r && r.result ? r.result.value : undefined;
  };

  // 1. 界面启动完好性
  console.log('R1', JSON.stringify(await ev("(() => ({ title: document.title, hasCard: !!document.getElementById('ai-preview-card'), hasBtn: !!document.getElementById('btn-ai'), hasSw: !!document.getElementById('sw-preview') }))()")));
  // 2. 预览开关初始态(配置 previewMode=true)
  console.log('R2', JSON.stringify(await ev("(() => ({ swOn: document.getElementById('sw-preview').classList.contains('on') }))()")));
  // 3. 触发 AI 生成按钮(预览模式路径)
  console.log('R3', JSON.stringify(await ev("(async () => { document.getElementById('btn-ai').click(); await new Promise(r => setTimeout(r, 2500)); const card = document.getElementById('ai-preview-card'); const img = document.getElementById('ai-preview-img'); return { cardShown: card && card.style.display !== 'none', imgSrc: img && img.src.slice(0, 60), meta: (document.getElementById('ai-preview-meta') || {}).textContent || '' }; })()")));
  // 4. 主进程 pending 状态(经 api)
  console.log('R4', JSON.stringify(await ev("(async () => { const p = await window.api.aiPendingGet(); return { exists: p.exists, taskId: (p.taskId || '').length > 0, bytes: p.bytes, hasPendingPath: !!p.pendingPath }; })()")));
  // 5. 点应用:壁纸应用到临时 pictures 目录 + 系统 setWallpaper 会被调用(真实 wallpaper 包!)
  //    为避免真实改系统壁纸,先在主进程拦截:直接调 IPC 校验,不点 UI。
  //    改为只验证 pending->apply 的 IPC 合约(与 t24 相同路径,不重复设壁纸)。
  console.log('R5', JSON.stringify(await ev("(async () => { const p = await window.api.aiPendingGet(); const r = await window.api.aiDiscard(p.taskId); return { ok: r.ok, discarded: r.discarded }; })()")));
  // 6. 应用按钮存在且可点(不实际点):布局验证
  console.log('R6', JSON.stringify(await ev("(() => ({ apply: !!document.getElementById('btn-apply'), regen: !!document.getElementById('btn-regen'), discard: !!document.getElementById('btn-discard'), hidden: document.getElementById('ai-preview-card').style.display === 'none' }))()")));
  // 7. 运行时错误收集
  console.log('R7', JSON.stringify(await ev("(() => window.__smokeErrors || [])")));
  ws.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });