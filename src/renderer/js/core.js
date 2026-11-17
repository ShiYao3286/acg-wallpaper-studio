// core.js:全局基础($/导航/事件委托/动作映射表)。自 renderer.js 逐行迁出(阶段4 UI 重构批1)。
// 经典 <script> 顺序加载:顶层 let/const/function 进入全局词法环境,后续脚本可见。

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
    if (el.dataset.page === 'services') { loadServices(); refreshDoubao(); }
    if (el.dataset.page === 'ai') loadPresets();
  });
});

// ---------- 事件委托(阶段2:替代内联 onclick/onchange,以便启用 CSP) ----------
// 原先 index.html 里有 38 处内联事件(29 onclick + 9 onchange),内联处理器无法与
// script-src 'self' 共存。这里统一改为 data-act / data-set 声明 + 单点委托。
// 用映射表而不是 eval/new Function:既不引入动态代码执行,也让 "有哪些动作" 一目了然。
//
// data-act="...":点击类动作,可带 data-key / data-src / data-mode / data-delta
// data-set="str|num":change 类动作,直接写配置项
// 注意:data-set="game-procs" 是特例(需要传整个文本框值给 saveGameProcs)

const CLICK_ACTIONS = {
  'win-minimize': () => api.win.minimize(),
  'win-close': () => api.win.close(),
  'fav-current': () => favCurrent(),
  'change-now': () => changeNow(),
  'open-folder': () => openFolder(),
  'add-tag': () => addTag(),
  'run-assist': () => runAssist(),
  'ai-now': () => aiNow(),
  // 阶段4 生成预览流
  'ai-apply-now': () => aiApplyNow(),
  'ai-regen': () => aiRegen(),
  'ai-discard-now': () => aiDiscardNow(),
  'new-service': () => newService(),
  'fetch-models': () => fetchModels(),
  'save-service': () => saveService(),
  'test-editing': () => testEditing(),
  'close-editor': () => closeEditor(),
  'detect-proxy': () => detectProxy(),
  'disable-old-task': () => disableOldTask(),
  'toggle': (el) => toggleSwitch(el, el.dataset.key),
  'toggle-autorun': (el) => toggleAutoRun(el),
  'set-source': (el) => setSource(el.dataset.src),
  'set-mode': (el) => setRandomMode(el.dataset.mode),
  'step-interval': (el) => stepInterval(Number(el.dataset.delta)),
  'roll-preview': (el) => rollPreview(el),
  // 阶段3 豆包
  'doubao-login': () => doubaoLogin(),
  'doubao-relogin': () => doubaoLogin(),
  'doubao-cancel-login': () => api.doubao.cancelLogin().then(() => refreshDoubao()).catch(() => {}),
  'doubao-logout': () => doubaoLogout(),
  'doubao-new-session': () => doubaoNewSession(),
  'doubao-accept-risk': () => doubaoAcceptRisk(),
  'doubao-decline-risk': () => doubaoDeclineRisk(),
  'doubao-test-text': () => doubaoTestText(),
  'doubao-test-image': () => doubaoTestImage(),
};

// 模型下拉变更即保存(不需要额外按钮)
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!t) return;
  if (t.id === 'doubao-model-select' || t.id === 'doubao-effort-select') {
    saveDoubaoModel();
    return;
  }
  // AI 页模型下拉改为自定义处理(需要区分 doubao / svc: 两种值)
  if (t.id === 'ai-model') {
    ev.stopPropagation();
    onAiModelChange();
  }
}, true);

// change 类:key 来自 data-key,值来自元素自身
const CHANGE_SETTERS = {
  str: (el) => saveStr(el.dataset.key, el.value),
  num: (el) => saveNum(el.dataset.key, el.value),
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = CLICK_ACTIONS[el.dataset.act];
  if (!fn) {
    // 未知动作说明 HTML 与 JS 脱节,提示出来而不是静默失败
    console.warn('未注册的 data-act:', el.dataset.act);
    return;
  }
  fn(el);
});

document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-set]');
  if (!el) return;
  const kind = el.dataset.set;
  // 特例:游戏进程列表需要整段文本,单独处理
  if (kind === 'game-procs') { saveGameProcs(el.value); return; }
  const fn = CHANGE_SETTERS[kind];
  if (!fn) {
    console.warn('未注册的 data-set:', kind);
    return;
  }
  fn(el);
});

// ---------- 豆包账号(阶段3 3.6) ----------
//
// 渲染层只拿状态字符串与时间戳。Cookie 永远不出主进程。
// 状态区分刻意做细:未登录/登录中/已登录/需重新登录/服务端限制/协议异常,
// 不用一个"已连接"掩盖所有问题。
