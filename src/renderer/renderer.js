// 渲染进程逻辑 v1.3.1
// 版本号需与 package.json 保持一致，后续应由主进程注入
const $ = id => document.getElementById(id);

// ---------- 导航 ----------
document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    $('page-' + el.dataset.page).classList.add('active');
    if (el.dataset.page === 'history') loadHistory();
    if (el.dataset.page === 'favorites') loadFavorites();
    if (el.dataset.page === 'services') loadServices();
    if (el.dataset.page === 'ai') loadPresets();
  });
});

function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._tm); t._tm = setTimeout(() => t.style.display = 'none', ms);
}
function setSwitch(id, on) { const s = $(id); if (s) s.classList.toggle('on', !!on); }
// 填充模型下拉/候选列表(DOM API,模型名来自远端 API,不可拼 HTML)
// withValue=true 用于 datalist 候选(value 属性),false 用于 select 选项
function fillModelOptions(targetId, models, withValue = true) {
  const box = $(targetId);
  if (!box) return;
  box.textContent = '';
  (models || []).forEach(m => {
    const opt = document.createElement('option');
    const name = String(m);
    if (withValue) opt.value = name;
    opt.textContent = withValue ? '' : name;
    box.appendChild(opt);
  });
}

// ---------- 配置 ----------
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
  $('sw-autorun').classList.toggle('on', await api.getAutoRun());
  setSwitch('sw-proxy', cfg.proxy && cfg.proxy.enabled);
  if (!$('proxy-url').value) $('proxy-url').value = (cfg.proxy && cfg.proxy.url) || '';
  loadPresets();
  refreshAssistEngine();
  refreshStatus();
}
async function saveStr(key, val) { await api.saveConfig(key, String(val)); toast('已保存'); }
async function saveNum(key, val) { await api.saveConfig(key, parseInt(val) || 0); toast('已保存'); }
async function toggleSwitch(el, key) {
  el.classList.toggle('on');
  await api.saveConfig(key, el.classList.contains('on'));
  toast('已保存');
}
async function setSource(src) {
  $('seg-lolicon').classList.toggle('on', src !== 'ai');
  $('seg-ai').classList.toggle('on', src === 'ai');
  await api.saveConfig('source', src);
  toast('壁纸来源已切换: ' + (src === 'ai' ? 'AI 生图' : 'Lolicon 二次元图'));
  refreshStatus();
}
function stepInterval(d) {
  const el = $('interval');
  el.value = Math.min(720, Math.max(5, (parseInt(el.value) || 30) + d));
  saveNum('schedule.intervalMinutes', el.value);
}
async function saveGameProcs(txt) {
  await api.saveConfig('gameCheck.processes', txt.split('\n').map(s => s.trim()).filter(Boolean));
  toast('已保存');
}
async function disableOldTask() {
  const r = await api.disableOldTask();
  $('old-task-status').textContent = r.ok ? '已停用 ✓' : ('失败: ' + r.error);
  toast(r.ok ? '旧计划任务已停用' : '停用失败:' + r.error);
}
async function toggleAutoRun(el) {
  el.classList.toggle('on');
  await api.setAutoRun(el.classList.contains('on'));
  toast(el.classList.contains('on') ? '已开启开机自启' : '已关闭开机自启');
}

// ---------- 标签池 ----------
function renderTags(tags) {
  const box = $('tag-list');
  box.textContent = '';
  if (!tags || !tags.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '标签池为空,换图时将不指定题材';
    box.appendChild(p);
    return;
  }
  tags.forEach((t, i) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip c' + (i % 6);
    chip.appendChild(document.createTextNode(t));
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    x.addEventListener('click', () => delTag(t));
    chip.appendChild(x);
    box.appendChild(chip);
  });
}
async function addTag() {
  const v = $('tag-input').value.trim();
  if (!v) return;
  await api.addTag(v);
  $('tag-input').value = '';
  renderTags((await api.getConfig()).lolicon.tags);
}
async function delTag(t) {
  await api.removeTag(t);
  renderTags((await api.getConfig()).lolicon.tags);
}

