// IPC 参数校验(主进程)
// 阶段1目标1要求"建立 IPC 通道和参数校验"。这里只做最小必要校验:
// 拦住"渲染层 bug 或 XSS 后调用 API 传入畸形入参"导致脏配置落盘、任意 URL 出网、
// 超长字符串写文件这类问题,不改变任何正常调用的行为。
// 约定:断言失败抛 ArgError,由各通道统一捕获并返回 { ok:false, error:'参数无效: ...' }。
const { fail, ERROR_CODES } = require('../shared/contracts');

const MAX_ID = 128;
const MAX_NAME = 120;
const MAX_BASE = 2048;
const MAX_MODEL = 200;
const MAX_PROMPT = 8000;
const MAX_KEY = 512;

const SERVICE_KINDS = new Set(['image', 'text']);
// 换图原因白名单:与 changeWallpaper() 内部的分支判断保持一致
const CHANGE_REASONS = new Set(['manual', 'ai', 'ai-explicit', 'schedule']);
// 与服务同一套原型污染拦截,避免 IPC 传入的 __proto__ 被并入配置
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class ArgError extends Error {
  constructor(msg) { super(msg); this.name = 'ArgError'; this.isArgError = true; }
}
const bad = (msg) => { throw new ArgError(msg); };
const isArgError = (e) => !!(e && e.isArgError);

// 只保留自有可枚举且非污染键的字段,其余原样复制,避免后续新增字段被白名单误删
function copySafe(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = obj[k];
  }
  return out;
}

function requireString(v, field, opts) {
  const o = opts || {};
  const max = o.max || MAX_NAME;
  if (v === undefined || v === null) {
    if (o.required) bad(field + '不能为空');
    return '';
  }
  if (typeof v !== 'string') bad(field + '必须是字符串');
  const s = v.trim();
  if (o.required && !s) bad(field + '不能为空');
  if (s.length > max) bad(field + '超长(上限 ' + max + ' 字符)');
  return s;
}

// API 地址只允许 http/https:既要挡住 file:/javascript: 之类协议,
// 又必须放行本机 http 服务(现存配置里的 http://127.0.0.1:8326/v1 属于正常用法)
function requireApiBase(v) {
  const s = requireString(v, 'API 地址', { required: true, max: MAX_BASE });
  let u;
  try { u = new URL(s); } catch { bad('API 地址不是合法 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad('API 地址只支持 http/https');
  return s;
}

// 服务对象:{ id, kind, name, apiBase, apiKey, model }
function assertService(svc) {
  if (!svc || typeof svc !== 'object' || Array.isArray(svc)) bad('服务参数必须是对象');
  const out = copySafe(svc);
  out.id = requireString(svc.id, '服务 id', { required: true, max: MAX_ID });
  if (!SERVICE_KINDS.has(svc.kind)) bad("服务类型必须是 'image' 或 'text'");
  out.kind = svc.kind;
  out.name = requireString(svc.name, '服务名称', { max: MAX_NAME });
  out.apiBase = requireApiBase(svc.apiBase);
  // 密钥只校验形状,绝不写进日志或错误文案
  out.apiKey = requireString(svc.apiKey, 'API Key', { max: MAX_KEY });
  out.model = requireString(svc.model, '模型名', { max: MAX_MODEL });
  return out;
}

// 提示词预设:{ id, name, prompt }
function assertPreset(preset) {
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) bad('预设参数必须是对象');
  const out = copySafe(preset);
  out.id = requireString(preset.id, '预设 id', { required: true, max: MAX_ID });
  out.name = requireString(preset.name, '预设名称', { max: MAX_NAME });
  out.prompt = requireString(preset.prompt, '提示词', { required: true, max: MAX_PROMPT });
  return out;
}

// 单标识:allowEmpty 用于 set-active-service 这类"置空表示未选择"的语义
function assertId(id, field, opts) {
  return requireString(id, field || 'id', { required: !(opts && opts.allowEmpty), max: MAX_ID });
}

function assertKind(kind) {
  if (!SERVICE_KINDS.has(kind)) bad("服务类型必须是 'image' 或 'text'");
  return kind;
}

function assertReason(reason) {
  if (!CHANGE_REASONS.has(reason)) bad('换图原因不合法: ' + String(reason));
  return reason;
}

// 单独校验 API 地址:供 save-config 的点路径(services.N.apiBase)复用,
// 避免为了改一个字段而要求整个服务对象齐全
function assertApiBase(v) {
  return requireApiBase(v);
}

// 校验失败统一出口
const argFail = (e) => fail('参数无效: ' + ((e && e.message) || '未知校验错误'), ERROR_CODES.E_INVALID_ARG);

module.exports = {
  ArgError, isArgError, argFail,
  assertService, assertPreset, assertId, assertKind, assertReason, assertApiBase,
};
