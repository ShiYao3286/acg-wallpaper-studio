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

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
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

// 入口文件解析:必须落在插件目录内。
function resolveEntry(pluginDir, manifest) {
  const name = typeof manifest.main === 'string' && manifest.main.trim() ? manifest.main.trim() : DEFAULT_ENTRY;
  const full = path.resolve(pluginDir, name);
  const base = path.resolve(pluginDir);
  // 用 base + 分隔符 比较,避免 /a/plugin 与 /a/plugin-evil 被误判为同目录
  if (full !== base && !full.startsWith(base + path.sep)) {
    return { ok: false, reason: '入口文件逃逸出插件目录: ' + name };
  }
  try {
    if (!fs.statSync(full).isFile()) return { ok: false, reason: '入口不是普通文件: ' + name };
  } catch { return { ok: false, reason: '入口文件不存在: ' + name }; }
  return { ok: true, entry: full };
}

// 发现:只做磁盘扫描 + manifest 校验,不执行任何插件代码。
// 返回 { found: [{id, dir, manifest, entry}], skipped: [{dir, reason}] }
function discover(pluginsRoot) {
  const found = [];
  const skipped = [];
  if (!pluginsRoot || !isDir(pluginsRoot)) return { found, skipped };
  let names;
  try { names = fs.readdirSync(pluginsRoot).sort(); } catch (e) {
    return { found, skipped: [{ dir: pluginsRoot, reason: '目录不可读: ' + ((e && e.message) || e) }] };
  }
  for (const name of names) {
    const dir = path.join(pluginsRoot, name);
    if (!isDir(dir)) continue;   // 散落的文件直接忽略,不算错误
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
};