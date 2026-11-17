// workbench.js:换图动作与 AI 生成预览流。自 renderer.js 逐行迁出。

async function changeNow() {
  const btn = $('btn-change'); btn.disabled = true;
  try {
    const r = await api.changeWallpaper('manual');
    if (r.ok) toast('换图成功: ' + (r.title || '') + (r.historyWriteError ? '(历史记录未写入: ' + r.historyWriteError + ')' : ''), 4000);
    else toast('换图失败: ' + r.error, 5000);
    refreshStatus();
  } finally { btn.disabled = false; }
}
async function aiNow() {
  const cfg = await api.getConfig();
  const engine = (cfg.ai && cfg.ai.imageEngine) || 'service';

  if (engine === 'doubao') {
    // 豆包引擎:先确认已登录,否则给明确指引而不是让用户等到超时
    const ds = await api.doubao.status();
    if (!ds || ds.state !== 'authenticated') {
      toast('豆包未登录:请到「API 服务」页的豆包卡片扫码登录', 5000);
      document.querySelector('.nav-item[data-page="plugins"]').click();
      return;
    }
  } else {
    // 服务引擎:无画图服务时引导到 API 服务页
    const services = await api.listServices();
    const hasImage = services.some(s => s.kind === 'image');
    if (!hasImage) {
      toast('请先到「API 服务」页添加画图 API(需支持 /v1/images/generations)', 5000);
      document.querySelector('.nav-item[data-page="plugins"]').click();
      return;
    }
  }
  const btn = $('btn-ai'); btn.disabled = true;
  try {
    // 阶段4:previewMode=true 走生成预览流(不自动应用);false 走原直应用路径
    const cfg2 = await api.getConfig();
    if (cfg2.ai && cfg2.ai.previewMode) {
      toast('AI 正在生成,约 20~60 秒…', 60000);
      const g = await api.aiGenerate();
      if (g && g.ok) {
        await showPreview(g);
        toast('生成完成,请确认后应用', 4000);
      } else {
        hidePreview();
        toast('生成失败: ' + ((g && g.error) || '未知错误'), 5000);
      }
      return;
    }
    toast('AI 正在生成,约 20~60 秒…', 60000);
    const r = await api.changeWallpaper('ai');
    if (r.ok) toast('AI 壁纸已应用!' + (r.historyWriteError ? '(历史记录未写入: ' + r.historyWriteError + ')' : ''), 4000);
    else toast('生成失败: ' + r.error, 5000);
    refreshStatus();
  } finally { btn.disabled = false; }
}

// ---------- 生成预览流(阶段4) ----------
// taskId 是轻量句柄;预览图用 file:// 直读 pending 文件,
// imageVersion(mtimeMs)做缓存破坏,避免同一路径显示旧图。
let previewTaskId = '';
let __pendingPath = '';   // pending 目录绝对路径,由 ai-generate 返回值下发
async function showPreview(gen) {
  previewTaskId = gen.taskId || '';
  __pendingPath = gen.pendingPath || '';
  const card = $('ai-preview-card');
  const img = $('ai-preview-img');
  const meta = $('ai-preview-meta');
  if (!card || !img) return;
  img.src = 'file:///' + encodeURI(__pendingPath.replace(/\\/g, '/')) + '?v=' + gen.imageVersion;
  if (meta) meta.textContent = (gen.engine === 'doubao' ? '豆包' : 'API 服务') + ' · ' +
    Math.round((gen.bytes || 0) / 1024) + 'KB · ' + String(gen.prompt || '').slice(0, 40) + (String(gen.prompt || '').length > 40 ? '…' : '');
  card.style.display = '';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hidePreview() {
  previewTaskId = '';
  const card = $('ai-preview-card');
  if (card) card.style.display = 'none';
  const img = $('ai-preview-img');
  if (img) img.src = '';
}
async function aiApplyNow() {
  if (!previewTaskId) { toast('没有待应用的预览', 3000); return; }
  const btn = $('btn-apply'); btn.disabled = true;
  try {
    const r = await api.aiApply(previewTaskId);
    if (r && r.ok) {
      toast('已应用为壁纸!' + (r.historyWriteError ? '(历史记录未写入: ' + r.historyWriteError + ')' : ''), 4000);
      hidePreview();
      refreshStatus();
    } else {
      toast('应用失败: ' + ((r && r.error) || '未知错误'), 5000);
      // 过期/不存在:刷新预览状态,pending 已不在则收起卡片;被新图覆盖则切到新图
      const pg = await api.aiPendingGet();
      if (!pg || !pg.ok || !pg.exists) hidePreview();
      else if (pg.taskId && pg.taskId !== previewTaskId) {
        await showPreview({ taskId: pg.taskId, imageVersion: pg.imageVersion, bytes: pg.bytes, prompt: pg.prompt, engine: pg.engine });
      }
    }
  } finally { btn.disabled = false; }
}
async function aiRegen() {
  // 重新生成 = 新的一次 ai-generate(消耗一次额度);旧 pending 被新图覆盖
  if (previewTaskId) { try { await api.aiDiscard(previewTaskId); } catch {} }
  await aiNow();
}
async function aiDiscardNow() {
  if (!previewTaskId) return;
  const btn = $('btn-discard'); btn.disabled = true;
  try {
    const r = await api.aiDiscard(previewTaskId);
    if (r && r.ok) { toast('已放弃本次生成', 3000); hidePreview(); }
    else toast('放弃失败: ' + ((r && r.error) || '未知错误'), 4000);
  } finally { btn.disabled = false; }
}
async function favCurrent() {
  const r = await api.favoriteCurrent();
  toast(r.ok ? '已收藏到收藏夹 ♥' : '收藏失败: ' + r.error);
}
function openFolder() { api.openWallpaperDir(); }

// ---------- 提示词预设槽 ----------