// ---------- 动作 ----------
async function changeNow() {
  const btn = $('btn-change'); btn.disabled = true;
  try {
    const r = await api.changeWallpaper('manual');
    if (r.ok) toast('换图成功: ' + (r.title || ''), 4000);
    else toast('换图失败: ' + r.error, 5000);
    refreshStatus();
  } finally { btn.disabled = false; }
}
async function aiNow() {
  // 无画图服务时引导到 API 服务页
  const services = await api.listServices();
  const hasImage = services.some(s => s.kind === 'image');
  if (!hasImage) {
    toast('请先到「API 服务」页添加画图 API(需支持 /v1/images/generations)', 5000);
    document.querySelector('.nav-item[data-page="services"]').click();
    return;
  }
  const btn = $('btn-ai'); btn.disabled = true;
  toast('AI 正在生成,约 20~60 秒…', 60000);
  try {
    const r = await api.changeWallpaper('ai');
    if (r.ok) toast('AI 壁纸已应用!', 4000);
    else toast('生成失败: ' + r.error, 5000);
    refreshStatus();
  } finally { btn.disabled = false; }
}
async function favCurrent() {
  const r = await api.favoriteCurrent();
  toast(r.ok ? '已收藏到收藏夹 ♥' : '收藏失败: ' + r.error);
}
function openFolder() { api.openWallpaperDir(); }

// ---------- 提示词预设槽 ----------
async function loadPresets() {
  const cfg = await api.getConfig();
  const list = cfg.promptPresets || [];
  const box = $('preset-list');
  box.textContent = '';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const makeSlot = (label, iconId, onClick, dashed) => {
    const slot = document.createElement('span');
    slot.className = 'preset-slot';
    if (dashed) slot.style.borderStyle = 'dashed';
    const svg = document.createElementNS(SVG_NS, 'svg');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', iconId);
    svg.appendChild(use);
    slot.appendChild(svg);
    slot.appendChild(document.createTextNode(label));
    slot.addEventListener('click', onClick);
    return slot;
  };
  list.forEach(p => box.appendChild(makeSlot(p.name, '#i-save', () => applyPreset(p.id), false)));
  box.appendChild(makeSlot('存当前为新预设', '#i-plus', () => saveAsPreset(), true));
}
async function applyPreset(id) {
  const cfg = await api.getConfig();
  const p = (cfg.promptPresets || []).find(x => x.id === id);
  if (!p) return;
  $('ai-prompt').value = p.prompt;
  await api.saveConfig('ai.prompt', p.prompt);
  toast('已套用预设: ' + p.name);
}
async function saveAsPreset() {
  const name = prompt('预设名称:', '新预设');
  if (!name) return;
  await api.savePreset({ id: 'preset-' + Date.now(), name, prompt: $('ai-prompt').value });
  loadPresets();
  toast('预设已保存');
}

// ---------- 生成模式(随机灵感) ----------
const MODE_HINTS = {
  any: '每次生成自动随机拼装提示词(人物/风景随机),几乎不重样。',
  portrait: '锁定人物:随机发色×发型×瞳色×服装×表情×场景,主角必是人物。',
  scenery: '锁定风景:随机山水×天气×色调,纯净壁纸无人。',
  custom: '自定义:使用下方提示词原样生成(助手润色也改这里)。',
};
let currentAiMode = 'any';
function initAiMode(mode) {
  currentAiMode = mode;
  for (const m of ['any', 'portrait', 'scenery', 'custom']) {
    const el = $('mode-' + m);
    if (el) el.classList.toggle('on', m === mode);
  }
  $('ai-mode-hint').textContent = MODE_HINTS[mode] || MODE_HINTS.any;
  $('custom-prompt-area').style.display = mode === 'custom' ? 'block' : 'none';
  $('random-preview-area').style.display = mode === 'custom' ? 'none' : 'block';
  if (mode !== 'custom') rollPreview();
}
async function rollPreview(btn) {
  const r = await api.rollRandomPrompt(currentAiMode);
  $('random-prompt-preview').textContent = r.prompt;
  if (btn) { btn.classList.add('spinning'); setTimeout(() => btn.classList.remove('spinning'), 700); }
}
async function setRandomMode(mode) {
  currentAiMode = mode;
  await api.saveConfig('ai.randomMode', mode);
  initAiMode(mode);
  toast('已切换: ' + ({ any: '完全随机', portrait: '锁定人物', scenery: '锁定风景', custom: '自定义' }[mode]));
}

