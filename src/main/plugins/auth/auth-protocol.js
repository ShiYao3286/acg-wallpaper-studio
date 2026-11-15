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
  // opening / awaiting_scan 都允许直接回 idle。
  //
  // 为什么必须加(阶段3 审核修复中发现的真实缺陷):
  // 用户在"正在打开窗口"或"等待扫码"时点【退出账号】,
  // 旧迁移表里这两个状态只能去 error / cancelled,没有到 idle 的路,
  // 于是 logout() 里的 canTransition(state,'idle') 判 false,
  // 状态就永远卡在 awaiting_scan —— 凭据已经删了,UI 却还显示"等待扫码"。
  // 这是"退出登录"这条止损路径上的死状态,必须堵掉。
  opening:       ['awaiting_scan', 'error', 'cancelled', 'idle'],
  awaiting_scan: ['authenticated', 'cancelled', 'error', 'idle'],
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

// ---------- 登录地址与域名白名单(唯一来源) ----------
//
// 本文件是登录相关 URL 与允许域名的【唯一定义处】。
// main.js 必须从这里取,不得再写一份 —— 阶段3 审核发现的重复定义
// (main.js 的 DOUBAO_COOKIE_URLS 与这里的 ALLOWED_COOKIE_URLS 各写一遍)
// 会导致两边改动不同步,其中一边漏改就直接连错地址。
//
// 另一处审核问题:文档里这些地址曾被写成 Markdown 链接形态
//   [https://www.doubao.com/](https://www.doubao.com/)
// 这种字符串不是合法 URL,传给 loadURL()/cookies.get() 会抛错或
// 产生不可预期的行为。assertPureHttpsUrl() 就是用来钉死这一点的:
// 它不是"防呆注释",而是模块加载时立刻执行的真实断言。

// 登录窗口加载的固定地址
const LOGIN_URL = 'https://www.doubao.com/chat/';

// 允许抓取/清理 Cookie 的地址。
// 只碰豆包自己的域,绝不读取用户默认浏览器或其他站点的 Cookie。
const ALLOWED_COOKIE_URLS = [
  'https://www.doubao.com/',
  'https://doubao.com/',
  'https://passport.doubao.com/',
];

// 允许导航与开窗的 hostname 显式白名单。
//
// 刻意用"全等集合"而不是后缀正则:
// 正则 /(^|\.)doubao\.com$/ 虽然恰好能挡住 evil-doubao.com,
// 但把安全性寄托在正则写法上太脆弱 —— 任何一次"顺手放宽"
// (比如改成 /doubao\.com/ 或加个 ? 量词)都会静默开口子。
// 这里是穷举集合,新增子域必须显式加一行,评审时一眼能看见。
//
// 明确拒绝的形态(见 t18 F 组反向用例):
//   evil-doubao.com / doubao.com.evil.test / notdoubao.com / doubao.com.evil.com
const ALLOWED_HOSTS = [
  'doubao.com',
  'www.doubao.com',
  'passport.doubao.com',
];

// Markdown 链接痕迹。命中的一律判为非法 URL。
// 同时覆盖 [x](y) 与 ]( 两种形态。
const MARKDOWN_LINK_RE = /\]\s*\(|\[[^\]]*\]\s*\(/;

// 纯 HTTPS URL 断言:解析 → 协议 → hostname 白名单 → 无 Markdown 痕迹。
// 任何一步不过都抛 AuthProtocolError,不做"猜测式修正"。
function assertPureHttpsUrl(raw, label) {
  const name = label || 'URL';
  if (typeof raw !== 'string' || raw === '') bad(name + ' 必须是非空字符串');
  if (MARKDOWN_LINK_RE.test(raw)) bad(name + ' 不是纯 URL(疑似 Markdown 链接): ' + raw);
  if (/\s/.test(raw)) bad(name + ' 含空白字符: ' + raw);
  let u;
  try { u = new URL(raw); } catch { bad(name + ' 无法被 URL 解析: ' + raw); }
  if (u.protocol !== 'https:') bad(name + ' 必须使用 https: 协议: ' + raw);
  if (!ALLOWED_HOSTS.includes(u.hostname)) bad(name + ' 的域名不在白名单内: ' + u.hostname);
  return u;
}

// hostname 是否在白名单内(全等比较,大小写归一)。
// 传进来的必须是已经解析过的 hostname,不接受整条 URL。
function isAllowedHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  return ALLOWED_HOSTS.includes(hostname.toLowerCase());
}

// 导航/开窗判定:先 URL 解析,再校验协议与 hostname。
// 解析失败、协议不是 https:、hostname 不在白名单 —— 三者任一都返回 false。
// 调用方拿到 false 必须阻止导航,不存在"拿不准就放行"的分支。
function isAllowedNavigateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return isAllowedHost(u.hostname);
}

// 校验全部 URL 常量。返回 { ok, errors:[], urls:[] }。
// 供测试直接调用,也供模块加载时自检。
function validateUrlConstants() {
  const errors = [];
  const urls = [];
  const check = (value, label) => {
    try { assertPureHttpsUrl(value, label); urls.push(value); }
    catch (e) { errors.push((e && e.message) || String(e)); }
  };
  check(LOGIN_URL, 'LOGIN_URL');
  ALLOWED_COOKIE_URLS.forEach((u, i) => check(u, 'ALLOWED_COOKIE_URLS[' + i + ']'));
  if (!Array.isArray(ALLOWED_HOSTS) || ALLOWED_HOSTS.length === 0) {
    errors.push('ALLOWED_HOSTS 不能为空');
  } else {
    for (const h of ALLOWED_HOSTS) {
      // 白名单项本身不允许带协议、路径、通配符或空白
      if (typeof h !== 'string' || !h) { errors.push('ALLOWED_HOSTS 含非字符串项'); continue; }
      if (/[:\/\s*]/.test(h)) errors.push('ALLOWED_HOSTS 项不能含协议/路径/通配符: ' + h);
    }
  }
  return { ok: errors.length === 0, errors, urls };
}

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

// 模块加载时立即自检:URL 常量写错就让 require 直接失败。
//
// 放在文件末尾是刻意的 —— 它依赖 AuthProtocolError 与 bad,
// 而 class 声明处在 TDZ 里,把自检放前面会先抛 ReferenceError
// 而不是给出"哪个 URL 写错了"的可读信息。
// 这不是多余的开销:它保证"文档里的地址被写成 Markdown 链接"
// 这类错误在启动/跑测试的第一秒就暴露,而不是等用户点登录才炸。
{
  const selfCheck = validateUrlConstants();
  if (!selfCheck.ok) {
    throw new AuthProtocolError('登录 URL 常量校验失败: ' + selfCheck.errors.join(' | '));
  }
}

module.exports = {
  AUTH_TYPES, AUTH_STATES, TRANSITIONS, REQUIRED_COOKIES,
  // URL 与域名白名单的唯一来源。main.js 从这里取,不再自己写一份。
  LOGIN_URL, ALLOWED_COOKIE_URLS, ALLOWED_HOSTS,
  AuthProtocolError, isAuthProtocolError,
  assertAuth, canTransition, assertTransition,
  checkCookieCompleteness, authFail,
  assertPureHttpsUrl, isAllowedHost, isAllowedNavigateUrl, validateUrlConstants,
};