// 认证管理器(阶段 3.2)
//
// 职责:持有登录状态、驱动状态机、协调"打开窗口 → 等扫码 → 取凭据"的流程。
//
// 设计要点:
//   1. 本模块【不直接 require electron】。窗口与 session 由 main.js 在 init() 时注入,
//      这样 auth-manager 可以在没有 Electron 的环境里被单测,符合现有测试脚手架风格。
//   2. 本模块不碰文件系统。凭据的加密存取由 services/credential-service 负责。
//   3. 本模块【不返回原始 Cookie】给任何调用方;它只交出"状态"与"是否可用"。
//      Cookie 从 session 读出后立刻交给 credentialService 加密落盘,内部随即丢弃。
//   4. 不存在"自动重试"路径:登录失败就停在 error/cancelled,等用户再次点击。

const authProtocol = require('./auth-protocol');

let deps = {
  openLoginWindow: async () => { throw new Error('openLoginWindow 未注入'); },
  closeLoginWindow: () => {},
  clearSession: async () => {},
  credential: null,   // services/credential-service
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
  pollIntervalMs: 3000,
  scanTimeoutMs: 5 * 60 * 1000,
};

let state = 'idle';
let lastError = '';
let scanTimer = null;
let scanDeadline = 0;
let loginInFlight = false;   // 防重复登录
// 登录状态的变化通过回调抛给上层(托盘/UI 刷新),避免本模块反向依赖 UI
let onStateChange = null;

function init(opts) {
  deps = Object.assign({}, deps, opts || {});
  if (deps.onStateChange) onStateChange = deps.onStateChange;
}

function getState() {
  return { state, lastError, inFlight: loginInFlight };
}

function setState(next, err) {
  // 状态流转必须过协议校验;非法迁移直接抛,不静默吞
  authProtocol.assertTransition(state, next);
  state = next;
  lastError = err || '';
  if (onStateChange) { try { onStateChange(getState()); } catch {} }
}

// 只清定时器,不清 scanDeadline。
// 曾经的 bug:这里把 scanDeadline 一起清零,而 schedulePoll() 开头就会调用本函数,
// 导致 pollOnce() 里 "now() > scanDeadline(0)" 恒为 true,每次登录都立刻报超时。
// deadline 的生命周期由 beginLogin(设) 与结束时(清) 负责,与定时器解耦。
function clearScanTimer() {
  if (scanTimer !== null) { deps.clearTimer(scanTimer); scanTimer = null; }
}

// 结束整个扫码流程时(成功/失败/取消)才把 deadline 归零
function endScan() {
  clearScanTimer();
  scanDeadline = 0;
}

// 启动登录流程。
// 返回 { ok:true, state } 或 { ok:false, error }
// 关键:重复点击不会开第二个窗口(loginInFlight 守卫 + 状态校验)。
async function beginLogin() {
  if (loginInFlight) return { ok: false, error: '登录进行中,请稍候' };
  // authenticated 状态下允许"重新登录"(迁移到 opening 合法)
  if (!authProtocol.canTransition(state, 'opening')) {
    return { ok: false, error: '当前状态不允许登录: ' + state };
  }

  loginInFlight = true;
  // 新一次登录开始:清掉上一次的成功标记,否则这次取消会被误判成"已成功"而跳过清理
  loginCommitted = false;
  setState('opening');
  try {
    const r = await deps.openLoginWindow();
    if (!r || !r.ok) {
      loginInFlight = false;
      // 开窗失败:窗口可能建了一半,Session 里可能已经写入了豆包域的 Cookie。
      // 这条路径原来完全不清理,现在与其它失败路径一致。
      const clean = await cleanupAbortedSession('打开登录窗口失败');
      setState('error', (r && r.error) || '打开登录窗口失败');
      return { ok: false, error: (r && r.error) || '打开登录窗口失败', cleanup: clean };
    }
  } catch (e) {
    loginInFlight = false;
    const clean = await cleanupAbortedSession('打开登录窗口异常');
    setState('error', (e && e.message) || String(e));
    return { ok: false, error: (e && e.message) || String(e), cleanup: clean };
  }

  setState('awaiting_scan');
  scanDeadline = deps.now() + deps.scanTimeoutMs;
  schedulePoll();
  return { ok: true, state };
}

function schedulePoll() {
  clearScanTimer();
  scanTimer = deps.setTimer(async () => {
    try { await pollOnce(); } catch (e) { /* 单次轮询失败不终止流程 */ }
    if (state === 'awaiting_scan') schedulePoll();
  }, deps.pollIntervalMs);
}