// ---------- 提示词助手 ----------
async function refreshAssistEngine() {
  const cfg = await api.getConfig();
  const textSvc = (cfg.services || []).find(s => s.id === cfg.activeTextService);
  $('assist-engine').textContent = textSvc ? ('引擎: ' + textSvc.name + ' (' + textSvc.model + ')') : '引擎: 本地风格词池(未配置文本模型)';
}
async function runAssist() {
  const btn = $('btn-assist'); btn.disabled = true;
  try {
    const r = await api.aiAssistPrompt($('assist-theme').value);
    if (r.ok) {
      $('ai-prompt').value = r.prompt;
      await api.saveConfig('ai.prompt', r.prompt);
      toast(r.local ? '本地增强完成' : '文本模型已生成提示词', 3500);
    } else toast('失败: ' + r.error, 5000);
  } finally { btn.disabled = false; }
}

// ---------- 历史 / 收藏 ----------
// 构建一张图片卡片(DOM API,避免把文件名拼进 HTML)
function makeGalleryItem(file, opts = {}) {
  const item = document.createElement('div');
  item.className = 'gitem';
  item.addEventListener('click', () => useHistory(file.name));
  const img = document.createElement('img');
  img.src = encodeURI('file:///' + String(file.path).replace(/\\/g, '/'));
  item.appendChild(img);
  if (opts.showName !== false) {
    const name = document.createElement('div');
    name.className = 'gname';
    name.textContent = file.name;
    item.appendChild(name);
  }
  if (opts.deletable) {
    const del = document.createElement('button');
    del.className = 'gdel';
    del.title = '删除收藏';
    del.addEventListener('click', (ev) => { ev.stopPropagation(); delFav(file.name); });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-trash');
    svg.appendChild(use);
    del.appendChild(svg);
    item.appendChild(del);
  }
  const act = document.createElement('button');
  act.className = 'gact';
  act.textContent = '设为壁纸';
  act.addEventListener('click', (ev) => { ev.stopPropagation(); useHistory(file.name); });
  item.appendChild(act);
  return item;
}
function setEmptyTip(box, text) {
  box.textContent = '';
  const tip = document.createElement('div');
  tip.className = 'empty-tip';
  tip.textContent = text;
  box.appendChild(tip);
}
async function loadHistory() {
  const files = await api.listHistory();
  const box = $('gallery');
  box.textContent = '';
  if (!files || !files.length) { setEmptyTip(box, '暂无历史壁纸,点「立即换一张」开始 ✨'); return; }
  files.forEach(f => box.appendChild(makeGalleryItem(f)));
}
async function loadFavorites() {
  const files = await api.listFavorites();
  const box = $('fav-gallery');
  box.textContent = '';
  if (!files || !files.length) { setEmptyTip(box, '暂无收藏 ♥ 主页右上角心形按钮可收藏当前壁纸'); return; }
  files.forEach(f => box.appendChild(makeGalleryItem(f, { showName: false, deletable: true })));
}
async function delFav(name) {
  const r = await api.deleteFavorite(name);
  toast(r.ok ? '已删除' : '失败: ' + r.error);
  loadFavorites();
}
async function useHistory(name) {
  const r = await api.useHistory(name);
  toast(r.ok ? '已设为壁纸' : '失败: ' + r.error);
}

