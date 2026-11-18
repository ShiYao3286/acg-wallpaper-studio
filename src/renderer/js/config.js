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
  // #ai-model 的 option 值是 'doubao' / 'svc:模型名',直接赋 cfg.ai.model(裸模型名)永远匹配不上,
  // 会把下拉打成空值。这个下拉统一由 refreshImageEngineOptions() 按引擎+模型回填,这里不碰。
  $('ai-size').value = cfg.ai.size;
  $('hist-keep').value = cfg.history.keepCount;
  $('game-procs').value = cfg.gameCheck.processes.join('\n');
  renderTags(cfg.lolicon.tags);
  $('seg-lolicon').classList.toggle('on', cfg.source !== 'ai');
  $('seg-ai').classList.toggle('on', cfg.source === 'ai');
  initAiMode(cfg.ai.randomMode || 'any');
  // 生成预览开关与 pending 恢复已随「生成直接进图库」下线,这里不再回填
  $('sw-autorun').classList.toggle('on', await api.getAutoRun());
  setSwitch('sw-proxy', cfg.proxy && cfg.proxy.enabled);
  if (!$('proxy-url').value) $('proxy-url').value = (cfg.proxy && cfg.proxy.url) || '';
  loadPresets();
  refreshAssistEngine();
  refreshStatus();
}
// 配置保存失败必须让用户看见:原实现丢弃 saveConfig 返回值,落盘失败也照弹"已保存"
