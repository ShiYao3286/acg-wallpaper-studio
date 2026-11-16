// 凭据服务(阶段 3.3)
//
// 职责:用 Electron safeStorage 加密保存豆包登录 Cookie,并提供最小化读取接口。
//
// 安全边界(逐条都有对应测试):
//   1. 【禁止明文降级】safeStorage 不可用时直接抛错,绝不退化成明文落盘。
//      理由:用户以为"已加密保存",实际是明文 —— 这比保存失败更糟。
//   2. 【不出主进程】本模块不返回原始 Cookie 给任何 Renderer/IPC 通道。
//      对外只暴露 has()/getCookieHeader()/clear()/describe()。
//      getCookieHeader 仅供主进程内的 Transport 使用。
//   3. 【不落普通配置】加密数据写 userData/doubao/credentials.enc,
//      config.json 里绝不出现任何凭据。
//   4. 【不打日志】本模块内无 console 调用;错误信息里的 cookie 值一律脱敏。
//   5. 【只碰豆包】清理时只处理豆包相关数据,不动其他域名。
//
// 存储结构:
//   userData/doubao/credentials.enc   加密后的凭据(二进制)
//   userData/doubao/metadata.json     非敏感元信息(保存时间/字段名/版本)

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;

// 凭据格式版本。将来字段变化时靠它做迁移。
const CRED_VERSION = 1;
const MAX_COOKIE_BYTES = 64 * 1024;   // 正常登录态远小于此;超过视为异常

let deps = {
  userDataDir: '',
  safeStorage: null,   // 由 main.js 注入 electron.safeStorage
  now: () => Date.now(),
};

// 内存缓存:避免每次请求都走一次解密。只缓存 header 字符串,不缓存 Map。
let cache = null;

// ---------- P0-3(阶段3.10):save/clear 写互斥 ----------
//
// 审核确认:save 与 clear 原来没有共用互斥,时序上"退出登录"与"旧登录任务的迟到
// save"交错时,凭据可能被重新写回(退出后凭据复活)。仅靠 PID 命名的临时文件
// 防不了这种竞争——临时文件名只防"同名互踩",不防"写入 vs 删除"的逻辑竞争。
//
// 方案:模块级 Promise 链。save 与 clear 的【完整执行体】都串到同一条链上,
// 后到者等先到者彻底完成(含 rename 与 tmp 清理)才开始。链上失败不阻断后续任务。
let writeChain = Promise.resolve();
function enqueueWrite(task) {
  const run = writeChain.then(task, task);   // 前一个失败也不阻塞后一个
  writeChain = run.catch(() => {});
  return run;
}


function init(opts) {
  deps = Object.assign({}, deps, opts || {});
  cache = null;
}

const dir = () => path.join(deps.userDataDir, 'doubao');
const encFile = () => path.join(dir(), 'credentials.enc');
const metaFile = () => path.join(dir(), 'metadata.json');

// safeStorage 可用性。不可用时上层必须停止保存,不能降级。
function isEncryptionAvailable() {
  try {
    return !!(deps.safeStorage && deps.safeStorage.isEncryptionAvailable());
  } catch { return false; }
}

// 把 name→value 的 Map 拼成 Cookie 头字符串。
// 注意:这个字符串是敏感数据,只在主进程内流转。
function toHeader(pairs) {
  const parts = [];
  for (const [k, v] of pairs) {
    if (typeof k === 'string' && k && typeof v === 'string' && v) parts.push(k + '=' + v);
  }
  return parts.join('; ');
}

// 保存凭据。pairs 是 Map<string,string>。
// 抛错场景:safeStorage 不可用 / 序列化失败 / 写入失败。上层据此停在 error 状态。
//
// P0-4(阶段3.10):提交语义升级。
// 旧实现:enc rename 成功后再写 meta——meta 写失败会留下"enc 在、meta 缺/旧"的
// 半成品,restore() 只看 credentials.enc 是否存在,会把半成品当有效凭据恢复。
// 新实现:两个文件都先写成 tmp,【都成功】后才先后 rename 提交;meta rename 失败时
// 回滚已提交的 enc(删除),保证"保存失败 = 磁盘上没有可被识别为有效的凭据"。
// 回滚本身失败时如实抛错并附带诊断信息(只含文件名与 errno,绝不含 Cookie 值)。
async function save(pairs) {
  return enqueueWrite(() => saveLocked(pairs));
}

