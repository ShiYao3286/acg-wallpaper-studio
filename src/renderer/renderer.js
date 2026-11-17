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

let doubaoRiskAccepted = false;
let doubaoState = null;

// 模型选择:全部列出,但只允许选 available 的。
// 工作任务模型列出来是让用户知道豆包有什么,不是给他用的 ——
// 选中后服务端会让那一轮变成工作任务并尝试调用本地工具执行器,本项目不接这个能力。
async function refreshDoubaoModels() {
  const sel = $('doubao-model-select');
  const eff = $('doubao-effort-select');
  const hint = $('doubao-model-hint');
  const box = $('doubao-models');
  if (!sel || !box) return;
  try {
    const m = await api.doubao.models();
    sel.textContent = '';
    for (const item of m.models) {
      const opt = document.createElement('option');
      opt.value = item.key;
      opt.textContent = item.name
        + (item.taskMode ? ' [工作任务]' : '')
        + (item.available ? '' : ' — 不可选');
      // 不可用的置灰并禁用,但仍展示(选 B 方案)
      if (!item.available) { opt.disabled = true; opt.style.color = '#6b7280'; }
      sel.appendChild(opt);
    }
    sel.value = m.current;

    // 推理强度:仅对支持思考的模型有意义,但不隐藏(用户可能切换模型)
    if (eff) {
      eff.textContent = '';
      for (const lv of m.effortLevels) {
        const o = document.createElement('option');
        o.value = String(lv.level);
        o.textContent = lv.name;
        eff.appendChild(o);
      }
      eff.value = String(m.reasoningEffort || 5);
    }

    // 提示:生图模型不可选(服务端路由)
    if (hint) {
      hint.textContent = '画图:' + m.imageModel.name + '。生图不走模型选择,由豆包服务端按账号权益路由。';
    }
    box.style.display = '';
  } catch (e) {
    if (hint) hint.textContent = '读取模型列表失败: ' + ((e && e.message) || e);
  }
}

async function saveDoubaoModel() {
  const sel = $('doubao-model-select');
  const eff = $('doubao-effort-select');
  if (!sel) return;
  try {
    const r = await api.doubao.setModel(sel.value, Number(eff ? eff.value : 5));
    if (r && r.ok) {
      toast('已切换模型: ' + sel.options[sel.selectedIndex].textContent, 3000);
    } else {
      toast('切换失败: ' + ((r && r.error) || '未知'), 4000);
    }
  } catch (e) {
    toast('切换失败: ' + ((e && e.message) || e), 3200);
  }
}

// 状态 → 人话 + 颜色。
function doubaoStateText(st) {
  if (!st) return { text: '正在读取状态…', color: '' };
  switch (st.state) {
    case 'idle':
      return { text: '未登录。点击「扫码登录豆包」开始。', color: '' };
    case 'opening':
      return { text: '正在打开登录窗口…', color: '' };
    case 'awaiting_scan':
      return { text: '等待扫码中…请在豆包窗口里完成登录(5 分钟内有效)', color: '' };
    case 'authenticated':
      return { text: '已登录' + (st.savedAt ? '(' + new Date(st.savedAt).toLocaleString('zh-CN', { hour12: false }) + ' 登录)' : ''), color: '#4ade80' };
    case 'expired':
      return { text: '登录已过期,需要重新扫码登录。' + (st.lastError || ''), color: '#fbbf24' };
    case 'cancelled':
      return { text: '已取消登录。', color: '' };
    case 'error':
      return { text: '登录出错: ' + (st.lastError || '未知原因'), color: '#f87171' };
    default:
      return { text: '状态未知: ' + st.state, color: '' };
  }
}

