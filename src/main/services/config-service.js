// ---------- 配置存取(config-service) ----------
// 职责边界:只负责 config.json 的读、合并、原子写。
// 依赖方向:services/ -> shared/ (defaults, text);不依赖 main.js,不触碰全局状态。
// 调度重应用(applySchedule)属于副作用,由调用方(main.js)在保存后自行触发,
// 以免本模块反向依赖 system/scheduler 造成循环引用。
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { DEFAULT_CONFIG } = require('../../shared/defaults');
const { stripBom } = require('../../shared/text');

// 防原型污染的键集合,deepMerge 与 save-config 的点路径校验共用
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// app.getPath('userData') 由调用方注入,避免本模块 require('electron') 后难以测试
let userDataDir = '';
function init(opts) {
  userDataDir = (opts && opts.userDataDir) || '';
}

const confDir = () => path.join(userDataDir, 'config');
const confFile = () => path.join(confDir(), 'config.json');

// 读取配置的两种语义必须分开,否则会造成用户配置被默认值覆盖:
//   loadConfig()       面向"展示"——读不到就给默认配置,保证 UI 不因坏文件而不可用;
//   loadConfigStrict() 面向"写入"——读不到必须抛错,绝不能让 saveConfig 拿默认值覆盖原文件。
// 区分依据是"文件是否存在",而不是"能不能解析":
//   文件不存在(ENOENT) → 首次运行,允许用默认配置;
//   JSON 解析失败        → 文件存在但内容坏了,属异常,写入必须中止;
//   权限/磁盘等错误      → 文件状态未知,写入必须中止。

// 严格读取:仅供 saveConfig 使用。返回 { cfg, exists }。
async function loadConfigStrict() {
  let raw;
  try {
    raw = await fsp.readFile(confFile(), 'utf8');
  } catch (e) {
    // 只有"文件不存在"才算首次运行;其余(权限/磁盘/句柄)一律上报
    if (e && e.code === 'ENOENT') {
      return { cfg: structuredClone(DEFAULT_CONFIG), exists: false };
    }
    const err = new Error('读取配置失败,已中止保存以避免覆盖原配置: ' + ((e && e.message) || String(e)));
    err.code = (e && e.code) || 'E_CONFIG_READ';
    err.cause = e;
    throw err;
  }
  // 文件存在:解析失败必须中止,不能静默当成首次运行
  try {
    return { cfg: deepMerge(structuredClone(DEFAULT_CONFIG), JSON.parse(stripBom(raw))), exists: true };
  } catch (e) {
    const err = new Error('配置文件内容损坏(JSON 解析失败),已中止保存以避免覆盖原配置: ' + ((e && e.message) || String(e)));
    err.code = 'E_CONFIG_PARSE';
    err.cause = e;
    throw err;
  }
}

// 宽松读取:面向展示。任何读取/解析问题都回退默认配置,保证 UI 可用。
async function loadConfig() {
  try {
    const { cfg } = await loadConfigStrict();
    return cfg;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function deepMerge(base, over) {
  for (const k of Object.keys(over)) {
    if (FORBIDDEN_KEYS.has(k)) continue; // 防原型污染
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') {
      deepMerge(base[k], over[k]);
    } else base[k] = over[k];
  }
  return base;
}

async function saveConfig(patch) {
  await fsp.mkdir(confDir(), { recursive: true });
  // 必须用严格读取:若原配置损坏/不可读,这里会抛错,绝不拿默认配置覆盖原文件。
  // 这是"改一个开关导致 API Key 全丢"的唯一防线。
  const { cfg: current } = await loadConfigStrict();
  const cfg = deepMerge(current, patch);
  // 原子写:先写同目录临时文件再 rename(同盘 rename 是原子的)。
  // 直接覆盖写若中途断电/强杀,config.json 会被截断,下次 loadConfig 只能回退默认配置,
  // 用户的全部设置与 API Key 会一次性丢失。
  const target = confFile();
  // 临时文件名必须唯一:固定的 .tmp 会让并发保存(如连续拖动开关)互相 rename,
  // 后完成的一方把先完成方的临时文件搬走,另一方 rename 时报 ENOENT。
  const tmpFile = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    await fsp.writeFile(tmpFile, JSON.stringify(cfg, null, 2), 'utf8');
    await fsp.rename(tmpFile, target);
  } catch (err) {
    // 失败时清掉临时文件,避免配置目录堆积残片
    try { await fsp.unlink(tmpFile); } catch {}
    throw err;
  }
  return cfg;
}

module.exports = { init, confDir, confFile, loadConfig, loadConfigStrict, saveConfig, deepMerge, FORBIDDEN_KEYS };
