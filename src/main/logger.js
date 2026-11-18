// 轻量滚动日志。目的只有一个:装到别人机器上出问题时,有东西可查。
// 硬规矩:所有写入都过 redact(),apiKey / Bearer 一律不落盘。
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;  // 单文件 2 MB
const KEEP = 3;                     // 保留 3 份历史

let dirPath = '';
let filePath = '';

function redact(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
    .replace(/("apiKey"\s*:\s*")[^"]*(")/gi, '$1***$2')
    .replace(/("cookie"\s*:\s*")[^"]*(")/gi, '$1***$2');
}

function init(userDataPath) {
  try {
    dirPath = path.join(userDataPath, 'logs');
    filePath = path.join(dirPath, 'app.log');
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {
    dirPath = '';
    filePath = '';
  }
}

function rotate() {
  try {
    const st = fs.statSync(filePath);
    if (st.size < MAX_BYTES) return;
  } catch {
    return;                          // 还没文件,不需要滚动
  }
  try {
    for (let i = KEEP; i >= 1; i--) {
      const from = filePath + '.' + i;
      const to = filePath + '.' + (i + 1);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(filePath, filePath + '.1');
  } catch { /* 滚动失败不该影响主流程 */ }
}

function write(level, msg, extra) {
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' + redact(msg)
    + (extra ? ' ' + redact(typeof extra === 'string' ? extra : JSON.stringify(extra)) : '');
  try {
    if (filePath) {
      rotate();
      fs.appendFileSync(filePath, line + '\n', 'utf8');
    }
  } catch { /* 写盘失败也不能抛,否则日志会把主流程带崩 */ }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  init,
  dir: () => dirPath,
  file: () => filePath,
  redact,
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