// 渲染按钮组。按状态决定能做什么,避免点了没反应。
//
// riskAccepted 参与判断的原因(阶段3 审核问题):
//   - 消耗额度的按钮和"发起新登录"必须要求风险已确认;
//   - 但"退出账号""取消登录"是止损操作,任何时候都必须给得出来,
//     否则已登录用户重启后被锁在账号里出不去。
function doubaoButtons(st, riskAccepted) {
  const btns = [];
  const S = st ? st.state : 'idle';
  const risk = !!riskAccepted;
  if (S === 'authenticated') {
    if (risk) {
      btns.push({ act: 'doubao-test-text', label: '测试文本(消耗额度)' });
      btns.push({ act: 'doubao-test-image', label: '测试生图(消耗额度)' });
    }
    // 退出账号:永远显示。它是止损路径,不能被风险确认状态挡住。
    btns.push({ act: 'doubao-logout', label: '退出账号', ghost: true });
    // 重新登录要开新窗口,属于"发起登录",需要风险确认
    if (risk) btns.push({ act: 'doubao-relogin', label: '重新登录', ghost: true });
  } else if (S === 'awaiting_scan' || S === 'opening') {
    // 取消登录:永远显示,同样是止损路径
    btns.push({ act: 'doubao-cancel-login', label: '取消登录', ghost: true });
  } else {
    // 新登录入口:必须风险已确认
    if (risk) btns.push({ act: 'doubao-login', label: '扫码登录豆包' });
  }
  return btns;
}

