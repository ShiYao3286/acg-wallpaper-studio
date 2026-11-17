// config.js:loadConfig 全局装配(各页初始态)。自 renderer.js 逐行迁出。

async function loadConfig() {
  const cfg = await api.getConfig();
  setSwitch('sw-schedule', cfg.schedule.enabled);
  setSwitch('sw-game', cfg.gameCheck.enabled);
  setSwitch('sw-excludeai', cfg.lolicon.excludeAI);
  $('interval').value = cfg.schedule.intervalMinutes;
  $('lolicon-size').value = cfg.lolicon.size;
  $('lolicon-r18').value = cfg.lolicon.r18;
  $('ai-prompt').value = cfg.ai.prompt;
  $('ai-model').value = cfg.ai.model;
  $('ai-size').value = cfg.ai.size;
  $('hist-keep').value = cfg.history.keepCount;
  $('game-procs').value = cfg.gameCheck.processes.join('\n');
  renderTags(cfg.lolicon.tags);
  $('seg-lolicon').classList.toggle('on', cfg.source !== 'ai');
  $('seg-ai').classList.toggle('on', cfg.source === 'ai');
  initAiMode(cfg.ai.randomMode || 'any');
  setSwitch('sw-preview', !!(cfg.ai && cfg.ai.previewMode));
  // 阶段4:本会话若有未确认的 pending(如切换页面/刷新界面),恢复预览卡片
  try {
    const pg = await api.aiPendingGet();
    if (pg && pg.ok && pg.exists) {
      await showPreview({ taskId: pg.taskId, imageVersion: pg.imageVersion, bytes: pg.bytes, prompt: pg.prompt, engine: pg.engine, pendingPath: pg.pendingPath });
    }
  } catch {}
  $('sw-autorun').classList.toggle('on', await api.getAutoRun());
  setSwitch('sw-proxy', cfg.proxy && cfg.proxy.enabled);
  if (!$('proxy-url').value) $('proxy-url').value = (cfg.proxy && cfg.proxy.url) || '';
  loadPresets();
  refreshAssistEngine();
  refreshStatus();
}
// 配置保存失败必须让用户看见:原实现丢弃 saveConfig 返回值,落盘失败也照弹"已保存"
