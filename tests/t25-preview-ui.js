// 第二十五部分:AI 生成预览流——渲染层行为(阶段4 批3)
//   用迷你 DOM 桩直接执行真实 renderer.js:验证 previewMode 分流、
//   预览卡片显隐、taskId 关联动作、CSP/事件委托完整性。
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { group, ok, summarize } = require('./common');

const ROOT = path.resolve(__dirname, '..');
// 阶段4 UI 重构:renderer.js 拆分为 js/ 多文件(经典 script 顺序加载)。
// 测试按浏览器同等的加载顺序拼接执行 —— 与真实运行时全局词法环境等价。
// (文件名 → 实际路径:页面级四件在 js/pages/)
const JS_ORDER = [
  ['core.js', 'js'], ['ui.js', 'js'], ['doubao.js', 'js'], ['tags.js', 'js'],
  ['settings-shared.js', 'js'], ['services.js', 'js/pages'], ['library.js', 'js/pages'],
  ['creation.js', 'js/pages'], ['workbench.js', 'js/pages'], ['config.js', 'js'],
  ['status.js', 'js'], ['boot.js', 'js'],
];
const JS_SRC = JS_ORDER.map(([f, dir]) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', dir, f), 'utf8')).join('\n;\n');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');

// ---------- 迷你 DOM 桩 ----------
function makeEl(id) {
  const listeners = {};
  const el = {
    id: id || '', dataset: {}, style: {}, classList: { _s: new Set(),
      contains(c) { return this._s.has(c); },
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, force) { const has = this._s.has(c); const want = force === undefined ? !has : !!force; if (want) this._s.add(c); else this._s.delete(c); return want; } },
    value: '', textContent: '', src: '', disabled: false,
    appendChild() {}, addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    closest() { return null; },
    setAttribute(k, v) { this['attr_' + k] = String(v); },
    getAttribute(k) { return this['attr_' + k] === undefined ? null : this['attr_' + k]; },
    remove() {},
    click() { (listeners['click'] || []).forEach(fn => fn({ target: this, stopPropagation() {} })); },
    focus() {},
    getAttribute(k) { return this['attr_' + k] === undefined ? null : this['attr_' + k]; },
    scrollIntoView() {},
    __listeners: listeners,
  };
  return el;
}

function buildDom() {
  const ids = ['preview', 'hero-title', 'hero-sub', 'page-history', 'page-favorites', 'page-services',
    'page-ai', 'page-settings', 'page-desktop', 'page-plugins', 'page-tags',
    'ai-preview-card', 'ai-preview-img', 'ai-preview-meta',
    'btn-ai', 'btn-apply', 'btn-regen', 'btn-discard', 'sw-preview',
    'preset-list', 'assist-engine', 'assist-theme', 'btn-assist',
    'ai-prompt', 'ai-model', 'ai-size', 'random-prompt-preview', 'random-preview-area', 'custom-prompt-area',
    'ai-mode-hint', 'sw-schedule', 'sw-game', 'sw-excludeai', 'interval', 'lolicon-size', 'lolicon-r18',
    'hist-keep', 'game-procs', 'seg-lolicon', 'seg-ai', 'sw-autorun', 'sw-proxy', 'proxy-url',
    'doubao-model-select', 'doubao-effort-select', 'doubao-models', 'doubao-model-hint',
    'doubao-state', 'doubao-session', 'doubao-risk-box',
    'old-task-badge', 'preset-name', 'preset-prompt',
    'svc-list', 'svc-name', 'svc-base', 'svc-key', 'svc-model', 'svc-kind',
    'tag-input', 'tag-list', 'hist-list', 'fav-list', 'status-line', 'read-errors',
    'test-result', 'img-models', 'txt-models', 'status-text', 'doubao-model-hint2', 'sw-preview2'];
  const map = {};
  for (const id of ids) map[id] = makeEl(id);
  return map;
}

