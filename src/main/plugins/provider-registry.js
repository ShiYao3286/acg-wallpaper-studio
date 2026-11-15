// Provider 注册表(阶段 2)
//
// 职责:登记 Provider、按 kind / id 查询、启用停用、列出全部。
// 不负责:调用 Provider(由业务代码拿 Provider 后自己调)、加载外部插件文件(后续步骤)。
//
// 设计约束:
//   1. 注册时立即走 describeProvider() 校验,坏 Provider 注册不进来。
//      这样"协议错误"在注册这一刻暴露,而不是等到用户点"立即换一张"才炸。
//   2. id 冲突规则(审核修复,2026-11-15):
//      - 内置 Provider 严格幂等:同 id 已注册时,再次注册【不替换实现、不改 enabled 状态】。
//        (registry 是模块级单例,main.js 在同进程内会被多次加载,
//         测试脚手架用 Module._load 钩子反复 loadMain 就依赖"重复注册不报错",
//         但"不报错"不等于"允许替换" —— 严格幂等更安全,也符合注释里说的幂等语义。)
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

// 判断一条注册是否会与现有 registry 冲突。冲突时抛错;不冲突返回 null。
// 抽成独立函数,供 register() 与 registerAll() 的预检共用同一套规则,
// 避免"预检一套规则、落库另一套规则"造成两者漂移。
function checkConflict(provider) {
  const existing = registry.get(provider.id);
  if (!existing) return null;                     // 无冲突

  const existingBuiltin = existing.provider.builtin === true;
  const incomingBuiltin = provider.builtin === true;

  if (existingBuiltin && !incomingBuiltin) {
    throw new ProtocolError(
      'Provider id 与内置实现冲突,拒绝外部插件覆盖: ' + provider.id);
  }
  if (!existingBuiltin && !incomingBuiltin) {
    throw new ProtocolError(
      'Provider id 已被另一个外部插件注册: ' + provider.id);
  }
  // 内置 vs 内置:不冲突,但调用方需按"严格幂等"处理(不替换)
  return { existing, existingBuiltin, incomingBuiltin };
}

// 注册:raw 必须是完整 Provider 对象(含实现方法)
//
// 冲突规则见文件头设计约束第 2 条。要点:
//   - 内置 vs 内置:严格幂等 —— 已存在则什么都不改(不替换实现、不动 enabled 状态)
//   - 外部 vs 内置:拒绝
//   - 外部 vs 外部:拒绝
//   - 同批内重复:由 registerAll 拒绝
function register(raw) {
  const provider = describeProvider(raw);   // 校验失败会抛 ProtocolError
  const conflict = checkConflict(provider);

  // 严格幂等:内置已注册时直接返回现存描述,不写 registry、不动 disabled
  if (conflict && conflict.existingBuiltin && conflict.incomingBuiltin) {
    return { ...conflict.existing.provider };
  }

  registry.set(provider.id, { provider, impl: raw });
  disabled.delete(provider.id);
  return provider;
}

// 批量注册:真正的"任一失败则整体失败,不做部分成功"。
//
// 旧实现先校验批内重复、再逐条 register(),没有预先检查整批与现有 registry 的冲突,
// 于是可能出现"前两个已落库、第三个冲突抛错"的半完成状态 —— 与注释承诺不符。
// 现在改为【预检 -> 提交】两阶段:
//   阶段一(只读):协议校验 + 批内重复 + 与现有 registry 冲突,全部通过才继续
//   阶段二(写入):一次性写入,不再有任何可能失败的判断
// 不使用"失败后回滚"来掩盖非原子实现。
function registerAll(list) {
  if (!Array.isArray(list)) throw new ProtocolError('registerAll 需要数组');

  // ---------- 阶段一:只读预检(任何一步失败,registry 与 disabled 均不变) ----------
  const described = list.map(describeProvider);        // 1. 协议校验

  const seen = new Set();                              // 2. 批内重复
  for (const p of described) {
    if (seen.has(p.id)) throw new ProtocolError('registerAll 中存在重复 id: ' + p.id);
    seen.add(p.id);
  }

  // 3. 与现有 registry 的冲突(复用 register 的 checkConflict,规则单一来源)
  //    内置 vs 内置不算冲突,但按严格幂等策略应跳过写入,这里先算出结果。
  const toWrite = [];
  for (let i = 0; i < described.length; i++) {
    const conflict = checkConflict(described[i]);      // 冲突会在这里抛出
    if (conflict && conflict.existingBuiltin && conflict.incomingBuiltin) {
      continue;                                        // 严格幂等:已存在,跳过
    }
    toWrite.push(i);
  }

  // ---------- 阶段二:统一写入(此处不再有失败分支) ----------
  for (const i of toWrite) {
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
