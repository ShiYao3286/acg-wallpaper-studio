// boot.js:启动序列(DOMContentLoaded)。自 renderer.js 逐行迁出。

window.addEventListener('DOMContentLoaded', async () => {
  await _origLoadConfig();
  refreshOldTaskBadge();
  // 阶段3:启动时读一次豆包状态(只读,不会打开任何窗口)
  try { await refreshDoubao(); } catch {}
});