// 轮询一次:问 session 要 Cookie,齐全就落盘并置为 authenticated。
async function pollOnce() {
  if (state !== 'awaiting_scan') return;
  if (deps.now() > scanDeadline) {
    await failLogin('等待登录超时,请重新点击登录');
    return;
  }

  let pairs;
  try {
    pairs = await deps.readSessionCookies();
  } catch (e) {
    // 读取失败(窗口刚导航/会话被清)属正常过渡,继续等
    return;
  }

  const check = authProtocol.checkCookieCompleteness(pairs);
  if (!check.ok) return;   // 还没登录完,继续等

  // 拿到完整凭据:先落盘,再清引用,最后置状态
  try {
    await deps.credential.save(pairs);
  } catch (e) {
    await failLogin('凭据保存失败: ' + ((e && e.message) || e));
    return;
  }

  // 标记成功:此后任何"关闭窗口 → 取消"的事件都不能再清 Session,
  // 否则会把刚存好的登录态抹掉(表现为"登录成功但立刻失效")。
  loginCommitted = true;
  endScan();
  loginInFlight = false;
  try { deps.closeLoginWindow(); } catch {}
  setState('authenticated');
}

// ---------- 失败/取消路径的 Session 清理(集中实现) ----------
//
// 阶段3 审核指出的问题:取消、超时、开窗失败、Cookie 不完整、凭据保存失败、
// 窗口异常关闭这几条路径,原来【没有任何一处】清理专用 Session 里的 Cookie。
// 后果:用户扫码扫到一半取消,豆包会话 Cookie 仍留在 persist:doubao 分区里,
// 下次开窗直接是登录态;更糟的是半途的 Cookie 可能让 checkCookieCompleteness
// 在下一次登录时立刻判"已登录",存下一个并不完整的凭据。
//
// 修法:所有非成功路径统一走 cleanupAbortedSession()。
// 只动注入进来的 clearSession(它只碰 persist:doubao 分区里的豆包域),
// 不碰主窗口 session、不碰用户浏览器 Cookie。
//
// 关键竞态:登录成功那一刻 pollOnce() 已经把 Cookie 存进 credential 了,
// 此后如果 closed 事件再触发取消,【不能】再清 session —— 那会把刚登录成功的
// 会话数据抹掉,表现为"登录成功但立刻失效"。用 loginCommitted 标志挡住。
let loginCommitted = false;

async function cleanupAbortedSession(reason) {
  // 凭据已落盘说明这次登录是成功的,清理交给 logout(),这里直接跳过
  if (loginCommitted) return { ok: true, skipped: true, errors: [] };
  const errors = [];
  try {
    const r = await deps.clearSession();
    if (r && typeof r === 'object' && 'ok' in r && r.ok !== true) {
      const detail = Array.isArray(r.errors) && r.errors.length ? r.errors.join('; ') : '未知原因';
      errors.push('清理 Session 失败: ' + detail);
    }
  } catch (e) {
    errors.push('清理 Session 异常: ' + ((e && e.message) || String(e)));
  }
  if (errors.length) {
    // 清理失败不能静默:记进 lastError 便于诊断,但不含 Cookie 内容
    lastError = (reason ? reason + '; ' : '') + errors.join('; ');
    if (onStateChange) { try { onStateChange(getState()); } catch {} }
  }
  return { ok: errors.length === 0, errors };
}

async function failLogin(msg) {
  endScan();
  loginInFlight = false;
  // 先清 Session 再置状态:保证"error 状态 = 已经清理过"
  const clean = await cleanupAbortedSession(msg);
  try { deps.closeLoginWindow(); } catch {}
  const suffix = clean.ok ? '' : '(登录 Session 清理未完成: ' + clean.errors.join('; ') + ')';
  if (authProtocol.canTransition(state, 'error')) setState('error', msg + suffix);
  return { ok: false, error: msg, cleanup: clean };
}

// 用户取消登录(关闭窗口 / 主动点取消)
async function cancelLogin(reason) {
  if (state !== 'awaiting_scan' && state !== 'opening') {
    return { ok: false, error: '当前没有进行中的登录' };
  }
  endScan();
  loginInFlight = false;
  const clean = await cleanupAbortedSession(reason || '用户取消');
  try { deps.closeLoginWindow(); } catch {}
  if (authProtocol.canTransition(state, 'cancelled')) {
    const suffix = clean.ok ? '' : '(登录 Session 清理未完成)';
    setState('cancelled', (reason || '') + suffix);
  }
  return { ok: true, state, cleanup: clean };
}