// ---------- API 服务 ----------
let editingSvc = null;
async function loadServices() {
  const services = await api.listServices();
  const cfg = await api.getConfig();
  const box = $('svc-list');
  box.textContent = '';
  if (!services || !services.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '还没有服务,点下方添加。默认生图服务已预置。';
    box.appendChild(p);
  } else {
    services.forEach(s => {
      const isActiveImg = s.id === cfg.activeImageService && s.kind === 'image';
      const isActiveTxt = s.id === cfg.activeTextService && s.kind === 'text';
      const card = document.createElement('div');
      card.className = 'svc-card';
      const head = document.createElement('div');
      head.className = 'svc-head';
      const kindEl = document.createElement('span');
      kindEl.className = 'svc-kind ' + s.kind;
      kindEl.textContent = s.kind === 'image' ? '画图' : '文本';
      head.appendChild(kindEl);
      const nameEl = document.createElement('span');
      nameEl.className = 'svc-name';
      nameEl.textContent = s.name || '未命名';
      head.appendChild(nameEl);
      if (isActiveImg || isActiveTxt) {
        const badge = document.createElement('span');
        badge.className = 'active-badge';
        badge.textContent = '使用中';
        head.appendChild(badge);
      }
      const modelEl = document.createElement('span');
      modelEl.className = 'svc-model';
      modelEl.textContent = s.model || '';
      head.appendChild(modelEl);
      const actions = document.createElement('div');
      actions.className = 'svc-actions';
      const mkBtn = (label, onClick) => {
        const b = document.createElement('button');
        b.className = 'btn small ghost';
        b.textContent = label;
        b.addEventListener('click', onClick);
        actions.appendChild(b);
      };
      mkBtn(s.kind === 'image' ? '设为画图' : '设为文本', () => setActive(s.kind, s.id));
      mkBtn('编辑', () => editService(s.id));
      mkBtn('删除', () => deleteService(s.id));
      head.appendChild(actions);
      card.appendChild(head);
      const res = document.createElement('div');
      res.className = 'svc-test-result';
      res.id = 'svc-res-' + s.id;
      res.textContent = s.apiBase || '';
      card.appendChild(res);
      box.appendChild(card);
    });
  }
  refreshAssistEngine();
}
function newService() {
  editingSvc = { id: 'svc-' + Date.now(), kind: 'image', name: '', apiBase: '', apiKey: '', model: '' };
  $('svc-editor-title').textContent = '添加服务';
  $('svc-name').value = ''; $('svc-kind').value = 'image'; $('svc-base').value = '';
  $('svc-key').value = ''; $('svc-model').value = ''; $('svc-model-list').innerHTML = '';
  $('svc-editor-result').textContent = '';
  $('svc-editor').style.display = 'block';
}
async function editService(id) {
  const services = await api.listServices();
  const s = services.find(x => x.id === id);
  if (!s) return;
  editingSvc = { ...s };
  $('svc-editor-title').textContent = '编辑服务: ' + (s.name || '');
  $('svc-name').value = s.name || ''; $('svc-kind').value = s.kind;
  $('svc-base').value = s.apiBase || ''; $('svc-key').value = s.apiKey || '';
  $('svc-model').value = s.model || ''; $('svc-model-list').innerHTML = '';
  $('svc-editor-result').textContent = '';
  $('svc-editor').style.display = 'block';
}
function closeEditor() { $('svc-editor').style.display = 'none'; editingSvc = null; }
async function saveService() {
  if (!editingSvc) return;
  editingSvc.name = $('svc-name').value.trim();
  editingSvc.kind = $('svc-kind').value;
  editingSvc.apiBase = $('svc-base').value.trim();
  editingSvc.apiKey = $('svc-key').value.trim();
  editingSvc.model = $('svc-model').value.trim();
  if (!editingSvc.apiBase) { toast('API 地址不能为空'); return; }
  await api.saveService(editingSvc);
  closeEditor();
  loadServices();
  toast('服务已保存');
}
async function deleteService(id) {
  if (!confirm('确定删除该服务?')) return;
  await api.deleteService(id);
  loadServices();
  toast('已删除');
}
async function setActive(kind, id) {
  await api.setActiveService(kind, id);
  loadServices();
  toast(kind === 'image' ? '已设为画图服务' : '已设为提示词助手引擎');
}
async function fetchModels() {
  if (!editingSvc) return;
  // 先暂存当前编辑内容再拉取
  editingSvc.apiBase = $('svc-base').value.trim();
  editingSvc.apiKey = $('svc-key').value.trim();
  if (!editingSvc.apiBase) { toast('请先填 API 地址'); return; }
  const btn = $('btn-fetch-models'); btn.disabled = true; $('svc-editor-result').textContent = '拉取模型列表中…';
  try {
    const r = await api.fetchModels(editingSvc);
    if (r.ok) {
      fillModelOptions('svc-model-list', r.models);
      $('svc-editor-result').textContent = '拉取到 ' + r.models.length + ' 个模型: ' + r.models.slice(0, 6).join(', ') + (r.models.length > 6 ? ' …' : '');
    } else {
      $('svc-editor-result').textContent = '拉取失败: ' + r.error;
    }
  } finally { btn.disabled = false; }
}
async function testEditing() {
  if (!editingSvc) return;
  editingSvc.name = $('svc-name').value.trim();
  editingSvc.kind = $('svc-kind').value;
  editingSvc.apiBase = $('svc-base').value.trim();
  editingSvc.apiKey = $('svc-key').value.trim();
  editingSvc.model = $('svc-model').value.trim();
  if (!editingSvc.apiBase) { toast('请先填 API 地址'); return; }
  $('svc-editor-result').textContent = '测试连通中…';
  const r = await api.testService(editingSvc);
  $('svc-editor-result').textContent = r.ok ? ('✓ ' + r.detail) : ('✗ ' + r.error);
}

