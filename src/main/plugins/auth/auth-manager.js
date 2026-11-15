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
  setState('opening');
  try {
    const r = await deps.openLoginWindow();
    if (!r || !r.ok) {
      loginInFlight = false;
      setState('error', (r && r.error) || '打开登录窗口失败');
      return { ok: false, error: (r && r.error) || '打开登录窗口失败' };
    }
  } catch (e) {
    loginInFlight = false;
    setState('error', (e && e.message) || String(e));
    return { ok: false, error: (e && e.message) || String(e) };
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

  endScan();
  loginInFlight = false;
  try { deps.closeLoginWindow(); } catch {}
  setState('authenticated');
}

async function failLogin(msg) {
  endScan();
  loginInFlight = false;
  try { deps.closeLoginWindow(); } catch {}
  if (authProtocol.canTransition(state, 'error')) setState('error', msg);
}

// 用户取消登录(关闭窗口 / 主动点取消)
async function cancelLogin(reason) {
  if (state !== 'awaiting_scan' && state !== 'opening') {
    return { ok: false, error: '当前没有进行中的登录' };
  }
  endScan();
  loginInFlight = false;
  try { deps.closeLoginWindow(); } catch {}
  if (authProtocol.canTransition(state, 'cancelled')) setState('cancelled', reason || '');
  return { ok: true, state };
}

// 退出登录:删凭据 + 清 session + 回 idle
async function logout() {
  endScan();
  loginInFlight = false;
  try { deps.closeLoginWindow(); } catch {}
  try { await deps.credential.clear(); } catch (e) { /* 删不掉也要继续清 session */ }
  try { await deps.clearSession(); } catch {}
  if (state !== 'idle') {
    // authenticated/expired/cancelled/error 都可回 idle
    if (authProtocol.canTransition(state, 'idle')) setState('idle');
  }
  return { ok: true, state: 'idle' };
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
  state = 'idle'; lastError = ''; loginInFlight = false;
}

module.exports = {
  init, getState, beginLogin, cancelLogin, logout, markExpired, restore, __reset,
};