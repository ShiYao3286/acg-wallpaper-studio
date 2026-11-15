// Provider 协议(阶段 2)
//
// 目的:把原先散落在 main.js 里的取图/生图/文本调用收敛成统一接口,
// 让插件系统有明确的挂载点。本文件只定义"Provider 长什么样"和"如何校验",
// 不执行任何 Provider 逻辑,也不依赖 electron / fs。
//
// 设计约束:
//   1. Provider 不得直接 require('electron') 或读写文件系统,
//      只能通过 ctx 注入的能力(netFetch / config)做事 —— 这是权限边界的基础。
//   2. 协议校验全部是"纯函数 + 抛 ArgError",不产生副作用,便于单测。
//   3. 内置 Provider 与未来外部插件走同一套校验,不存在"内部信任"的后门。

const { fail, ERROR_CODES } = require('../../shared/contracts');

// Provider 类型白名单。
//   image-source: 随机图源(如 Lolicon),不需要用户 API Key
//   image-gen   : 文生图(如 OpenAI 兼容 /v1/images/generations)
//   text        : 文本生成(如 /v1/chat/completions),用于提示词扩写
const PROVIDER_KINDS = new Set(['image-source', 'image-gen', 'text']);

// 能力声明白名单:Provider 声明的能力必须在此集合内,避免拼写错误被静默接受。
//   fetch-random  取一张随机图          image-source
//   generate      按提示词生成图        image-gen
//   complete      按 messages 生成文本  text
//   list-models   列出可用模型          image-gen / text
//   test-conn     连通性测试            image-gen / text
const CAPABILITIES = new Set(['fetch-random', 'generate', 'complete', 'list-models', 'test-conn']);

// 每种 kind 必须具备的能力:缺了就是协议错误,而不是运行时才炸
const REQUIRED_CAPABILITIES = {
  'image-source': ['fetch-random'],
  'image-gen': ['generate'],
  'text': ['complete'],
};

const MAX_ID = 64;
const MAX_NAME = 120;
const MAX_VERSION = 32;
const MAX_CAPABILITIES = 8;

class ProtocolError extends Error {
  constructor(msg) { super(msg); this.name = 'ProtocolError'; this.isProtocolError = true; }
}
const bad = (msg) => { throw new ProtocolError(msg); };
const isProtocolError = (e) => !!(e && e.isProtocolError);

// id 会用于目录名(userData/plugins/<id>/),因此必须严格限制字符集,
// 否则 ../ 这类 id 能把插件目录逃逸到任意位置。
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function assertProviderId(id) {
  if (typeof id !== 'string') bad('Provider id 必须是字符串');
  const s = id.trim();
  if (!s) bad('Provider id 不能为空');
  if (s.length > MAX_ID) bad('Provider id 超长(上限 ' + MAX_ID + ' 字符)');
  if (!ID_RE.test(s)) bad('Provider id 只能包含小写字母、数字、下划线和连字符,且必须以字母或数字开头: ' + s);
  return s;
}

function assertProviderKind(kind) {
  if (!PROVIDER_KINDS.has(kind)) {
    bad('Provider 类型不合法: ' + String(kind) + '(允许: ' + [...PROVIDER_KINDS].join(', ') + ')');
  }
  return kind;
}

function assertCapabilities(caps, kind) {
  if (!Array.isArray(caps)) bad('Provider capabilities 必须是数组');
  if (caps.length > MAX_CAPABILITIES) bad('Provider capabilities 数量超限(上限 ' + MAX_CAPABILITIES + ')');
  const out = [];
  for (const c of caps) {
    if (typeof c !== 'string') bad('Provider capability 必须是字符串');
    if (!CAPABILITIES.has(c)) bad('Provider 能力未定义: ' + c + '(允许: ' + [...CAPABILITIES].join(', ') + ')');
    if (!out.includes(c)) out.push(c);
  }
  const need = REQUIRED_CAPABILITIES[kind] || [];
  for (const r of need) {
    if (!out.includes(r)) bad('Provider 类型 ' + kind + ' 必须具备能力: ' + r);
  }
  return out;
}

// configSchema 只做形状校验,不做深层语义校验:
//   它描述"这个 Provider 需要用户填哪些字段",具体字段值由各 Provider 自己校验。
function assertConfigSchema(schema) {
  if (schema === undefined || schema === null) return {};
  if (typeof schema !== 'object' || Array.isArray(schema)) bad('Provider configSchema 必须是对象');
  const out = {};
  for (const key of Object.keys(schema)) {
    const f = schema[key];
    if (!f || typeof f !== 'object' || Array.isArray(f)) bad('configSchema.' + key + ' 必须是对象');
    const type = f.type;
    if (!['string', 'number', 'boolean'].includes(type)) {
      bad('configSchema.' + key + '.type 必须是 string/number/boolean,实际: ' + String(type));
    }
    out[key] = {
      type,
      required: f.required === true,
      label: typeof f.label === 'string' ? f.label.slice(0, MAX_NAME) : key,
    };
  }
  return out;
}

// 协议校验入口:返回一个"已规范化"的 Provider 描述对象(仅元数据,不含实现)。
// 注意:实现函数(async fetch/generate/complete)不在此校验,
//       因为它们的行为只能通过调用验证,形状校验只保证它是函数。
function describeProvider(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('Provider 必须是对象');

  const kind = assertProviderKind(raw.kind);
  const provider = {
    id: assertProviderId(raw.id),
    name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim().slice(0, MAX_NAME) : raw.id,
    version: (typeof raw.version === 'string' && raw.version.trim()) ? raw.version.trim().slice(0, MAX_VERSION) : '0.0.0',
    kind,
    capabilities: assertCapabilities(raw.capabilities === undefined ? [] : raw.capabilities, kind),
    configSchema: assertConfigSchema(raw.configSchema),
    builtin: raw.builtin === true,
  };

  // 每种 kind 对应一个必须实现的方法
  const methodByKind = { 'image-source': 'fetch', 'image-gen': 'generate', 'text': 'complete' };
  const required = methodByKind[kind];
  if (typeof raw[required] !== 'function') {
    bad('Provider ' + provider.id + ' 类型为 ' + kind + ',必须实现 ' + required + '() 方法');
  }
  return provider;
}

// 供 registry 使用的失败转换:把协议错误转成统一错误契约
function protocolFail(err) {
  if (isProtocolError(err)) return fail(err.message, ERROR_CODES.E_INVALID_ARG);
  return fail((err && err.message) || String(err), ERROR_CODES.E_STATE);
}

module.exports = {
  PROVIDER_KINDS,
  CAPABILITIES,
  REQUIRED_CAPABILITIES,
  ProtocolError,
  isProtocolError,
  assertProviderId,
  assertProviderKind,
  assertCapabilities,
  assertConfigSchema,
  describeProvider,
  protocolFail,
};
