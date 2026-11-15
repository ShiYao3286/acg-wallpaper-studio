// 外部插件加载器(阶段 2 第 4 步)
//
// 职责:从 userData/plugins/<id>/ 发现插件、校验 manifest、加载实现、注册进 registry。
//
// 安全边界(本文件最重要的设计):
//   1. 外部插件默认【不启用】。加载器只负责"发现 + 登记为禁用态",
//      用户必须在设置里显式开启才会真正 require 其代码。
//      这样即使用户把来路不明的插件丢进目录,也不会在启动时自动执行。
//   2. manifest 里的 id 必须与目录名一致,且通过 provider-protocol 的 id 白名单校验,
//      防止用 ../ 之类把加载路径逃逸出 plugins 目录。
//   3. 插件入口文件路径必须解析后仍位于插件自身目录内(防符号链接/相对路径逃逸)。
//   4. 单个插件加载失败不影响其他插件,也不阻塞主程序启动 —— 全部按"跳过并记录原因"处理。
//   5. 加载器不 require electron,不直接读写业务数据,只做文件发现与 require。

const path = require('node:path');
const fs = require('node:fs');
const protocol = require('./provider-protocol');

// manifest 文件名。放在插件目录下,与 index.js 同级。
const MANIFEST_NAME = 'manifest.json';
// 插件入口默认文件名;manifest 可用 main 字段覆盖。
const DEFAULT_ENTRY = 'index.js';
// 单个 manifest 最大字节数:防止把巨型文件当 manifest 读进内存。
const MAX_MANIFEST_BYTES = 64 * 1024;

// 判断是否为"真目录":符号链接一律不算。
// 必须用 lstatSync(不跟随链接)—— statSync 会跟随链接,把指向外部的 junction
// 当成普通目录放行,后续所有基于该目录的校验都会建立在不可信前提上。
function isDir(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return false;
    return st.isDirectory();
  } catch { return false; }
}

// 是否符号链接(不跟随)。用于给出比"不是目录"更准确的拒绝原因。
function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// 取真实路径(解析所有符号链接/junction)。失败(不存在/无权限/循环链接)返回 null。
function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// 判断 child 是否确实位于 parent 之内。
//
// 刻意不使用 child.startsWith(parent) —— 字符串前缀判断有两个真实缺陷:
//   1. /a/plugin 与 /a/plugin-evil 会被误判为同目录(必须靠分隔符补救,
//      而分隔符处理在 Windows 上还有 / 与 \ 混用的问题);
//   2. 前缀判断对大小写、短路径(8.3)、UNC 前缀等都不敏感,容易漏判。
// 这里改用 path.relative():若返回以 .. 开头或是绝对路径,说明不在内部。
function isInside(parentInput, childInput) {
  if (!parentInput || !childInput) return false;
  const parent = path.resolve(parentInput);
  const child = path.resolve(childInput);
  const rel = path.relative(parent, child);
  // rel 为空表示两者相同(视为在内部:入口文件等于插件目录本身不在正常范围,
  // 但对"插件目录 vs 根目录"这种比较需要允许相等)
  if (rel === '') return true;
  // 以 .. 开头 -> 跑到了父级;是绝对路径 -> 换到别的盘符/根
  if (rel.startsWith('..' + path.sep) || rel === '..') return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function readManifest(pluginDir) {
  const file = path.join(pluginDir, MANIFEST_NAME);
  let st;
  try { st = fs.statSync(file); } catch { return { ok: false, reason: '缺少 ' + MANIFEST_NAME }; }
  if (!st.isFile()) return { ok: false, reason: MANIFEST_NAME + ' 不是普通文件' };
  if (st.size > MAX_MANIFEST_BYTES) return { ok: false, reason: MANIFEST_NAME + ' 过大(上限 ' + MAX_MANIFEST_BYTES + ' 字节)' };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, reason: '读取失败: ' + ((e && e.message) || e) }; }
  // 旧脚本可能用 PowerShell 5.1 写入并带 BOM,这里复用同样的剥除逻辑
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'JSON 解析失败: ' + ((e && e.message) || e) }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'manifest 必须是对象' };
  return { ok: true, manifest: obj };
}

// 入口文件解析:必须落在插件目录内,且不能是符号链接。
//
// 三层防护:
//   1. 字面路径:拦住 ../../evil.js 这类显式相对穿越;
//   2. lstat:入口本身是符号链接 -> 拒绝(指哪都不行,包括指向插件目录内);
//   3. realpath:取真实路径后再做一次"是否位于插件真实目录内"的判断,
//      兜住任何经由父级链接间接逃逸的情况。
function resolveEntry(pluginDir, manifest) {
  const name = typeof manifest.main === 'string' && manifest.main.trim() ? manifest.main.trim() : DEFAULT_ENTRY;
  const full = path.resolve(pluginDir, name);
  const base = path.resolve(pluginDir);

  // 1. 字面穿越
  if (!isInside(base, full)) {
    return { ok: false, reason: '入口文件逃逸出插件目录: ' + name };
  }

  // 2. 入口是符号链接:直接拒绝
  //    允许"指向插件目录内"的链接看起来更宽容,但那会让 realpath 之后的判断
  //    变成"链接指向谁",而不是"用户实际放了什么文件" —— 语义不清,直接拒绝最简单。
  if (isSymlink(full)) {
    return { ok: false, reason: '入口文件是符号链接,拒绝加载: ' + name };
  }

  try {
    if (!fs.lstatSync(full).isFile()) return { ok: false, reason: '入口不是普通文件: ' + name };
  } catch { return { ok: false, reason: '入口文件不存在: ' + name }; }

  // 3. realpath 复核
  const realBase = safeRealpath(base);
  const realFull = safeRealpath(full);
  if (!realBase) return { ok: false, reason: '插件目录真实路径解析失败(可能已被删除)' };
  if (!realFull) return { ok: false, reason: '入口文件真实路径解析失败(可能已被删除)' };
  if (!isInside(realBase, realFull)) {
    return { ok: false, reason: '入口文件真实路径逃逸出插件目录: ' + name };
  }

  return { ok: true, entry: realFull };
}

