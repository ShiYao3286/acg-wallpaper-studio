// Provider 注册表(阶段 2)
//
// 职责:登记 Provider、按 kind / id 查询、启用停用、列出全部。
// 不负责:调用 Provider(由业务代码拿 Provider 后自己调)、加载外部插件文件(后续步骤)。
//
// 设计约束:
//   1. 注册时立即走 describeProvider() 校验,坏 Provider 注册不进来。
//      这样"协议错误"在注册这一刻暴露,而不是等到用户点"立即换一张"才炸。
//   2. 重复 id 直接拒绝,不静默覆盖 —— 内置 Provider 与外部插件撞 id 时,
//      静默覆盖会导致"用户以为装了插件,实际还是内置实现"这种极难排查的问题。
//   3. 不依赖 electron / fs,纯内存注册表,便于单测。
//   4. 存的是 { provider(元数据), impl(实现) } 两份:元数据可安全外传(如给 UI),
//      实现只在主进程内部使用,避免把函数引用漏给渲染层。

const { describeProvider, isProtocolError, ProtocolError } = require('./provider-protocol');

// id -> { provider: 元数据, impl: 原始对象(含方法) }
const registry = new Map();
// 被禁用的 id 集合:停用后不参与 listByKind() 查询,但仍保留在 registry 中,
// 这样重新启用时不需要重新注册。
const disabled = new Set();

function assertNotRegistered(id) {
  if (registry.has(id)) {
    throw new ProtocolError('Provider id 已被注册: ' + id);
  }
}

// 注册:raw 必须是完整 Provider 对象(含实现方法)
//
// 幂等策略(重要):
//   registry 是模块级单例,而 main.js 可能在同一进程内被多次加载
//   (测试脚手架用 Module._load 钩子反复 loadMain 就是这种情况,热重载同理)。
//   若重复注册直接抛错,第二次加载 main.js 就会启动失败。
//   因此这里按 id 做幂等覆盖:同一个 id 再次注册时校验通过就替换实现,
//   不同实现(比如版本变了)也能正确更新。
//   真正的"id 冲突"由 registerAll() 拦截 —— 那里能区分"同一批里的重复 id"。
function register(raw) {
  const provider = describeProvider(raw);   // 校验失败会抛 ProtocolError
  registry.set(provider.id, { provider, impl: raw });
  disabled.delete(provider.id);
  return provider;
}

// 批量注册:任一失败则整体失败,不做"部分成功"。
// 否则启动时一个坏内置 Provider 会导致"注册了一半"的隐晦状态。
// 同一批内出现重复 id 属于编程错误,直接拒绝;
// 但允许覆盖"上一轮已注册"的同 id(见 register 的幂等说明)。
function registerAll(list) {
  if (!Array.isArray(list)) throw new ProtocolError('registerAll 需要数组');
  const described = list.map(describeProvider);        // 先全部校验
  const seen = new Set();
  for (const p of described) {
    if (seen.has(p.id)) throw new ProtocolError('registerAll 中存在重复 id: ' + p.id);
    seen.add(p.id);
  }
  for (let i = 0; i < described.length; i++) {
    registry.set(described[i].id, { provider: described[i], impl: list[i] });
    disabled.delete(described[i].id);
  }
  return described;
}

function has(id) { return registry.has(id); }

// 取实现对象:业务代码用它调用实际逻辑。未注册或已禁用都返回 null。
function get(id) {
  if (disabled.has(id)) return null;
  const e = registry.get(id);
  return e ? e.impl : null;
}

// 取元数据(可安全外传):不含实现函数
function getMeta(id) {
  const e = registry.get(id);
  return e ? { ...e.provider } : null;
}

// 按 kind 列出可用的元数据
function listByKind(kind) {
  const out = [];
  for (const [id, e] of registry) {
    if (disabled.has(id)) continue;
    if (e.provider.kind === kind) out.push({ ...e.provider });
  }
  return out;
}

// 列出全部元数据(含禁用状态,供 UI 展示)
function list() {
  const out = [];
  for (const [id, e] of registry) {
    out.push({ ...e.provider, enabled: !disabled.has(id) });
  }
  return out;
}

function setEnabled(id, on) {
  if (!registry.has(id)) return false;
  if (on) disabled.delete(id); else disabled.add(id);
  return true;
}

function isEnabled(id) { return registry.has(id) && !disabled.has(id); }

// 仅供测试:清空注册表
function reset() { registry.clear(); disabled.clear(); }

function size() { return registry.size; }

module.exports = {
  register, registerAll, has, get, getMeta,
  listByKind, list, setEnabled, isEnabled, reset, size,
};
