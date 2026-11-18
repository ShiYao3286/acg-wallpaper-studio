// core.js:全局基础($/导航/事件委托/动作映射表)。自 renderer.js 逐行迁出(阶段4 UI 重构批1)。
// 经典 <script> 顺序加载:顶层 let/const/function 进入全局词法环境,后续脚本可见。

// 渲染进程逻辑 v1.3.1
// 版本号需与 package.json 保持一致，后续应由主进程注入
const $ = id => document.getElementById(id);

// ---------- 导航 ----------
// 5 入口:舞台 / AI 创作 / 图库 / 插件中心 / 设置。
// 舞台不是 .page,而是 #view-stage 三件套(舞台/缩略带/命令条),与功能页互斥。
document.querySelectorAll('.ri[data-page]').forEach(el => {
  el.addEventListener('click', () => {
    const page = el.dataset.page;
    document.querySelectorAll('.ri[data-page]').forEach(n => n.classList.remove('on'));
    el.classList.add('on');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
    const stageView = $('view-stage');
    if (stageView) stageView.classList.toggle('off', page !== 'stage');
    if (page === 'stage') {
      // refreshStage 由 stage.js 提供;core.js 先加载,点击时它已就绪
      if (typeof refreshStage === 'function') refreshStage();
    } else {
      const target = $('page-' + page);
      if (target) target.classList.add('on');
    }
    if (page === 'library') { loadHistory(); loadFavorites(); }
    // 「模型」页接管了原来的账号/服务/模型配置;插件页只管插件本身
    if (page === 'models') { loadServices(); refreshDoubao(); refreshStatus(); }
    if (page === 'plugins') { loadPluginList(); }
    if (page === 'creation') { loadPresets(); refreshAssistEngine(); }
  });
});

// 图片库页内 tab(历史/收藏)。收藏变化后由 loadFavorites 主动刷新,无需监听。
function switchLibTab(tab) {
  document.querySelectorAll('#lib-seg button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('lib-history').style.display = tab === 'history' ? '' : 'none';
  $('lib-favorites').style.display = tab === 'favorites' ? '' : 'none';
  if (tab === 'history') loadHistory(); else loadFavorites();
}

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
  'win-maximize': () => api.win.maximize(),
  'open-log-dir': () => api.openLogDir().then((r) => {
    if (r && r.ok === false) toast('打开日志目录失败: ' + (r.error || '未知错误'), 4000);
  }).catch((e) => toast('打开日志目录失败: ' + ((e && e.message) || e), 4000)),
  'fav-current': () => favCurrent(),
  'change-now': () => changeNow(),
  'open-folder': () => openFolder(),
  'add-tag': () => addTag(),
  'run-assist': () => runAssist(),
  'ai-now': () => aiNow(),
  'lib-tab': (el) => switchLibTab(el.dataset.tab),
  // 阶段4 生成预览流
  // 生成预览流已下线(生成结果直接进图库):预览卡上的三个动作不再存在
  'new-service': (el) => newService(el && el.dataset.kind),
  // 从创作页/舞台跳去「模型」页配置引擎
  'goto-models': () => {
    const b = document.querySelector('.ri[data-page="models"]');
    if (b) b.click();
  },
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
  // 舞台命令条(实现放 js/pages/stage.js)
  'cmd-source': () => cmdToggleSource(),
  'cmd-loop': () => cmdToggleLoop(),
  'cmd-game': () => cmdToggleGame(),
  'cmd-next': () => cmdGotoSettings(),
  'goto-favorites': () => {
    document.querySelector('.ri[data-page="library"]').click();
    switchLibTab('favorites');
  },
  // 阶段3 豆包
  'doubao-login': () => doubaoLogin(),
  'doubao-relogin': () => doubaoLogin(),
  'doubao-cancel-login': () => api.doubao.cancelLogin().then(() => refreshDoubao()).catch(() => {}),
  'doubao-logout': () => doubaoLogout(),
  'doubao-new-session': () => doubaoNewSession(),
  'doubao-bind-session': () => doubaoBindSession(),
  'doubao-conv-list': () => doubaoConvList(),
  'doubao-conv-bind': () => doubaoConvBind(),
  'doubao-accept-risk': () => doubaoAcceptRisk(),
  'doubao-decline-risk': () => doubaoDeclineRisk(),
  'doubao-test-text': () => doubaoTestText(),
  'doubao-test-image': () => doubaoTestImage(),
};

// 模型下拉变更即保存(不需要额外按钮)
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!t) return;
  // 豆包模型下拉走自定义保存(要同时写模型与推理强度)
  if (t.id === 'doubao-model-select' || t.id === 'doubao-effort-select') {
    saveDoubaoModel();
    return;
  }
}, true);

// change 类:key 来自 data-key,值来自元素自身
const CHANGE_SETTERS = {
  str: (el, opts) => saveStr(el.dataset.key, el.value, opts),
  num: (el) => saveNum(el.dataset.key, el.value),
};

// Enter 键委托(阶段4 UI 重构):替代 2 处内联 onkeydown,与 data-act 映射表对接
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const el = ev.target.closest('[data-enter]');
  if (!el) return;
  const fn = CLICK_ACTIONS[el.dataset.enter];
  if (fn) { ev.preventDefault(); fn(el); }
});

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

// textarea 原来只在 change(失焦)时保存:打完字直接关窗口/退托盘就丢。
// 这里补一条 input 防抖(停手 800ms 就写),与 change 不冲突(值相同时重复写无害)。
const __draftTimers = new Map();
document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!el || el.tagName !== 'TEXTAREA') return;
  const holder = el.closest('[data-set]');
  if (!holder) return;
  const kind = holder.dataset.set;
  clearTimeout(__draftTimers.get(holder));
  __draftTimers.set(holder, setTimeout(() => {
    __draftTimers.delete(holder);
    if (kind === 'game-procs') { saveGameProcs(holder.value, { silent: true }); return; }
    const fn = CHANGE_SETTERS[kind];
    if (fn) fn(holder, { silent: true });
  }, 800));
});

// ---------- 豆包账号(阶段3 3.6) ----------
//
// 渲染层只拿状态字符串与时间戳。Cookie 永远不出主进程。
// 状态区分刻意做细:未登录/登录中/已登录/需重新登录/服务端限制/协议异常,
// 不用一个"已连接"掩盖所有问题。