// 构造一个执行了真实 renderer.js 的沙箱
async function bootRenderer({ previewMode }) {
  const dom = buildDom();
  const documentStub = {
    getElementById: (id) => { if (!dom[id]) { dom[id] = makeEl(id); } return dom[id]; },
    querySelectorAll: () => [],
    querySelector: () => makeEl('q'),
    addEventListener: (t, fn) => { docListeners[t] = fn; },
    createElement: () => makeEl(''),
    createElementNS: () => makeEl(''),
    createTextNode: () => ({ textContent: '' }),
  };
  const docListeners = {};
  const winListeners = {};
  const apiCalls = [];
  const cfg = {
    source: 'ai', schedule: { enabled: true, intervalMinutes: 30 },
    lolicon: { excludeAI: true, size: 'regular', r18: 0, tags: [], proxy: 'i.pixiv.re' },
    ai: { prompt: '测试', size: '1024x1024', randomMode: 'custom', imageEngine: 'service', previewMode: !!previewMode },
    history: { keepCount: 30 }, gameCheck: { enabled: true, processes: [] },
    proxy: { enabled: false, url: '' }, services: [], activeImageService: '', activeTextService: '',
    promptPresets: [], doubao: { textModel: '0', reasoningEffort: 5 },
  };
  const api = {
    getConfig: async () => { apiCalls.push('getConfig'); return cfg; },
    saveConfig: async (k, v) => { apiCalls.push('saveConfig:' + k); return { ok: true }; },
    getStatus: async () => { apiCalls.push('getStatus'); return { lastInfo: '', currentPath: null, scriptMeta: null, readErrors: {}, imageModels: [], imageModelsError: '', sourceLabel: '', task: { current: null, recent: [] }, pending: { exists: false } }; },
    getAutoRun: async () => false,
    changeWallpaper: async (reason) => { apiCalls.push('changeWallpaper:' + reason); return { ok: true }; },
    aiGenerate: async (p) => { apiCalls.push('aiGenerate'); return { ok: true, taskId: 'tid-1', prompt: '测试', bytes: 123456, imageVersion: 111, pendingPath: 'C:\\fake\\pending', engine: 'service' }; },
    aiApply: async (id) => { apiCalls.push('aiApply:' + id); return { ok: true }; },
    aiDiscard: async (id) => { apiCalls.push('aiDiscard:' + id); return { ok: true, discarded: true }; },
    aiPendingGet: async () => { apiCalls.push('aiPendingGet'); return { ok: true, exists: false }; },
    listServices: async () => { apiCalls.push('listServices'); return [{ id: 'svc-1', kind: 'image', name: 'stub', apiBase: 'https://stub', apiKey: 'k', model: 'm' }]; },
    doubao: { status: async () => ({ state: 'idle' }), models: async () => ({ ok: true, models: [], text: [] }), sessionStatus: async () => ({ hasLiveBinding: false }), riskAccepted: async () => ({ accepted: false }) },
    onUiRefresh: (fn) => { apiCalls.push('onUiRefresh'); },
    listHistory: async () => [], listFavorites: async () => [],
    rollRandomPrompt: async () => ({ ok: true, prompt: '' }),
    aiAssistPrompt: async () => ({ ok: true, prompt: '' }),
    addTag: async () => ({ ok: true }), removeTag: async () => ({ ok: true }),
    savePreset: async () => ({ ok: true }),
    saveService: async () => ({ ok: true }), deleteService: async () => ({ ok: true }),
    setActiveService: async () => ({ ok: true }), testService: async () => ({ ok: true }),
    fetchModels: async () => ({ ok: true, models: [] }),
    deleteFavorite: async () => ({ ok: true }), useHistory: async () => ({ ok: true }),
    queryOldTask: async () => ({ running: false }), disableOldTask: async () => ({ ok: true }),
    detectProxy: async () => ({ ok: true, port: null }),
    setAutoRun: async () => ({ ok: true }),
    openWallpaperDir: () => {}, win: { minimize() {}, close() {} },
  };
  const sandbox = {
    document: documentStub,
    window: { addEventListener: (t, fn) => { winListeners[t] = fn; } },
    api,
    confirm: async () => true,
    toast: undefined,  // renderer.js 内部定义
    console, setTimeout, clearTimeout, Date, Math, JSON, Promise,
    AbortSignal: { timeout: () => undefined },
    SVG_NS: 'http://www.w3.org/2000/svg',
  };
  vm.createContext(sandbox);
  vm.runInContext(JS_SRC, sandbox, { filename: 'renderer.js' });
  // 触发 DOMContentLoaded(renderer.js 的启动序列)
  if (winListeners['DOMContentLoaded']) await winListeners['DOMContentLoaded']();
  return { dom, apiCalls, docListeners, cfg, api };
}