async function refreshDoubao() {
  try {
    const st = await api.doubao.status();
    doubaoState = st;
    const box = $('doubao-status-text');
    if (!box) return;
    const info = doubaoStateText(st);
    box.textContent = info.text;
    box.style.color = info.color || '';

    // safeStorage 不可用要明确告知:这种情况下无法保存凭据
    if (st.encryptionAvailable === false) {
      box.textContent += ' 【系统安全存储不可用,无法保存登录凭据】';
      box.style.color = '#f87171';
    }

    // 风险确认状态要在渲染按钮【之前】拿到:
    // 按钮组本身就要靠它决定显示哪些按钮,顺序反了会先渲染出登录入口再隐藏,
    // 视觉上有闪烁,逻辑上也会让"已登录未确认"这一态短暂出现错误按钮。
    try {
      const r = await api.doubao.riskAccepted();
      doubaoRiskAccepted = !!(r && r.accepted);
    } catch { doubaoRiskAccepted = false; }

    const act = $('doubao-actions');
    if (act) {
      act.textContent = '';
      for (const b of doubaoButtons(st, doubaoRiskAccepted)) {
        const btn = document.createElement('button');
        btn.className = 'btn small' + (b.ghost ? ' ghost' : '');
        btn.textContent = b.label;
        btn.dataset.act = b.act;
        act.appendChild(btn);
      }
    }

    const risk = $('doubao-risk');
    if (risk) {
      risk.style.display = (!doubaoRiskAccepted && st.state !== 'authenticated') ? 'block' : 'none';
    }

    // 操作区可见性。
    //
    // 阶段3 审核发现的 bug:旧实现是
    //   if (!doubaoRiskAccepted) act.style.display = 'none';
    // 而 hasAcceptedDoubaoRisk 每次启动都重置为 false,于是
    // "重启 → authManager.restore() 恢复成 authenticated → 风险提示隐藏
    //   → 操作区也被隐藏" 三者叠加,已登录用户看不到【退出账号】按钮,
    // 只能去删配置文件,等于把账号锁死在应用里。
    //
    // 正确语义:风险确认只该拦住"发起新登录"和"消耗额度",
    // 不该拦住退出账号、取消登录这类【必要的管理/止损操作】。
    // 已登录时即使风险未确认,也必须给得出退出账号。
    //
    // 这里只改显示判断,【不】把 doubaoRiskAccepted 自动置 true ——
    // 那等于伪造用户确认,是更严重的错误。
    if (act) {
      const needsManageAction = (st.state === 'authenticated' || st.state === 'awaiting_scan' || st.state === 'opening');
      act.style.display = (doubaoRiskAccepted || needsManageAction) ? '' : 'none';
    }

    // 阶段3.9:工作会话状态行(不展示 conversationId)
    const sessBox = $('doubao-session');
    if (sessBox) {
      if (st.state === 'authenticated') {
        try {
          const ss = await api.doubao.sessionStatus();
          let text;
          if (ss.invalid) {
            text = '当前工作会话已失效。下一次请求将自动创建新会话，之前的上下文不会自动继承。';
            sessBox.style.color = '#fbbf24';
          } else if (ss.hasSession) {
            text = '工作会话进行中 · 自 ' + new Date(ss.createdAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' 起。连续对话会继承此前上下文，旧要求可能影响后续结果。';
            sessBox.style.color = '';
          } else {
            text = '尚未建立工作会话，下一次请求会自动创建。';
            sessBox.style.color = '';
          }
          sessBox.textContent = text;
          sessBox.style.display = '';
        } catch { sessBox.style.display = 'none'; }
      } else {
        sessBox.textContent = '';
        sessBox.style.display = 'none';
      }
    }

    // 模型选择区:仅登录后显示;未登录时没有意义
    const modelBox = $('doubao-models');
    if (modelBox) {
      if (st.state === 'authenticated') { await refreshDoubaoModels(); }
      else { modelBox.style.display = 'none'; }
    }
  } catch (e) {
    const box = $('doubao-status-text');
    if (box) box.textContent = '读取豆包状态失败: ' + ((e && e.message) || e);
  }
}

async function doubaoLogin() {
  if (!doubaoRiskAccepted) {
    toast('请先阅读并确认风险提示', 3200);
    return;
  }
  try {
    const r = await api.doubao.login();
    toast(r.ok ? '已打开登录窗口,请扫码' : ('登录启动失败: ' + (r.error || '')), 4000);
    refreshDoubao();
  } catch (e) {
    toast('登录启动失败: ' + ((e && e.message) || e), 4000);
  }
}

async function doubaoAcceptRisk() {
  try {
    const r = await api.doubao.acceptRisk(true);
    if (r && r.ok) {
      doubaoRiskAccepted = true;
      toast('已确认风险提示', 2600);
      refreshDoubao();
    }
  } catch (e) {
    toast('操作失败: ' + ((e && e.message) || e), 3200);
  }
}

function doubaoDeclineRisk() {
  const risk = $('doubao-risk');
  if (risk) risk.style.display = 'none';
  toast('已取消。未确认风险提示前不会启用豆包登录。', 3200);
}

async function doubaoTestText() {
  toast('正在请求豆包(会消耗少量额度)…', 6000);
  try {
    const r = await api.doubao.testText('你好，请只回复两个字：收到');
    if (r && r.ok) {
      toast('豆包回复: ' + String(r.text || '').slice(0, 40), 6000);
    } else {
      toast('失败: ' + ((r && r.error) || '未知'), 6000);
    }
    if (r && r.errorKind === 'AUTH_EXPIRED') {
      refreshDoubao();
    }
  } catch (e) {
    toast('请求失败: ' + ((e && e.message) || e), 5000);
  }
}

async function doubaoTestImage() {
  toast('正在生成测试图(会消耗一次生图额度,约 30-90 秒)…', 10000);
  try {
    const r = await api.doubao.testImage('一只白色的猫，坐姿，简洁背景，二次元风格');
    if (r && r.ok) {
      toast('生成成功: ' + r.width + 'x' + r.height + ' ' + String(r.format).toUpperCase() + ' ' + (r.bytes/1024).toFixed(0) + 'KB', 8000);
    } else {
      toast('生图失败: ' + ((r && r.error) || '未知'), 8000);
    }
    if (r && r.errorKind === 'AUTH_EXPIRED') refreshDoubao();
  } catch (e) {
    toast('生图请求失败: ' + ((e && e.message) || e), 6000);
  }
}

// 新建会话:确认提示明确告知"旧上下文不继承"(任务书 S4)。
async function doubaoNewSession() {
  if (!confirm('确定新建豆包工作会话吗？\n\n· 新会话不会继承当前对话的上下文。\n· 旧会话的记录仍保留在你的豆包账号中。')) return;
  try {
    const r = await api.doubao.newSession();
    toast(r && r.ok ? '已新建工作会话,下一次请求生效' : '新建会话失败: ' + ((r && r.error) || '未知'), 4000);
    refreshDoubao();
  } catch (e) {
    toast('新建会话失败: ' + ((e && e.message) || e), 4000);
  }
}

async function doubaoLogout() {
  try {
    const r = await api.doubao.logout();
    toast(r.ok ? '已退出豆包账号,凭据已删除' : ('退出失败: ' + (r.error || '')), 4000);
    refreshDoubao();
  } catch (e) {
    toast('退出失败: ' + ((e && e.message) || e), 3200);
  }
}

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
async function saveStr(key, val) {
  const r = await api.saveConfig(key, String(val));
  if (r && r.ok === false) { toast('保存失败: ' + (r.error || '未知错误'), 4000); return; }
  toast('已保存');
}
async function saveNum(key, val) {
  const r = await api.saveConfig(key, parseInt(val) || 0);
  if (r && r.ok === false) { toast('保存失败: ' + (r.error || '未知错误'), 4000); return; }
  toast('已保存');
}
async function toggleSwitch(el, key) {
  el.classList.toggle('on');
  const on = el.classList.contains('on');
  const r = await api.saveConfig(key, on);
  if (r && r.ok === false) {
    // 落盘失败时把开关拨回原状,避免界面状态与磁盘状态不一致
    el.classList.toggle('on', !on);
    toast('保存失败: ' + (r.error || '未知错误'), 4000);
    return;
  }
  toast('已保存');
}
async function setSource(src) {
  $('seg-lolicon').classList.toggle('on', src !== 'ai');
  $('seg-ai').classList.toggle('on', src === 'ai');
  const r = await api.saveConfig('source', src);
  if (r && r.ok === false) { toast('切换失败: ' + (r.error || '未知错误'), 4000); return; }
  toast('壁纸来源已切换: ' + (src === 'ai' ? 'AI 生图' : 'Lolicon 二次元图'));
  refreshStatus();
}
function stepInterval(d) {
  const el = $('interval');
  el.value = Math.min(720, Math.max(5, (parseInt(el.value) || 30) + d));
  saveNum('schedule.intervalMinutes', el.value);
}
async function saveGameProcs(txt) {
  // 落盘失败必须让用户看见:原实现丢弃返回值,失败也提示"已保存"
  const r = await api.saveConfig('gameCheck.processes', txt.split('\n').map(s => s.trim()).filter(Boolean));
  if (r && r.ok === false) { toast('保存失败: ' + (r.error || '未知错误'), 4000); return; }
  toast('已保存');
}
async function disableOldTask() {
  const r = await api.disableOldTask();
  $('old-task-status').textContent = r.ok ? '已停用 ✓' : ('失败: ' + r.error);
  toast(r.ok ? '旧计划任务已停用' : '停用失败:' + r.error);
}
async function toggleAutoRun(el) {
  el.classList.toggle('on');
  const want = el.classList.contains('on');
  // setAutoRun 现在会拒绝非布尔入参,也可能因系统调用失败返回 ok:false;
  // 两种情况下都不能让界面停在"看起来开启/关闭成功"的假状态,必须拨回原状。
  const r = await api.setAutoRun(want);
  const applied = (r && typeof r === 'object' && r.ok === false) ? null : r;
  if (applied === null) {
    el.classList.toggle('on', !want);
    toast('设置失败: ' + (r.error || '未知错误'), 4000);
    return;
  }
  // setAutoRun 成功时返回系统实际状态(bool);以系统返回值为准纠正界面
  if (typeof applied === 'boolean' && applied !== want) {
    el.classList.toggle('on', applied);
  }
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
  // 保存失败时保留输入框内容,方便用户重试;只有成功才清空并刷新列表
  try {
    const r = await api.addTag(v);
    if (r && r.ok === false) { toast('添加标签失败: ' + (r.error || '未知错误'), 4000); return; }
  } catch (e) {
    toast('添加标签失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
  $('tag-input').value = '';
  try { renderTags((await api.getConfig()).lolicon.tags); } catch {}
}
async function delTag(t) {
  try {
    const r = await api.removeTag(t);
    if (r && r.ok === false) { toast('删除标签失败: ' + (r.error || '未知错误'), 4000); return; }
  } catch (e) {
    toast('删除标签失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
  try { renderTags((await api.getConfig()).lolicon.tags); } catch {}
}

// ---------- 动作 ----------
async function changeNow() {
  const btn = $('btn-change'); btn.disabled = true;
  try {
    const r = await api.changeWallpaper('manual');
    if (r.ok) toast('换图成功: ' + (r.title || '') + (r.historyWriteError ? '(历史记录未写入: ' + r.historyWriteError + ')' : ''), 4000);
    else toast('换图失败: ' + r.error, 5000);
    refreshStatus();
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
      document.querySelector('.nav-item[data-page="services"]').click();
      return;
    }
  } else {
    // 服务引擎:无画图服务时引导到 API 服务页
    const services = await api.listServices();
    const hasImage = services.some(s => s.kind === 'image');
    if (!hasImage) {
      toast('请先到「API 服务」页添加画图 API(需支持 /v1/images/generations)', 5000);
      document.querySelector('.nav-item[data-page="services"]').click();
      return;
    }
  }
  const btn = $('btn-ai'); btn.disabled = true;
  try {
    // 阶段4:previewMode=true 走生成预览流(不自动应用);false 走原直应用路径
    const cfg2 = await api.getConfig();
    if (cfg2.ai && cfg2.ai.previewMode) {
      toast('AI 正在生成,约 20~60 秒…', 60000);
      const g = await api.aiGenerate();
      if (g && g.ok) {
        await showPreview(g);
        toast('生成完成,请确认后应用', 4000);
      } else {
        hidePreview();
        toast('生成失败: ' + ((g && g.error) || '未知错误'), 5000);
      }
      return;
    }
    toast('AI 正在生成,约 20~60 秒…', 60000);
    const r = await api.changeWallpaper('ai');
    if (r.ok) toast('AI 壁纸已应用!' + (r.historyWriteError ? '(历史记录未写入: ' + r.historyWriteError + ')' : ''), 4000);
    else toast('生成失败: ' + r.error, 5000);
    refreshStatus();
  } finally { btn.disabled = false; }
}

// ---------- 生成预览流(阶段4) ----------
// taskId 是轻量句柄;预览图用 file:// 直读 pending 文件,
// imageVersion(mtimeMs)做缓存破坏,避免同一路径显示旧图。
let previewTaskId = '';
let __pendingPath = '';   // pending 目录绝对路径,由 ai-generate 返回值下发
async function showPreview(gen) {
  previewTaskId = gen.taskId || '';
  __pendingPath = gen.pendingPath || '';
  const card = $('ai-preview-card');
  const img = $('ai-preview-img');
  const meta = $('ai-preview-meta');
  if (!card || !img) return;
  img.src = 'file:///' + encodeURI(__pendingPath.replace(/\\/g, '/')) + '?v=' + gen.imageVersion;
  if (meta) meta.textContent = (gen.engine === 'doubao' ? '豆包' : 'API 服务') + ' · ' +
    Math.round((gen.bytes || 0) / 1024) + 'KB · ' + String(gen.prompt || '').slice(0, 40) + (String(gen.prompt || '').length > 40 ? '…' : '');
  card.style.display = '';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hidePreview() {
  previewTaskId = '';
  const card = $('ai-preview-card');
  if (card) card.style.display = 'none';
  const img = $('ai-preview-img');
  if (img) img.src = '';
}
async function aiApplyNow() {
  if (!previewTaskId) { toast('没有待应用的预览', 3000); return; }
  const btn = $('btn-apply'); btn.disabled = true;
  try {
    const r = await api.aiApply(previewTaskId);
    if (r && r.ok) {
      toast('已应用为壁纸!' + (r.historyWriteError ? '(历史记录未写入: ' + r.historyWriteError + ')' : ''), 4000);
      hidePreview();
      refreshStatus();
    } else {
      toast('应用失败: ' + ((r && r.error) || '未知错误'), 5000);
      // 过期/不存在:刷新预览状态,pending 已不在则收起卡片;被新图覆盖则切到新图
      const pg = await api.aiPendingGet();
      if (!pg || !pg.ok || !pg.exists) hidePreview();
      else if (pg.taskId && pg.taskId !== previewTaskId) {
        await showPreview({ taskId: pg.taskId, imageVersion: pg.imageVersion, bytes: pg.bytes, prompt: pg.prompt, engine: pg.engine });
      }
    }
  } finally { btn.disabled = false; }
}
async function aiRegen() {
  // 重新生成 = 新的一次 ai-generate(消耗一次额度);旧 pending 被新图覆盖
  if (previewTaskId) { try { await api.aiDiscard(previewTaskId); } catch {} }
  await aiNow();
}
async function aiDiscardNow() {
  if (!previewTaskId) return;
  const btn = $('btn-discard'); btn.disabled = true;
  try {
    const r = await api.aiDiscard(previewTaskId);
    if (r && r.ok) { toast('已放弃本次生成', 3000); hidePreview(); }
    else toast('放弃失败: ' + ((r && r.error) || '未知错误'), 4000);
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
// 只读通道失败提示(阶段2 第5步):
// 列表为空时再查一次 readErrors,区分"本来就没数据"与"磁盘读不了"。
// 两者在旧实现里完全同形,用户只能看到空列表,无法判断出了什么问题。
async function emptyTipOrError(box, channel, emptyText) {
  let err = '';
  try {
    const st = await api.getStatus();
    err = (st && st.readErrors && st.readErrors[channel]) || '';
  } catch {}
  if (err) {
    setEmptyTip(box, '读取失败: ' + err + '(不是"没有数据",请检查壁纸目录是否可访问)');
  } else {
    setEmptyTip(box, emptyText);
  }
}

async function loadHistory() {
  const files = await api.listHistory();
  const box = $('gallery');
  box.textContent = '';
  if (!files || !files.length) { await emptyTipOrError(box, 'list-history', '暂无历史壁纸,点「立即换一张」开始 ✨'); return; }
  files.forEach(f => box.appendChild(makeGalleryItem(f)));
}
async function loadFavorites() {
  const files = await api.listFavorites();
  const box = $('fav-gallery');
  box.textContent = '';
  if (!files || !files.length) { await emptyTipOrError(box, 'list-favorites', '暂无收藏 ♥ 主页右上角心形按钮可收藏当前壁纸'); return; }
  files.forEach(f => box.appendChild(makeGalleryItem(f, { showName: false, deletable: true })));
}
async function delFav(name) {
  const r = await api.deleteFavorite(name);
  toast(r.ok ? '已删除' : '失败: ' + r.error);
  loadFavorites();
}
async function useHistory(name) {
  const r = await api.useHistory(name);
  // 换图成功但历史/回执落盘失败时必须让用户看见,否则"已设为壁纸"会掩盖数据未记录的事实
  if (r.ok) {
    toast('已设为壁纸' + (r.historyWriteError ? '(历史记录未写入: ' + r.historyWriteError + ')' : ''), 4000);
  } else {
    toast('失败: ' + r.error);
  }
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
  // 失败时保留编辑器打开状态与全部输入,只有真正保存成功才关闭并刷新
  try {
    const r = await api.saveService(editingSvc);
    if (!r || r.ok === false) { toast('保存失败: ' + ((r && r.error) || '未知错误'), 4000); return; }
  } catch (e) {
    toast('保存失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
  closeEditor();
  loadServices();
  toast('服务已保存');
}
async function deleteService(id) {
  if (!confirm('确定删除该服务?')) return;
  try {
    const r = await api.deleteService(id);
    if (!r || r.ok === false) { toast('删除失败: ' + ((r && r.error) || '未知错误'), 4000); return; }
  } catch (e) {
    toast('删除失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
  loadServices();
  toast('已删除');
}
async function setActive(kind, id) {
  try {
    const r = await api.setActiveService(kind, id);
    if (!r || r.ok === false) { toast('切换失败: ' + ((r && r.error) || '未知错误'), 4000); return; }
  } catch (e) {
    toast('切换失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
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


// AI 页「模型」下拉:把"用哪个引擎生图"和"具体模型"合成一个选择。
//
// 值域约定:
//   'doubao'            -> 走豆包账号 Seedream(cfg.ai.imageEngine = 'doubao')
//   'svc:<modelName>'   -> 走 OpenAI 兼容服务,model 写入 cfg.ai.model
// 这样用户在一个下拉里就能选"用豆包还是用某个 API 服务",不用去两个页面来回切。
async function refreshImageEngineOptions(st) {
  const sel = $('ai-model');
  if (!sel) return;
  try {
    const cfg = await api.getConfig();
    const engine = (cfg.ai && cfg.ai.imageEngine) || 'service';
    const curModel = (cfg.ai && cfg.ai.model) || '';
    // 模型列表来自远端拉取,可能为空(服务不可达 / 尚未拉取)。
    // 【不能用空列表就只剩豆包一个选项】—— 那样用户会以为服务没了。
    // 兜底:把当前激活服务配置的模型名也放进去,保证至少能看到自己在用的模型。
    const fetched = (st && Array.isArray(st.imageModels)) ? st.imageModels : [];
    const services = await api.listServices();
    const activeSvc = services.find(s => s.id === cfg.activeImageService && s.kind === 'image');
    const models = fetched.slice();
    if (curModel && !models.includes(curModel)) models.unshift(curModel);
    if (activeSvc && activeSvc.model && !models.includes(activeSvc.model)) models.push(activeSvc.model);
    const prev = sel.value;
    sel.textContent = '';

    // 豆包选项:仅在已登录时可用
    let doubaoReady = false;
    try {
      const ds = await api.doubao.status();
      doubaoReady = ds && ds.state === 'authenticated';
    } catch { doubaoReady = false; }

    const optD = document.createElement('option');
    optD.value = 'doubao';
    optD.textContent = '豆包 Seedream' + (doubaoReady ? '' : '(未登录)');
    if (!doubaoReady) { optD.disabled = true; optD.style.color = '#6b7280'; }
    sel.appendChild(optD);

    // 服务模型选项
    for (const m of models) {
      const o = document.createElement('option');
      o.value = 'svc:' + m;
      o.textContent = m;
      sel.appendChild(o);
    }

    // 回填当前值。优先级:配置里的模型 > 上次选中的值 > 列表第一项。
    // 不能无条件用 models[0],否则会把用户已选好的模型悄悄改掉。
    if (engine === 'doubao' && doubaoReady) {
      sel.value = 'doubao';
    } else if (curModel && models.includes(curModel)) {
      sel.value = 'svc:' + curModel;
    } else if (prev && [...sel.options].some(o => o.value === prev && !o.disabled)) {
      sel.value = prev;
    } else if (models.length) {
      sel.value = 'svc:' + models[0];
    } else if (doubaoReady) {
      sel.value = 'doubao';
    }
  } catch (e) {
    // 读取失败时保持原样,不把下拉清空
  }
}

// 下拉变更:切换引擎或模型
async function onAiModelChange() {
  const sel = $('ai-model');
  if (!sel) return;
  const v = String(sel.value || '');
  if (v === 'doubao') {
    await api.saveConfig('ai.imageEngine', 'doubao');
    toast('已切换到豆包 Seedream 生图', 3000);
    return;
  }
  if (v.startsWith('svc:')) {
    const model = v.slice(4);
    await api.saveConfig('ai.imageEngine', 'service');
    await api.saveConfig('ai.model', model);
    toast('已切换到服务模型: ' + model, 3000);
  }
}

// ---------- 状态栏 ----------
async function refreshStatus() {
  const st = await api.getStatus();
  // AI 页模型下拉:跟随当前画图服务的模型列表 + 豆包引擎(阶段3)
  await refreshImageEngineOptions(st);
  // 模型列表拉取失败不再静默:明确告诉用户失败了、原因是什么,而不是留一个空下拉框让人猜
  const modelsErrTip = st.imageModelsError ? ('模型列表获取失败: ' + st.imageModelsError) : '';
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
  $('status-right').textContent = (modelsErrTip ? modelsErrTip + ' · ' : '') + (st.oldTaskRunning ? '旧任务运行中 · ' : '') + (st.nextRun ? '下次自动换图 ' + st.nextRun : '自动换图已关闭');
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
  // 主进程推送时若 get-status 抛错,不 catch 会产生 unhandled rejection
  try {
    await refreshStatus();
  } catch (e) {
    $('status-text').textContent = '状态刷新失败: ' + ((e && e.message) || e);
  }
  // 只有真正来自外部(旧脚本等)的写入才提示,本程序自身写入不打扰用户
  if (reason === 'external') {
    toast('检测到旧脚本更换了壁纸,已同步', 2200);
  }
  // 阶段3:豆包登录状态变化由主进程推送
  if (typeof reason === 'string' && reason.startsWith('doubao:')) {
    try { await refreshDoubao(); } catch {}
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
  // 阶段3:启动时读一次豆包状态(只读,不会打开任何窗口)
  try { await refreshDoubao(); } catch {}
});
