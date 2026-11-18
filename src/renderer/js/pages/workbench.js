// workbench.js:换图动作与 AI 生成预览流。自 renderer.js 逐行迁出。

async function changeNow() {
  const btn = $('btn-change'); btn.disabled = true;
  try {
    const r = await api.changeWallpaper('manual');
    if (r.ok) toast('换图成功: ' + (r.title || '') + (r.historyWriteError ? '(历史记录未写入: ' + r.historyWriteError + ')' : ''), 4000);
    else toast('换图失败: ' + r.error, 5000);
    refreshStatus();
  } catch (e) {
    // IPC 层面抛错(主进程 handler reject)原来会变成 unhandled rejection:用户什么都看不到
    toast('换图失败: ' + ((e && e.message) || e), 5000);
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
      document.querySelector('.ri[data-page="plugins"]').click();
      return;
    }
  } else {
    // 服务引擎:无画图服务时引导到 API 服务页
    const services = await api.listServices();
    const hasImage = services.some(s => s.kind === 'image');
    if (!hasImage) {
      toast('请先到「API 服务」页添加画图 API(需支持 /v1/images/generations)', 5000);
      document.querySelector('.ri[data-page="plugins"]').click();
      return;
    }
  }
  const btn = $('btn-ai'); btn.disabled = true;
  try {
    // 生成一律进图库:不自动换壁纸 —— 生成完去「图库」看,想用哪张自己点「设为壁纸」
    toast('AI 正在生成,约 20~60 秒…', 60000);
    const g = await api.aiGenerate();
    if (g && g.ok) {
      toast('已存入图库' + (g.fileName ? '(' + g.fileName + ')' : '') + ',去「图库」点「设为壁纸」即可生效', 6000);
      try { await loadHistory(); } catch {}   // 正在图库页时顺手把新图刷出来
    } else {
      toast('生成失败: ' + ((g && g.error) || '未知错误'), 5000);
    }
    refreshStatus();
  } catch (e) {
    toast('生成失败: ' + ((e && e.message) || e), 5000);
  } finally { btn.disabled = false; }
}

// 生成预览流(showPreview / 应用 / 放弃 / pending 恢复)已随「生成直接进图库」下线。
// 现在 ai-generate 一次到位把图写进图库,主进程不再留待确认状态,渲染层也不需要恢复逻辑。
async function favCurrent() {
  const r = await api.favoriteCurrent();
  toast(r.ok ? '已收藏到收藏夹 ♥' : '收藏失败: ' + r.error);
}
function openFolder() { api.openWallpaperDir(); }

// ---------- 提示词预设槽 ----------