(async () => {
  group('A previewMode=false 原路径不受影响');
  {
    const env = await bootRenderer({ previewMode: false });
    // 模拟点击 btn-ai:aiNow 不经数据集定位,直接调用导出前的内部函数不可行,
    // 改走事件委托路径:simulate data-act=ai-now
    // aiNow 内部先 getConfig(引导检查) 再分支
    env.dom['btn-ai'].dataset.act = 'ai-now';
    // 直接调用委托处理器
    await env.docListeners['click']({ target: { closest: () => env.dom['btn-ai'] } });
    // 等待异步链完成
    await new Promise(r => setTimeout(r, 50));
    ok('A1', 'previewMode=false 时走 changeWallpaper 直应用', env.apiCalls.includes('changeWallpaper:ai'), env.apiCalls.join(','));
    ok('A2', '原路径不调用 aiGenerate', !env.apiCalls.includes('aiGenerate'), '');
  }

  group('B previewMode=true 走预览流');
  {
    const env = await bootRenderer({ previewMode: true });
    env.dom['btn-ai'].dataset.act = 'ai-now';
    await env.docListeners['click']({ target: { closest: () => env.dom['btn-ai'] } });
    await new Promise(r => setTimeout(r, 50));
    ok('B1', 'previewMode=true 时调用 aiGenerate', env.apiCalls.includes('aiGenerate'), env.apiCalls.join(','));
    ok('B2', '预览路径不直接 changeWallpaper', !env.apiCalls.some(c => c.startsWith('changeWallpaper')), env.apiCalls.join(','));
    ok('B3', '预览卡片显示', env.dom['ai-preview-card'].style.display === '', 'display=' + JSON.stringify(env.dom['ai-preview-card'].style.display));
    const srcB = env.dom['ai-preview-img'].src;
    ok('B4', '预览图 src 为 file:// 绝对路径且带缓存参数,无反斜杠', srcB.startsWith('file:///') && /\?v=111$/.test(srcB) && !srcB.includes('\\'), srcB);
    ok('B5', '预览元信息含引擎与大小', /API 服务/.test(env.dom['ai-preview-meta'].textContent) && /121KB/.test(env.dom['ai-preview-meta'].textContent), env.dom['ai-preview-meta'].textContent);

    // 应用动作:委托 data-act=ai-apply-now
    env.dom['btn-apply'].dataset.act = 'ai-apply-now';
    const n0 = env.apiCalls.length;
    await env.docListeners['click']({ target: { closest: () => env.dom['btn-apply'] } });
    await new Promise(r => setTimeout(r, 50));
    ok('B6', '应用动作带 taskId 调 aiApply', env.apiCalls.slice(n0).some(c => c === 'aiApply:tid-1'), env.apiCalls.slice(n0).join(','));
    ok('B7', '应用成功后卡片收起', env.dom['ai-preview-card'].style.display === 'none', '');
  }

  group('C 失败分支与放棄');
  {
    const env = await bootRenderer({ previewMode: true });
    // 生成失败场景
    env.api.aiGenerate = async () => ({ ok: false, error: '生成失败测试' });
    env.dom['btn-ai'].dataset.act = 'ai-now';
    await env.docListeners['click']({ target: { closest: () => env.dom['btn-ai'] } });
    await new Promise(r => setTimeout(r, 50));
    ok('C1', '生成失败时卡片不显示', env.dom['ai-preview-card'].style.display === 'none', '');

    // 放弃动作
    env.api.aiGenerate = async () => ({ ok: true, taskId: 'tid-2', bytes: 1000, imageVersion: 222, pendingPath: 'C:\\fake\\pending', engine: 'service' });
    await env.docListeners['click']({ target: { closest: () => env.dom['btn-ai'] } });
    await new Promise(r => setTimeout(r, 50));
    env.dom['btn-discard'].dataset.act = 'ai-discard-now';
    await env.docListeners['click']({ target: { closest: () => env.dom['btn-discard'] } });
    await new Promise(r => setTimeout(r, 50));
    ok('C2', '放弃动作调 aiDiscard 且带 taskId', env.apiCalls.some(c => c === 'aiDiscard:tid-2'), env.apiCalls.filter(c => c.startsWith('aiDiscard')).join(','));
    ok('C3', '放弃后卡片收起', env.dom['ai-preview-card'].style.display === 'none', '');
  }

  group('D HTML/JS 结构一致性');
  {
    const htmlActs = [...new Set([...HTML_SRC.matchAll(/data-act="([^"]+)"/g)].map(x => x[1]))];
    const mapKeys = [...JS_SRC.matchAll(/^\s{2}'([a-z-]+)':/gm)].map(x => x[1]);
    const missing = htmlActs.filter(a => mapKeys.indexOf(a) < 0);
    ok('D1', '新增 data-act 均有实现', missing.length === 0, missing.length ? '缺失 ' + missing.join(',') : htmlActs.length + ' 个动作全部有实现');
    ok('D2', '预览卡片与三按钮存在于 HTML', HTML_SRC.includes('id="ai-preview-card"') && HTML_SRC.includes('id="btn-apply"') && HTML_SRC.includes('id="btn-regen"') && HTML_SRC.includes('id="btn-discard"'), '');
    ok('D3', '预览开关绑定 ai.previewMode', HTML_SRC.includes('data-key="ai.previewMode"'), '');
    ok('D4', '预览相关处理器在 renderer.js', ['aiApplyNow', 'aiRegen', 'aiDiscardNow', 'showPreview', 'hidePreview'].every(n => new RegExp('function ' + n).test(JS_SRC)), '');
    const assigns = [...JS_SRC.matchAll(/innerHTML\s*=\s*([^;\n]+)/g)].map(x => x[1].trim());
    const dangerous = assigns.filter(v => v !== "''" && v !== '""');
    ok('D5', '无 innerHTML 注入新增(仅清空赋值)', dangerous.length === 0, dangerous.length ? '可疑: ' + dangerous.join(' | ') : assigns.length + ' 处赋值全部为清空语义');
  }

  const sum = summarize();
  console.log('---- 第二十五部分小结: ' + sum.passed + '/' + sum.total + ' 通过, ' + sum.failed + ' 失败');
  process.exit(sum.failed ? 1 : 0);
})().catch(e => { console.error('[FATAL]', e && e.stack || e); process.exit(1); });