// 豆包会话服务(阶段 3.9/3.10)
//
// 职责边界(与阶段 3.9 架构设计文档 stage3-09-session-design.md 一致):
//   1. 持有当前会话绑定(conversationId / 账号标识 / 代次 / 时间戳)。
//   2. 持久化到 userData/doubao/session.json(明文 JSON,与 credentials.enc 同目录不同文件——
//      会话 ID 不是凭据,泄露无账号风险;两者生命周期同源但内容隔离)。
//   3. 账号绑定判定:accountKey 是 Cookie 关键字段值的 sha256 前缀,原文永不落盘。
//
// 明确不做的事:
//   - 不发任何网络请求(会话创建/续聊由 transport 执行,调度由 main.js 负责);
//   - 不读取/存储 Cookie 值(accountKey 只存哈希);
//   - 不向 Renderer 暴露 conversationId(IPC 只回状态布尔量与时间戳);
//   - 不写普通日志。
//
// 并发:P0-3 同款写互斥链——所有对 session.json 的写入串行,避免"新建会话的新绑定
// 被旧任务的迟到写回覆盖"(任务书第五节)。

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');

const SESSION_VERSION = 1;

let deps = {
  userDataDir: '',
  now: () => Date.now(),
};

// 内存缓存:恢复/读取不走盘
let cache = null;
// 写互斥链(P0-3 同款):setBinding/clearBinding 串行
let writeChain = Promise.resolve();
function enqueueWrite(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

function init(opts) {
  deps = Object.assign({}, deps, opts || {});
  cache = null;
}

const dir = () => path.join(deps.userDataDir, 'doubao');
const file = () => path.join(dir(), 'session.json');

// ---------- 账号绑定标识 ----------
//
// 任务书 3.1:账号绑定用"可靠、非秘密、稳定"的标识,且不得为它增加网络请求;
// 同时 3.10 补充要求:不得默认认为 sessionid/uid_tt 哈希是长期稳定的账号 ID。
//
// 因此这里的语义是【绑定指纹】而不是【账号 ID】:
//   - 同一次登录会话内指纹稳定 → 续聊绑定不会被误判为换号;
//   - 服务端轮换 sessionid(自然过期/重新登录)→ 指纹变化 → 旧绑定作废 → 新会话,
//     行为等同"重新登录清除旧绑定"(任务书 3.1 的兜底条款),永远不会把
//     A 账号的会话 ID 发给 B 账号——错误方向是"多建一次会话",不是"串号"。
//   - 只存 sha256 前 32 位;原文永不写盘、永不进日志。
function computeAccountKey(cookiePairs) {
  if (!cookiePairs || typeof cookiePairs.get !== 'function') return '';
  const sid = cookiePairs.get('sessionid') || '';
  const uid = cookiePairs.get('uid_tt') || '';
  if (!sid && !uid) return '';
  return crypto.createHash('sha256').update(sid + '\u0000' + uid).digest('hex').slice(0, 32);
}

// ---------- 读取与恢复 ----------

// 从磁盘恢复。任何异常都安全降级为 null(无绑定),不阻止应用启动。
// 损坏文件保留现场(不删除),下次 setBinding 自然覆盖。
async function restore() {
  cache = null;
  let raw;
  try {
    raw = await fsp.readFile(file(), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;   // 首次使用,正常
    return null;                                  // 读取失败(权限等)→ 无绑定
  }
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }              // 损坏
  if (!obj || typeof obj !== 'object') return null;                  // 损坏
  if (obj.version !== SESSION_VERSION) return null;                  // 版本不兼容
  if (typeof obj.conversationId !== 'string' || !obj.conversationId) return null;  // 无效绑定
  if (typeof obj.accountKey !== 'string' || !obj.accountKey) return null;
  cache = {
    conversationId: obj.conversationId,
    accountKey: obj.accountKey,
    generation: Number.isInteger(obj.generation) && obj.generation > 0 ? obj.generation : 1,
    createdAt: Number(obj.createdAt) || 0,
    lastUsedAt: Number(obj.lastUsedAt) || 0,
  };
  return { ...cache };
}

// 读当前绑定(内存优先)。defunct=true 表示绑定存在但已判定失效(会话失效流程置位)。
function getBinding() {
  if (!cache) return null;
  return {
    conversationId: cache.conversationId,
    accountKey: cache.accountKey,
    generation: cache.generation,
    createdAt: cache.createdAt,
    lastUsedAt: cache.lastUsedAt,
    defunct: !!cache.defunct,
  };
}

// 绑定是否存在且可用于续聊(未失效)
function hasLiveBinding() {
  return !!(cache && cache.conversationId && !cache.defunct);
}

// ---------- 写入 ----------

// 保存/更新绑定。传入的 expectedGeneration 是调用方记录的代次快照:
// 写入前复核当前代次,不一致则拒绝写回(任务书第五节:旧 generation 不得写回任何状态)。
// 返回 { ok:true, generation } 或 { ok:false, reason }。
async function setBinding(data) {
  return enqueueWrite(async () => {
    if (!data || typeof data.conversationId !== 'string' || !data.conversationId) {
      return { ok: false, reason: 'conversationId 无效' };
    }
    if (!data.accountKey) return { ok: false, reason: 'accountKey 缺失' };
    if (cache && Number.isInteger(data.expectedGeneration) && data.expectedGeneration !== cache.generation) {
      return { ok: false, reason: '代次已变更', generation: cache.generation };
    }
    const gen = cache ? cache.generation : 1;
    cache = {
      conversationId: data.conversationId,
      accountKey: data.accountKey,
      generation: gen,
      createdAt: cache ? (cache.createdAt || deps.now()) : deps.now(),
      lastUsedAt: deps.now(),
      defunct: false,
    };
    await writeThrough(cache);
    return { ok: true, generation: gen };
  });
}

// 会话失效标记(710020202 流程):保留 generation 与 accountKey,只清 conversationId 并置 defunct。
// 下一次请求按"首次创建"走。expectedGeneration 同样受代次保护。
async function markSessionInvalid(expectedGeneration) {
  return enqueueWrite(async () => {
    if (!cache) return { ok: false, reason: '无绑定' };
    if (Number.isInteger(expectedGeneration) && expectedGeneration !== cache.generation) {
      return { ok: false, reason: '代次已变更', generation: cache.generation };
    }
    cache.defunct = true;
    await writeThrough({ ...cache, conversationId: '' });
    return { ok: true, generation: cache.generation };
  });
}

// 用户新建会话:代次 +1,清 conversationId,立即落盘(此刻起旧 ID 不可再用)。
async function newSession(accountKey) {
  return enqueueWrite(async () => {
    const gen = (cache ? cache.generation : 0) + 1;
    cache = {
      conversationId: '',
      accountKey: accountKey || (cache ? cache.accountKey : ''),
      generation: gen,
      createdAt: deps.now(),
      lastUsedAt: 0,
      defunct: false,
    };
    await writeThrough(cache);
    return { ok: true, generation: gen };
  });
}

// 账号切换判定:传入当前凭据的 accountKey,与绑定不符则作废旧绑定。
// 返回 { changed:true } 表示旧绑定因账号不符被清除。
async function reconcileAccount(accountKey) {
  if (!cache) return { changed: false, binding: null };
  if (cache.accountKey && accountKey && cache.accountKey !== accountKey) {
    await clearBinding();
    return { changed: true, binding: null };
  }
  return { changed: false, binding: getBinding() };
}

// 清空绑定(登出/换号)。代次 +1 使一切在途写回失效。
async function clearBinding() {
  return enqueueWrite(async () => {
    const gen = (cache ? cache.generation : 0) + 1;
    cache = null;
    try { await fsp.unlink(file()); } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
    // 残留 tmp 清理(只清本服务前缀)
    try {
      const names = await fsp.readdir(dir());
      for (const n of names) {
        if (n.startsWith('session.json') && n.endsWith('.tmp')) {
          try { await fsp.unlink(path.join(dir(), n)); } catch {}
        }
      }
    } catch {}
    return { ok: true, generation: gen };
  });
}

// 更新最近使用时间。内存即时,落盘节流(30 秒)——高频请求下避免频繁 rename。
let lastFlush = 0;
function markUsed() {
  if (!cache) return;
  cache.lastUsedAt = deps.now();
  const now = deps.now();
  if (now - lastFlush > 30000) {
    lastFlush = now;
    const snap = { ...cache };
    enqueueWrite(() => writeThrough(snap)).catch(() => {});
  }
}

// 原子写盘:唯一临时文件名(随机后缀,防并发 rename 互踩)→ rename。
async function writeThrough(data) {
  await fsp.mkdir(dir(), { recursive: true });
  const tmp = file() + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  const payload = {
    version: SESSION_VERSION,
    conversationId: data.conversationId || '',
    accountKey: data.accountKey || '',
    generation: data.generation || 1,
    createdAt: data.createdAt || 0,
    lastUsedAt: data.lastUsedAt || 0,
    // defunct 不落盘:失效是运行时状态,重启后磁盘绑定视为可用,
    // 由首次请求的服务端响应决定去留(响应丢失/解析异常不假设服务端无副作用)。
  };
  try {
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rename(tmp, file());
  } catch (e) {
    try { await fsp.unlink(tmp); } catch {}
    throw e;
  }
}

// 等待写链排空(测试与登出流程用)
function flushWriteChain() { return writeChain.catch(() => {}); }

// 仅供测试
function __reset() { cache = null; writeChain = Promise.resolve(); }

module.exports = {
  init, restore, getBinding, hasLiveBinding, setBinding, markSessionInvalid,
  newSession, reconcileAccount, clearBinding, markUsed, computeAccountKey,
  flushWriteChain, __reset,
  SESSION_VERSION,
};
