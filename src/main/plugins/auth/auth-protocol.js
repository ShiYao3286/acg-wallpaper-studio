// 认证协议(阶段 3.2)
//
// 目的:给"需要账号登录才能用的 Provider"一个统一的描述方式与状态机,
// 同时保证不填写认证描述的既有 Provider 行为完全不变。
//
// 设计边界(重要,别越界理解):
//   1. 认证声明 ≠ 认证授权。它只描述"这个 Provider 需要什么",不是权限凭证。
//   2. 本文件是纯函数模块,不 require electron、不碰文件系统,便于单测。
//   3. 真正的凭据只由主进程 services/credential-service 持有,
//      绝不经 Provider Context 或 IPC 传给 Provider / Renderer。
//   4. 本协议不做任何"绕过平台安全验证"的事;遇到验证码/限流一律停下。

const { fail, ERROR_CODES } = require('../../../shared/contracts');

// 认证类型白名单。当前只有一种:账号会话(扫码登录拿 Cookie)。
// 将来若接官方 API Key,可加 'api-key',但那时凭据来源不同,不要复用本状态机。
const AUTH_TYPES = new Set(['account-session']);

// 登录状态机允许的全部状态。
//
//   idle          未登录,也无进行中的登录
//   opening       正在打开登录窗口(短暂过渡态)
//   awaiting_scan 窗口已开,等用户扫码
//   authenticated 已登录,凭据可用
//   expired       凭据曾存在但已失效(服务端拒绝过)
//   cancelled     用户主动取消登录
//   error         登录或凭据环节出错
const AUTH_STATES = ['idle', 'opening', 'awaiting_scan', 'authenticated', 'expired', 'cancelled', 'error'];

// 合法状态流转表。value 为该状态可以迁移到的目标状态集合。
// 刻意写成白名单而非"排除法":非法迁移必须显式拒绝,不能靠遗漏。
const TRANSITIONS = {
  idle:          ['opening'],
  opening:       ['awaiting_scan', 'error', 'cancelled'],
  awaiting_scan: ['authenticated', 'cancelled', 'error'],
  authenticated: ['idle', 'expired', 'opening'],   // 退出登录 / 凭据失效 / 重新登录
  expired:       ['opening', 'idle'],              // 重新扫码 或 主动退出
  cancelled:     ['opening', 'idle'],              // 再次尝试 或 回到未登录
  error:         ['opening', 'idle'],              // 重试 或 放弃
};

// 登录判定所需的 Cookie 字段。
//
// 依据:阶段 3.1 实测拿到 27~28 条 Cookie,其中这些是豆包身份链必需项;
// sid_guard 在某些会话里可能缺失,因此不列入硬性要求(与参考实现一致)。
// 注意:这里只校验"名字齐全",不校验值的有效性 —— 值是否真能用只能由真实请求验证。
const REQUIRED_COOKIES = [
  'sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'ttwid', 'odin_tt',
  'passport_csrf_token', 's_v_web_id',
];

// 允许抓取 Cookie 的域名白名单。
// 只碰豆包自己的域,绝不读取用户默认浏览器或其他站点的 Cookie。
const ALLOWED_COOKIE_URLS = [
  'https://www.doubao.com/',
  'https://doubao.com/',
  'https://passport.doubao.com/',
];

class AuthProtocolError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthProtocolError'; this.isAuthProtocolError = true; }
}
const bad = (msg) => { throw new AuthProtocolError(msg); };
const isAuthProtocolError = (e) => !!(e && e.isAuthProtocolError);

const MAX_ID_LEN = 64;
const MAX_STATUS_KEY = 64;

// 校验 auth 描述并规范化。未填写返回 null(表示"无认证需求")。
function assertAuth(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) bad('Provider auth 必须是对象');
  if (!AUTH_TYPES.has(raw.type)) {
    bad('不支持的认证类型: ' + String(raw.type) + '(允许: ' + [...AUTH_TYPES].join(', ') + ')');
  }
  // required 必须是严格布尔:字符串 'false' 会造成"看起来要认证、实际不要"的歧义
  if (typeof raw.required !== 'boolean') bad('Provider auth.required 必须是布尔值');
  const statusKey = (typeof raw.statusKey === 'string' && raw.statusKey.trim()) ? raw.statusKey.trim() : '';
  if (!statusKey) bad('Provider auth.statusKey 不能为空');
  if (statusKey.length > MAX_STATUS_KEY) bad('Provider auth.statusKey 超长');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(statusKey)) bad('Provider auth.statusKey 只能包含小写字母、数字、下划线、连字符: ' + statusKey);
  // userInitiated 表示"必须由用户主动触发登录",当前只支持 true 语义,默认 true
  if (raw.userInitiated !== undefined && typeof raw.userInitiated !== 'boolean') {
    bad('Provider auth.userInitiated 必须是布尔值');
  }
  return {
    type: raw.type,
    required: raw.required,
    statusKey,
    userInitiated: raw.userInitiated !== false,
  };
}

// 状态迁移检查:合法返回 true,非法抛错。
function canTransition(from, to) {
  if (!AUTH_STATES.includes(from)) bad('未知的当前状态: ' + String(from));
  if (!AUTH_STATES.includes(to)) bad('未知的目标状态: ' + String(to));
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) bad('非法状态迁移: ' + from + ` -> ` + to);
  return true;
}

// 判断一组 Cookie(名字→值)是否满足登录完整性。
// 返回值:{ ok, missing: [] }
// 关键:只看"必需字段是否齐全",绝不用 Cookie 数量当判据 ——
// 阶段 3.1 实测见过 27 与 28 条的波动,数量不稳定,拿它判登录必然误判。
function checkCookieCompleteness(pairs) {
  const missing = [];
  if (!pairs || typeof pairs.has !== 'function') {
    return { ok: false, missing: REQUIRED_COOKIES.slice() };
  }
  for (const name of REQUIRED_COOKIES) {
    const v = pairs.get(name);
    if (typeof v !== 'string' || v === '') missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}

// 供服务层使用的失败转换
function authFail(err) {
  if (isAuthProtocolError(err)) return fail(err.message, ERROR_CODES.E_INVALID_ARG);
  return fail((err && err.message) || String(err), ERROR_CODES.E_STATE);
}

module.exports = {
  AUTH_TYPES, AUTH_STATES, TRANSITIONS, REQUIRED_COOKIES, ALLOWED_COOKIE_URLS,
  AuthProtocolError, isAuthProtocolError,
  assertAuth, canTransition, assertTransition,
  checkCookieCompleteness, authFail,
};