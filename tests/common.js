// 测试公共工具:断言、临时目录、真实数据快照、图片桩
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const results = [];
const skipped = [];
let currentGroup = '';
function group(name) { currentGroup = name; }
function record(id, title, pass, evidence) {
  results.push({ id, group: currentGroup, title, pass: !!pass, evidence: evidence === undefined ? '' : String(evidence) });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log('[' + tag + '] ' + id + ' ' + title + (evidence ? '  ::  ' + String(evidence).slice(0, 300) : ''));
  return !!pass;
}
function ok(id, title, cond, evidence) { return record(id, title, cond, evidence); }

// 跳过:本机缺少该用例所需的前置素材(真实旧数据)时使用。
// 关键原则:跳过必须显式打印 [SKIP],绝不静默当作 PASS,否则等于伪造通过。
function skip(id, title, reason) {
  skipped.push({ id, group: currentGroup, title, reason: String(reason === undefined ? '' : reason) });
  console.log('[SKIP] ' + id + ' ' + title + '  ::  ' + String(reason === undefined ? '' : reason));
  return false;
}

const tmpRoots = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'acg-test-'));
  tmpRoots.push(d);
  return d;
}
function cleanupTmp() {
  for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  tmpRoots.length = 0;
}

// 生成一张合法的最小 JPEG 头 + 指定字节数填充(用于 size 校验与字节比对)
function fakeJpeg(size, seed) {
  const buf = Buffer.alloc(size, 0);
  Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]).copy(buf, 0);
  Buffer.from([0xFF, 0xD9]).copy(buf, size - 2);
  const h = crypto.createHash('sha256').update(String(seed === undefined ? '' : seed)).digest();
  for (let i = 4; i < size - 2; i++) buf[i] = h[i % h.length] ^ (i & 0xFF);
  return buf;
}

// 真实用户目录清单快照(名/大小/mtime/内容校验和),用于证明测试未触碰用户数据
function snapshotDir(dir) {
  const out = [];
  // dir 可能为 null(未探测到真实旧数据),先判类型,避免 fs.existsSync 收到非法入参
  if (typeof dir !== 'string' || !dir) return { dir: dir === undefined ? null : dir, exists: false, entries: out };
  if (!fs.existsSync(dir)) return { dir, exists: false, entries: out };
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      const r = rel ? rel + '/' + name : name;
      if (st.isDirectory()) { walk(p, r); continue; }
      const hash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
      out.push({ name: r, size: st.size, mtimeMs: st.mtimeMs, hash });
    }
  };
  walk(dir, '');
  return { dir, exists: true, entries: out };
}
function diffSnapshot(a, b) {
  const key = (s) => JSON.stringify(s.entries);
  if (key(a) === key(b)) return null;
  const mapA = new Map(a.entries.map(e => [e.name, e]));
  const mapB = new Map(b.entries.map(e => [e.name, e]));
  const added = [...mapB.keys()].filter(k => !mapA.has(k));
  const removed = [...mapA.keys()].filter(k => !mapB.has(k));
  const changed = [...mapA.keys()].filter(k => mapB.has(k) && JSON.stringify(mapA.get(k)) !== JSON.stringify(mapB.get(k)));
  return { added, removed, changed };
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function summarize() {
  const fail = results.filter(r => !r.pass);
  return {
    total: results.length,
    passed: results.length - fail.length,
    failed: fail.length,
    failures: fail,
    skipped: skipped.length,
    skips: skipped,
    all: results,
  };
}

// ---------------------------------------------------------------------------
// 真实旧数据目录探测(替代硬编码开发者本机绝对路径)
//
// 探测顺序:
//   1. 环境变量 ACG_REAL_WALLDIR_D / ACG_REAL_WALLDIR_C (显式指定,优先级最高)
//   2. 系统图片目录下的 ACG_Wallpaper (跨机器通用;本机 D 盘被重定向到这里)
//   3. 旧脚本硬编码的 %USERPROFILE%\Pictures\ACG_Wallpaper (C 盘旧产物)
//
// 找不到返回 null —— 调用方必须显式 skip,不得伪造通过。
// ---------------------------------------------------------------------------
function firstExistingWallDir() {
  const candidates = [];
  if (process.env.ACG_REAL_WALLDIR_D) candidates.push(process.env.ACG_REAL_WALLDIR_D);
  // Windows 的 Pictures 实际位置可能被重定向,优先问系统;失败则退回 HOME
  let picDir = '';
  try {
    picDir = execFileSync('powershell.exe', [
      '-NoProfile', '-Command', "[Environment]::GetFolderPath('MyPictures')",
    ], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {}
  if (picDir) candidates.push(path.join(picDir, 'ACG_Wallpaper'));
  try { candidates.push(path.join(os.homedir(), 'Pictures', 'ACG_Wallpaper')); } catch {}
  for (const d of candidates) {
    try { if (d && fs.existsSync(d) && fs.readdirSync(d).length > 0) return d; } catch {}
  }
  return null;
}

function legacyScriptWallDir() {
  const candidates = [];
  if (process.env.ACG_REAL_WALLDIR_C) candidates.push(process.env.ACG_REAL_WALLDIR_C);
  try { candidates.push(path.join(os.homedir(), 'Pictures', 'ACG_Wallpaper')); } catch {}
  for (const d of candidates) {
    try { if (d && fs.existsSync(d)) return d; } catch {}
  }
  return null;
}

module.exports = {
  group, record, ok, skip,
  mkTmp, cleanupTmp, fakeJpeg,
  snapshotDir, diffSnapshot, listFiles, sleep, summarize, results,
  firstExistingWallDir, legacyScriptWallDir,
};
