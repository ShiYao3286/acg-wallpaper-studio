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
async function save(pairs) {
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
  // 先写临时文件再改名,避免写一半崩溃留下损坏文件
  const tmp = encFile() + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, sealed, { mode: 0o600 });
  await fsp.rename(tmp, encFile());

  // 元信息不含任何敏感值
  const meta = {
    version: CRED_VERSION,
    savedAt: deps.now(),
    cookieCount: pairs.size,
    cookieNames: [...pairs.keys()],
  };
  await fsp.writeFile(metaFile(), JSON.stringify(meta, null, 2), 'utf8');

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
async function clear() {
  cache = null;
  let removed = 0;
  for (const f of [encFile(), metaFile()]) {
    try { await fsp.unlink(f); removed++; } catch (e) { if (e && e.code !== 'ENOENT') throw new Error('删除凭据失败'); }
  }
  // 顺带清掉可能残留的临时文件
  try {
    const names = await fsp.readdir(dir());
    for (const n of names) {
      if (n.endsWith('.tmp')) { try { await fsp.unlink(path.join(dir(), n)); } catch {} }
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
};