async function saveLocked(pairs) {
  if (!isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用,无法保存登录凭据(不会退化为明文保存)');
  }
  if (!pairs || typeof pairs.forEach !== 'function') throw new Error('凭据格式无效');

  const header = toHeader(pairs);
  if (!header) throw new Error('凭据为空,拒绝保存');
  if (Buffer.byteLength(header, 'utf8') > MAX_COOKIE_BYTES) throw new Error('凭据体积异常,拒绝保存');

  const payload = JSON.stringify({
    version: CRED_VERSION,
    savedAt: deps.now(),
    header,
    names: [...pairs.keys()],   // 只存名字,便于诊断;值只在 header 里
  });

  let sealed;
  try {
    sealed = deps.safeStorage.encryptString(payload);
  } catch (e) {
    throw new Error('凭据加密失败: ' + ((e && e.message) || e));
  }
  if (!Buffer.isBuffer(sealed) || sealed.length === 0) throw new Error('凭据加密结果无效');

  await fsp.mkdir(dir(), { recursive: true });
  // 两个 tmp 用同一随机后缀,同批提交/同批回滚,互不混淆。
  // 随机后缀 + 写互斥链双保险:即使链失效(未来有人绕过 enqueueWrite),
  // 同名互踩也不可能发生。
  const tag = process.pid + '.' + Math.random().toString(36).slice(2, 8);
  const tmpEnc = encFile() + '.' + tag + '.tmp';
  const tmpMeta = metaFile() + '.' + tag + '.tmp';

  // 元信息不含任何敏感值
  const meta = {
    version: CRED_VERSION,
    savedAt: deps.now(),
    cookieCount: pairs.size,
    cookieNames: [...pairs.keys()],
  };

  const committedEnc = { done: false };
  try {
    // 阶段一:两个 tmp 都写成功才有资格提交
    await fsp.writeFile(tmpEnc, sealed, { mode: 0o600 });
    await fsp.writeFile(tmpMeta, JSON.stringify(meta, null, 2), 'utf8');
    // 阶段二:rename 提交。enc 先行(它是 has()/restore() 的判据),meta 紧随。
    await fsp.rename(tmpEnc, encFile());
    committedEnc.done = true;
    await fsp.rename(tmpMeta, metaFile());
  } catch (e) {
    // P0-4 回滚:meta 提交失败时删除刚提交的 enc,不留半成品。
    // 已写未提交的 tmp 一并清理。回滚失败必须如实上报,不能吞。
    const rollback = [];
    if (committedEnc.done) {
      try { await fsp.unlink(encFile()); rollback.push('enc已回滚'); }
      catch (re) { rollback.push('enc回滚失败:' + ((re && re.code) || re.message || re)); }
    }
    for (const t of [tmpEnc, tmpMeta]) {
      try { await fsp.unlink(t); rollback.push('tmp已清理'); } catch (te) {
        if (te && te.code !== 'ENOENT') rollback.push('tmp清理失败(' + path.basename(t) + '):' + ((te && te.code) || ''));
      }
    }
    const detail = '凭据保存失败: ' + ((e && e.code) || (e && e.message) || String(e)) +
      (rollback.length ? '; 回滚: ' + rollback.join(', ') : '');
    // 缓存保守失效:半成品/失败状态下不保留旧 header
    cache = null;
    throw new Error(detail);
  }

  cache = { header, savedAt: meta.savedAt };
  return { ok: true, cookieCount: pairs.size };
}