// 发现:只做磁盘扫描 + manifest 校验,不执行任何插件代码。
// 返回 { found: [{id, dir, manifest, entry}], skipped: [{dir, reason}] }
function discover(pluginsRoot) {
  const found = [];
  const skipped = [];
  if (!pluginsRoot) return { found, skipped };

  // 插件根目录本身是符号链接:直接拒绝,不做部分扫描。
  // 理由:根目录一旦指向别处,"插件只能来自 userData/plugins"这个信任前提就不成立了,
  // 此时对子目录做的任何校验都建立在不可信基础上。宁可整体拒绝并给出明确原因。
  if (isSymlink(pluginsRoot)) {
    return { found, skipped: [{ dir: pluginsRoot, reason: '插件根目录是符号链接,拒绝扫描' }] };
  }
  if (!isDir(pluginsRoot)) return { found, skipped };

  const realRoot = safeRealpath(pluginsRoot);
  if (!realRoot) {
    return { found, skipped: [{ dir: pluginsRoot, reason: '插件根目录真实路径解析失败' }] };
  }

  let names;
  try { names = fs.readdirSync(pluginsRoot).sort(); } catch (e) {
    return { found, skipped: [{ dir: pluginsRoot, reason: '目录不可读: ' + ((e && e.message) || e) }] };
  }
  for (const name of names) {
    const dir = path.join(pluginsRoot, name);

    // 插件目录是符号链接(junction):拒绝。
    // isDir() 已用 lstat 拦掉链接,这里单独判断一次是为了给出准确原因,
    // 而不是让用户看到"我明明放了个目录却什么都没发生"。
    if (isSymlink(dir)) {
      skipped.push({ dir, reason: '插件目录是符号链接,拒绝加载' });
      continue;
    }
    if (!isDir(dir)) continue;   // 散落的普通文件直接忽略,不算错误

    // 真实路径必须仍位于真实根目录内(兜住父级链接等间接逃逸)
    const realDir = safeRealpath(dir);
    if (!realDir) { skipped.push({ dir, reason: '插件目录真实路径解析失败' }); continue; }
    if (!isInside(realRoot, realDir)) {
      skipped.push({ dir, reason: '插件目录真实路径逃逸出插件根目录' });
      continue;
    }

    const mr = readManifest(dir);
    if (!mr.ok) { skipped.push({ dir, reason: mr.reason }); continue; }
    const man = mr.manifest;
    // id 必须存在、合法,且与目录名一致 —— 否则用户看到的名字与实际目录对不上,极难排查
    let id;
    try { id = protocol.assertProviderId(man.id); }
    catch (e) { skipped.push({ dir, reason: 'manifest.id 非法: ' + ((e && e.message) || e) }); continue; }
    if (id !== name) { skipped.push({ dir, reason: 'manifest.id(' + id + ') 与目录名(' + name + ') 不一致' }); continue; }
    const er = resolveEntry(dir, man);
    if (!er.ok) { skipped.push({ dir, reason: er.reason }); continue; }
    found.push({ id, dir, manifest: man, entry: er.entry });
  }
  return { found, skipped };
}

// 加载单个插件实现:只有用户显式启用时才会调用这里。
// 返回 { ok:true, provider } 或 { ok:false, reason }
function loadOne(item) {
  let mod;
  try { mod = require(item.entry); }
  catch (e) { return { ok: false, reason: 'require 失败: ' + ((e && e.message) || e) }; }
  // 允许两种导出形态:直接导出 Provider 对象,或导出 { provider }
  const raw = (mod && mod.provider) ? mod.provider : mod;
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '入口未导出 Provider 对象' };
  // manifest 里的元数据优先于代码里的声明:使用户可读的 manifest 成为唯一事实来源
  const merged = Object.assign({}, raw, {
    id: item.id,
    name: (typeof item.manifest.name === 'string' && item.manifest.name.trim()) ? item.manifest.name : raw.name,
    kind: item.manifest.kind || raw.kind,
    capabilities: item.manifest.capabilities || raw.capabilities,
    builtin: false,
  });
  try { protocol.describeProvider(merged); }
  catch (e) { return { ok: false, reason: '协议校验失败: ' + ((e && e.message) || e) }; }
  return { ok: true, provider: merged };
}

module.exports = {
  MANIFEST_NAME, DEFAULT_ENTRY, MAX_MANIFEST_BYTES,
  discover, loadOne, readManifest, resolveEntry,
  // 纯函数工具,供单测直接验证边界判断逻辑(不作为真实文件系统测试的替代)
  isInside, isSymlink, safeRealpath, isDir,
};