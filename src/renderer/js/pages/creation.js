// creation.js:提示词预设/随机模式/助手(AI 创作页)。自 renderer.js 逐行迁出。

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
  let p;
  try {
    const cfg = await api.getConfig();
    p = (cfg.promptPresets || []).find(x => x.id === id);
  } catch (e) {
    toast('套用预设失败: ' + ((e && e.message) || '读取配置异常'), 4000);
    return;
  }
  if (!p) return;
  // 先保存成功再改界面与提示,避免"界面变了但配置没落盘"
  try {
    const r = await api.saveConfig('ai.prompt', p.prompt);
    if (r && r.ok === false) { toast('套用预设失败: ' + (r.error || '未知错误'), 4000); return; }
  } catch (e) {
    toast('套用预设失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
  $('ai-prompt').value = p.prompt;
  toast('已套用预设: ' + p.name);
}
async function saveAsPreset() {
  const name = prompt('预设名称:', '新预设');
  if (!name) return;
  try {
    const r = await api.savePreset({ id: 'preset-' + Date.now(), name, prompt: $('ai-prompt').value });
    if (!r || r.ok === false) { toast('预设保存失败: ' + ((r && r.error) || '未知错误'), 4000); return; }
  } catch (e) {
    toast('预设保存失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
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
