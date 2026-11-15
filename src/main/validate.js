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

// ---------- 单字段校验器(供 save-config 点路径使用) ----------
// 只放行确实有业务意义的可写字段;未列出的字段一律拒绝,防止走点路径绕过对象级校验。
const SERVICE_FIELDS = {
  id: (v) => requireString(v, '服务 id', { required: true, max: MAX_ID }),
  kind: (v) => { if (!SERVICE_KINDS.has(v)) bad("服务类型必须是 'image' 或 'text'"); return v; },
  name: (v) => requireString(v, '服务名称', { max: MAX_NAME }),
  apiBase: (v) => requireApiBase(v),
  apiKey: (v) => requireString(v, 'API Key', { max: MAX_KEY }),
  model: (v) => requireString(v, '模型名', { max: MAX_MODEL }),
};

const PRESET_FIELDS = {
  id: (v) => requireString(v, '预设 id', { required: true, max: MAX_ID }),
  name: (v) => requireString(v, '预设名称', { max: MAX_NAME }),
  prompt: (v) => requireString(v, '提示词', { required: true, max: MAX_PROMPT }),
};

// ---------- 数组下标校验 ----------
// 点路径里的 N(如 services.N.apiBase)必须是"规范的非负十进制整数",且目标元素已存在。
// 只校验段数不校验下标会带来这些问题:
//   services.foo.name  -> 写入数组的非索引属性,JSON.stringify 时被丢弃,却返回成功
//   services.99.name   -> 越界写入,数组被撑长并产生 undefined 空洞,落盘成了残缺对象
//   services.01.name   -> 前导零不是规范下标,容易与索引 1 混淆
// 因此这里统一收口:格式 + 上限 + 存在性三道检查。
const MAX_ARRAY_INDEX = 9999;   // 配置里的服务/预设数量级远小于此,超限直接拒绝

function assertArrayIndex(seg, field, arr) {
  // 1. 必须是纯数字串(排除 '01'、'-1'、'1.5'、'1e3'、' 1'、'foo' 等)
  if (typeof seg !== 'string' || !/^(0|[1-9]\d*)$/.test(seg)) {
    bad(field + ' 的下标必须是非负十进制整数: ' + String(seg));
  }
  const idx = Number(seg);
  // 2. 上限:防止 Number 精度与数组异常扩张
  if (idx > MAX_ARRAY_INDEX) {
    bad(field + ' 的下标超出允许范围(上限 ' + MAX_ARRAY_INDEX + '): ' + seg);
  }
  // 3. 存在性:只能修改已有元素,不允许用点路径凭空创建
  if (!Array.isArray(arr) || idx >= arr.length) {
    bad(field + ' 的第 ' + idx + ' 项不存在,不能通过点路径创建');
  }
  return idx;
}

// allow 名单来自上面两个表;字段不在名单内说明该路径不允许单独写入
function assertServiceField(field, value) {
  const fn = SERVICE_FIELDS[field];
  if (!fn) bad('不允许单独修改服务字段: ' + String(field));
  return fn(value);
}
function assertPresetField(field, value) {
  const fn = PRESET_FIELDS[field];
  if (!fn) bad('不允许单独修改预设字段: ' + String(field));
  return fn(value);
}

// ---------- 标签 / 随机模式 / 主题 / 布尔 ----------
// 标签:与历史数据保持一致的短字符串上限;add-tag / remove-tag 共用
const MAX_TAG = 60;
function assertTag(tag) {
  return requireString(tag, '标签', { required: true, max: MAX_TAG });
}

// 随机提示词模式白名单:必须与 buildRandomPrompt() 实际支持的分支一致
// (any=完全随机 portrait=锁定人物 scenery=锁定风景 custom=自定义提示词)
const RANDOM_MODES = new Set(['any', 'portrait', 'scenery', 'custom']);
function assertRandomMode(mode) {
  // 缺省视为 any,与拆分前 mode || 'any' 的行为一致
  if (mode === undefined || mode === null || mode === '') return 'any';
  if (!RANDOM_MODES.has(mode)) bad('随机模式不合法: ' + String(mode));
  return mode;
}

// 提示词助手主题:会整段拼进系统提示词,必须有长度上限。
// 阶段1约定:必须是字符串。不接受 null/undefined 被隐式转成空串——
// 渲染层若确实要传"无主题",应传空字符串 '',而不是依赖这里的兜底。
const MAX_THEME = 2000;
function assertTheme(theme) {
  if (typeof theme !== 'string') bad('主题必须是字符串');
  const s = theme.trim();
  if (s.length > MAX_THEME) bad('主题超长(上限 ' + MAX_THEME + ' 字符)');
  return s;
}

// 严格布尔:只接受 true/false,不做 !!v 之类的隐式转换
// ("false" / 1 / "true" 等一律拒绝,避免开机自启开关被字符串误置)
function assertBool(v, field) {
  if (typeof v !== 'boolean') bad((field || '参数') + '必须是布尔值(true/false)');
  return v;
}

// ---------- 收藏文件名 ----------
// 依据 favorite-current 的真实写盘规则: 'fav_' + ts() + '.jpg',
// 其中 ts() 为 yyyyMMdd_HHmmss(见 main.js 的 ts 定义)。
// 只允许删除完全符合该格式的文件,避免误删 favorites 目录里的其它内容。
const FAV_NAME_RE = /^fav_\d{8}_\d{6}\.jpg$/;
const MAX_FAV_NAME = 64;

function assertFavoriteName(name) {
  if (typeof name !== 'string') bad('收藏文件名必须是字符串');
  const s = name.trim();
  if (!s) bad('收藏文件名不能为空');
  if (s.length > MAX_FAV_NAME) bad('收藏文件名超长(上限 ' + MAX_FAV_NAME + ' 字符)');
  // 先拦路径分隔符与穿越,给出更明确的提示
  if (s.includes('/') || s.includes('\\') || s.includes('..')) {
    bad('收藏文件名不能包含路径分隔符或 ".."');
  }
  // 再按真实命名规则白名单校验
  if (!FAV_NAME_RE.test(s)) {
    bad('不是合法的收藏文件名(应为 fav_yyyymmdd_hhmmss.jpg)');
  }
  return s;
}

// 校验失败统一出口
const argFail = (e) => fail('参数无效: ' + ((e && e.message) || '未知校验错误'), ERROR_CODES.E_INVALID_ARG);

module.exports = {
  ArgError, isArgError, argFail,
  assertService, assertPreset, assertId, assertKind, assertReason, assertApiBase,
  assertTag, assertRandomMode, assertTheme, assertBool,
  assertServiceField, assertPresetField, assertArrayIndex, assertFavoriteName,
  RANDOM_MODES, SERVICE_FIELDS, PRESET_FIELDS, MAX_ARRAY_INDEX, FAV_NAME_RE,
};
