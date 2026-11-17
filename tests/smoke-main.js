// 阶段4 实机冒烟入口(保留资产,不进 run-all):用于真实 Electron 内验证预览流 UI。
// 用法: electron smoke-main.js --remote-debugging-port=9224,然后 node smoke-drive.js。
// 限制: userData/pictures 全部重定向临时目录;生图指向本地桩;全程不出网、不真实设壁纸。
// 原始冒烟记录(2026-11-17):R1-R7 全过,0 运行时错误,详见 _docs/stage4/stage4-final-report.md。在真实 Electron 内加载真实 main.js。
//   - userData/pictures 全部重定向到临时目录,零接触用户数据
//   - 本地生图桩(127.0.0.1:18091)返回合成 JPEG,全程不出网
//   - 定时换图关闭;预览模式开启
// 用法: node_modules\.bin\electron smoke-main.js --remote-debugging-port=9224
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const tmpRoot = path.join(os.tmpdir(), 'acg-s4-smoke-' + Date.now());
fs.mkdirSync(path.join(tmpRoot, 'userData', 'config'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, 'pictures', 'ACG_Wallpaper'), { recursive: true });

app.setPath('userData', path.join(tmpRoot, 'userData'));
app.setPath('pictures', path.join(tmpRoot, 'pictures'));

// 预置配置:预览模式开 + AI 直应用关 + 本地桩服务
fs.writeFileSync(path.join(tmpRoot, 'userData', 'config', 'config.json'), JSON.stringify({
  source: 'ai',
  services: [{ id: 'smoke-svc', kind: 'image', name: 'smoke', apiBase: 'http://127.0.0.1:18091/v1', apiKey: 'sk-smoke', model: 'smoke-model' }],
  activeImageService: 'smoke-svc',
  ai: { prompt: '冒烟测试提示词', size: '1024x1024', randomMode: 'custom', imageEngine: 'service', previewMode: true },
  schedule: { enabled: false, intervalMinutes: 30 },
}, null, 2));

// 本地生图桩(主进程内,Renderer 永远不直接访问)
const http = require('node:http');
const jpeg = Buffer.alloc(30000, 0);
Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]).copy(jpeg, 0);
Buffer.from([0xFF, 0xD9]).copy(jpeg, 29998);
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: jpeg.toString('base64') }] }));
  });
});
stub.listen(18091, '127.0.0.1', () => console.log('[SMOKE] stub ready on 18091'));

console.log('[SMOKE] tmpRoot =', tmpRoot);
console.log('[SMOKE] boot real main.js ...');
// 真实 main.js(其内部 app.whenReady 会正常走 createWindow 等)
require('../src/main/main.js');