// 读取并解密。返回 { header, names, savedAt } 或抛错。
async function load() {
  if (!isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用,无法读取登录凭据');
  }
  let sealed;
  try {
    sealed = await fsp.readFile(encFile());
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;   // 没登录过,属正常
    throw new Error('读取凭据文件失败: ' + ((e && e.code) || ''));
  }

  let json;
  try {
    json = deps.safeStorage.decryptString(sealed);
  } catch (e) {
    // 解密失败最常见的成因:换了 Windows 用户、系统重装、文件被换掉
    throw new Error('凭据解密失败(可能是在其他系统账户下保存的),请重新登录');
  }

  let obj;
  try { obj = JSON.parse(json); } catch { throw new Error('凭据内容损坏,请重新登录'); }
  if (!obj || typeof obj.header !== 'string' || !obj.header) throw new Error('凭据内容无效,请重新登录');

  return {
    header: obj.header,
    names: Array.isArray(obj.names) ? obj.names : [],
    savedAt: obj.savedAt || 0,
    version: obj.version || 0,
  };
}

// 是否已有可用凭据(不返回内容)
async function has() {
  try {
    const r = await load();
    return !!(r && r.header);
  } catch { return false; }
}

// 【主进程内专用】取 Cookie 头。只应被 doubao-transport 调用。
// 带内存缓存,避免每次请求都解密。
async function getCookieHeader() {
  if (cache && cache.header) return cache.header;
  const r = await load();
  if (!r) return '';
  cache = { header: r.header, savedAt: r.savedAt };
  return r.header;
}

// 清掉内存缓存(凭据失效或退出时调用)
function invalidateCache() { cache = null; }

// 删除凭据。即使文件不存在也算成功(幂等)。
// P0-3:clear 与 save 走同一条写互斥链——串行执行保证"clear 完成后不会被迟到的
// save 重新写回"(迟到的 save 在链上排在 clear 之后,由 auth-manager 的 epoch
// 复核负责不发起新的 save;万一仍然发起了,那是新一轮有效保存,不算复活)。
// 附带清 tmp 的逻辑保持原样,同时把匹配范围收紧到 credentials/metadata 前缀,
// 不误删目录里其它 .tmp(如未来可能出现的会话文件临时副本)。
async function clear() {
  return enqueueWrite(() => clearLocked());
}

async function clearLocked() {
  cache = null;
  let removed = 0;
  for (const f of [encFile(), metaFile()]) {
    try { await fsp.unlink(f); removed++; } catch (e) { if (e && e.code !== 'ENOENT') throw new Error('删除凭据失败'); }
  }
  // 顺带清掉可能残留的临时文件(只清本服务自己的前缀)
  try {
    const names = await fsp.readdir(dir());
    for (const n of names) {
      if ((n.startsWith('credentials.enc') || n.startsWith('metadata.json')) && n.endsWith('.tmp')) {
        try { await fsp.unlink(path.join(dir(), n)); } catch {}
      }
    }
  } catch {}
  return { ok: true, removed };
}

// 给 UI 的状态描述。【绝不含 Cookie 值】
async function describe() {
  const encrypted = isEncryptionAvailable();
  let present = false, savedAt = 0, cookieCount = 0;
  try {
    const r = await load();
    present = !!(r && r.header);
    savedAt = r ? r.savedAt : 0;
    cookieCount = r && Array.isArray(r.names) ? r.names.length : 0;
  } catch (e) {
    return { encryptionAvailable: encrypted, present: false, error: (e && e.message) || String(e) };
  }
  return { encryptionAvailable: encrypted, present, savedAt, cookieCount };
}

module.exports = {
  init, save, load, has, getCookieHeader, invalidateCache, clear, describe,
  isEncryptionAvailable, toHeader, CRED_VERSION, MAX_COOKIE_BYTES,
  // P0-3:等待写互斥链排空。登出流程在 clear 之前调用,保证"在途的迟到 save
  // 先完成、clear 排在其后",避免 logout 的复核读到中间态。
  flushWriteChain: () => writeChain.catch(() => {}),
};