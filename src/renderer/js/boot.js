// boot.js:启动序列(DOMContentLoaded)。自 renderer.js 逐行迁出。

window.addEventListener('DOMContentLoaded', async () => {
  // 直接用 config.js 里的 loadConfig,不再绕 _origLoadConfig 这个别名(它只是历史包袱)
  await loadConfig();
  refreshOldTaskBadge();
  // 阶段3:启动时读一次豆包状态(只读,不会打开任何窗口)
  try { await refreshDoubao(); } catch {}
});