// 退出登录:删凭据 + 清 session + 回 idle
//
// 阶段3 审核指出的问题(旧实现):
//   try { await deps.credential.clear(); } catch (e) { /* 忽略 */ }
//   try { await deps.clearSession(); } catch {}
//   return { ok: true, state: 'idle' };     // ← 无论删没删成功都报成功
// 结果:凭据可能还在磁盘上,但 UI 显示"已退出",下次启动 restore() 又把账号登回来。
// 这属于"报告与事实不符",比直接报错更糟 —— 用户以为凭据已经清掉了。
//
// 新语义:
//   1. 两步清理【都要尝试】,一步失败不影响另一步继续(尽可能清干净);
//   2. 只有两步都成功才返回 ok:true;
//   3. 部分失败时如实报告剩下什么(credentialRemaining / sessionRemaining),
//      并且状态【不】伪装成完全退出;
//   4. 返回内容只含布尔量与错误消息,不含任何 Cookie 值。
//
// 状态处理:
//   - 全部清干净 → idle
//   - 凭据还在   → 保持 authenticated(事实就是还登着),但把错误记进 lastError
//   - 仅 session 没清干净 → credential 已删,状态可回 idle,但 ok:false,
//     让调用方知道"下次开窗可能带着旧 Cookie",不能报完整退出。
async function logout() {
  endScan();
  loginInFlight = false;
  // 退出即视为放弃本次登录:此后关窗事件不应再触发清理逻辑
  loginCommitted = false;
  try { deps.closeLoginWindow(); } catch {}

  const errors = [];

  // 凭据删除
  let credentialCleared = false;
  try {
    await deps.credential.clear();
    credentialCleared = true;
  } catch (e) {
    errors.push('删除凭据失败: ' + ((e && e.message) || String(e)));
  }

  // Session 清理(即使上一步失败也继续)
  let sessionCleared = false;
  let sessionDetail = null;
  try {
    const r = await deps.clearSession();
    // 注入的 clearSession 可能返回 { ok, errors } (main.js 的实现会),
    // 也可能只返回 undefined (测试里的简化实现)。两种都要正确处理:
    // 返回 undefined 视为成功,返回对象则看 ok 字段。
    if (r && typeof r === 'object' && 'ok' in r) {
      sessionCleared = r.ok === true;
      sessionDetail = r;
      if (!r.ok) {
        const detail = Array.isArray(r.errors) && r.errors.length ? r.errors.join('; ') : '未知原因';
        errors.push('清理登录 Session 失败: ' + detail);
      }
    } else {
      sessionCleared = true;
    }
  } catch (e) {
    errors.push('清理登录 Session 异常: ' + ((e && e.message) || String(e)));
  }

  // 复核凭据是否真的没了,而不是只信 clear() 没抛错。
  // has() 失败时按"可能还在"处理(保守),不谎报成功。
  let credentialRemaining = !credentialCleared;
  try {
    credentialRemaining = await deps.credential.has();
  } catch {
    credentialRemaining = !credentialCleared;
  }

  const okAll = credentialCleared && sessionCleared && !credentialRemaining;

  if (okAll) {
    if (state !== 'idle' && authProtocol.canTransition(state, 'idle')) setState('idle');
  } else if (credentialRemaining) {
    // 凭据还在,就不能说"已退出"。状态维持 authenticated(如果当前是),
    // 否则维持原状态并记错误 —— 绝不硬塞一个 idle 骗 UI。
    lastError = errors.join('; ');
    if (onStateChange) { try { onStateChange(getState()); } catch {} }
  } else {
    // 凭据已删、只是 session 没清干净:回到 idle 是符合事实的(账号确实登出了),
    // 但把错误记下来,并让 ok:false 通知调用方"不是完整退出"。
    if (state !== 'idle' && authProtocol.canTransition(state, 'idle')) setState('idle');
    lastError = errors.join('; ');
    if (onStateChange) { try { onStateChange(getState()); } catch {} }
  }

  return {
    ok: okAll,
    state,
    credentialCleared,
    credentialRemaining,
    sessionCleared,
    // 只回传计数与错误消息,不含 Cookie 内容
    sessionRemoved: sessionDetail && typeof sessionDetail.removed === 'number' ? sessionDetail.removed : null,
    errors,
  };
}

// 标记凭据失效(由 Transport 在收到 AUTH_EXPIRED 时调用)
function markExpired(reason) {
  if (state === 'authenticated' && authProtocol.canTransition(state, 'expired')) {
    setState('expired', reason || '登录已过期,请重新登录');
    return true;
  }
  return false;
}

// 应用启动时恢复:有可用凭据就置 authenticated,否则保持 idle
async function restore() {
  loginCommitted = false;
  let ok = false;
  try { ok = await deps.credential.has(); } catch { ok = false; }
  if (ok) {
    // idle -> authenticated 不在迁移表里(正常流程必须经 opening)
    // 但"重启恢复"是合法场景,这里直接落状态而不走 assertTransition,
    // 并在注释里注明原因,避免后来者误以为可以随便跳状态。
    state = 'authenticated';
  } else {
    state = 'idle';
  }
  if (onStateChange) { try { onStateChange(getState()); } catch {} }
  return getState();
}

// 仅供测试:重置到初始态
function __reset() {
  endScan();
  state = 'idle'; lastError = ''; loginInFlight = false; loginCommitted = false;
}

module.exports = {
  init, getState, beginLogin, cancelLogin, logout, markExpired, restore, __reset,
};