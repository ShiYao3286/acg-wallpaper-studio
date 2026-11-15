// Provider 注册表(阶段 2)
//
// 职责:登记 Provider、按 kind / id 查询、启用停用、列出全部。
// 不负责:调用 Provider(由业务代码拿 Provider 后自己调)、加载外部插件文件(后续步骤)。
//
// 设计约束:
//   1. 注册时立即走 describeProvider() 校验,坏 Provider 注册不进来。
//      这样"协议错误"在注册这一刻暴露,而不是等到用户点"立即换一张"才炸。
//   2. id 冲突规则(审核修复,2026-11-15):
//      - 内置 Provider 幂等重复注册:允许(registry 是模块级单例,main.js 在同进程内
//        会被多次加载,测试脚手架用 Module._load 钩子反复 loadMain 就依赖这条)。
//      - 外部 Provider 覆盖任何已注册的内置 Provider:拒绝。
//        否则把插件目录与 manifest.id 都写成 lolicon,启用后就能顶掉内置实现,
//        fetchLolicon() 拿到的将是第三方代码 —— 这是可被劫持的入口。
//      - 外部 Provider 之间重复 id:拒绝(避免"以为更新了插件,其实是两个实现打架")。
//      - 同一批次(registerAll)内重复 id:拒绝。
//      全部冲突都抛 ProtocolError,绝不依赖 Map.set() 静默覆盖。
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
// 冲突规则见文件头设计约束第 2 条。要点:
//   - 内置 vs 内置:允许(幂等重复注册)
//   - 外部 vs 内置:拒绝
//   - 外部 vs 外部:拒绝
//   - 同批内重复:由 registerAll 拒绝
function register(raw) {
  const provider = describeProvider(raw);   // 校验失败会抛 ProtocolError
  const existing = registry.get(provider.id);

  if (existing) {
    const existingBuiltin = existing.provider.builtin === true;
    const incomingBuiltin = provider.builtin === true;

    // 外部不得覆盖任何已注册的内置实现
    if (existingBuiltin && !incomingBuiltin) {
      throw new ProtocolError(
        'Provider id 与内置实现冲突,拒绝外部插件覆盖: ' + provider.id);
    }
    // 外部与外部之间也不允许重复 id
    if (!existingBuiltin && !incomingBuiltin) {
      throw new ProtocolError(
        'Provider id 已被另一个外部插件注册: ' + provider.id);
    }
    // 内置 vs 内置:落到下面的 set,保持幂等
  }

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

  // 同一批次内重复 id 属于编程错误:先把整批校验完再落库,避免"注册了一半"
  const seen = new Set();
  for (const p of described) {
    if (seen.has(p.id)) throw new ProtocolError('registerAll 中存在重复 id: ' + p.id);
    seen.add(p.id);
  }

  // 再逐条走 register(),复用同一套内置/外部冲突规则,不另写一份判断
  for (let i = 0; i < described.length; i++) {
    register(list[i]);
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