// ---------- 状态栏 ----------
async function refreshStatus() {
  const st = await api.getStatus();
  // AI 页模型下拉:跟随当前画图服务的模型列表
  if (Array.isArray(st.imageModels) && st.imageModels.length) {
    const cur = $('ai-model').value;
    fillModelOptions('ai-model', st.imageModels, false);
    if (st.imageModels.includes(cur)) $('ai-model').value = cur;
  }
  if (st.currentPath) {
    $('preview').src = encodeURI('file:///' + st.currentPath.replace(/\\/g, '/')) + '?t=' + Date.now();
  }
  // 优先展示回执信息(新旧脚本动作统一走 wallpaper_meta.json)
  const meta = st.scriptMeta;
  if (meta && meta.time) {
    const who = meta.source === 'script' ? '旧脚本' : (meta.source === 'app' ? '软件' : meta.source);
    if (meta.source === 'app' && meta.prompt) {
      // AI 随机生成的图:展示这张图的提示词(截断)
      const p = meta.prompt.length > 96 ? meta.prompt.slice(0, 96) + '…' : meta.prompt;
      $('hero-title').textContent = 'AI 随机壁纸 · ' + (meta.randomMode === 'portrait' ? '人物' : meta.randomMode === 'scenery' ? '风景' : '随机');
      $('hero-sub').textContent = who + ' · ' + meta.time + ' · 提示词: ' + p;
    } else {
      const desc = meta.title ? (meta.title + (meta.author ? ' / ' + meta.author : '') + (meta.pid ? ' / pid:' + meta.pid : '')) : (meta.tag || '');
      $('hero-title').textContent = desc || '当前壁纸';
      $('hero-sub').textContent = (who ? who + ' 于 ' + meta.time + ' 更新' : '') + (meta.tag ? ' · 标签: ' + meta.tag : '');
    }
  } else {
    const info = st.lastInfo || '';
    if (info) {
      $('hero-title').textContent = info.split(' · ')[0] || '当前壁纸';
      $('hero-sub').textContent = info;
    }
  }
  $('status-text').textContent = st.sourceLabel + (meta && meta.time ? ' · 上次动作: ' + (meta.source === 'script' ? '旧脚本' : '软件') + ' ' + meta.time : (st.lastInfo ? ' · 上次: ' + st.lastInfo : ''));
  $('status-right').textContent = (st.oldTaskRunning ? '旧任务运行中 · ' : '') + (st.nextRun ? '下次自动换图 ' + st.nextRun : '自动换图已关闭');
}

// ---------- 代理探测 ----------
async function detectProxy() {
  $('proxy-detect-result').textContent = '探测常见端口中(7897/7890/10809…)…';
  const r = await api.detectProxy();
  if (r.found.length) {
    $('proxy-detect-result').textContent = '✓ 发现代理: ' + r.found.join(', ');
    $('proxy-url').value = r.found[0];
    await api.saveConfig('proxy.url', r.found[0]);
    toast('已自动填入 ' + r.found[0] + ',记得打开「启用代理」开关');
  } else {
    $('proxy-detect-result').textContent = '✗ 未发现常见代理端口,请确认代理软件已运行';
  }
}

// ---------- 旧脚本联动 ----------
// 主进程监听到壁纸目录文件变化(旧脚本换图/归档)时推送此事件
api.onUiRefresh(async (reason) => {
  await refreshStatus();
  // 只有真正来自外部(旧脚本等)的写入才提示,本程序自身写入不打扰用户
  if (reason === 'external') {
    toast('检测到旧脚本更换了壁纸,已同步', 2200);
  }
});

// 设置页旧任务徽章
async function refreshOldTaskBadge() {
  const st = await api.queryOldTask();
  const el = $('old-task-status');
  if (!el) return;
  el.textContent = st.exists ? (st.enabled ? '⚠ 旧任务启用中(每30分钟会换图)' : '已停用 ✓') : '未找到(可能已删除)';
}

const _origLoadConfig = loadConfig;
window.addEventListener('DOMContentLoaded', async () => {
  await _origLoadConfig();
  refreshOldTaskBadge();
});
