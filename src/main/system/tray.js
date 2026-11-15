// ---------- 托盘(tray) ----------
// 职责边界:托盘图标、右键菜单与 tooltip。
// 依赖方向:system/tray -> electron(Menu/Tray/nativeImage),其余全部通过 init 注入。
// 注入项:getTray/getWin 取当前实例(可能为 null),
//         getLastRun/getLastInfo 取最近状态文案,
//         onChangeWallpaper 触发换图,onQuit 触发退出。
// 不直接持有 main.js 的全局变量,避免循环引用。
const path = require('path');
const { app, Menu, nativeImage } = require('electron');

let deps = {
  getTray: () => null,
  getWin: () => null,
  getLastRun: () => null,
  getLastInfo: () => '',
  onChangeWallpaper: () => {},
};

function init(injected) {
  deps = Object.assign({}, deps, injected || {});
}

function trayIcon() {
  // 优先使用应用图标,托盘缩到 16x16
  try {
    const p = path.join(__dirname, '../../assets/icon.png');
    const img = nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
    if (!img.isEmpty()) return img;
  } catch {}
  // 兜底:纯色 16x16 方块(避免无图标时托盘为空)
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0x7c; buf[i * 4 + 1] = 0x6c; buf[i * 4 + 2] = 0xff; buf[i * 4 + 3] = 0xff;
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function buildTrayMenu() {
  const trayInst = deps.getTray();
  // tray 可能尚未创建或已销毁:菜单点击回调、配置保存、自愈后刷新都会走到这里
  if (!trayInst || trayInst.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: '立即换一张 (Lolicon)', click: () => deps.onChangeWallpaper('manual') },
    { label: 'AI 生成壁纸', click: () => deps.onChangeWallpaper('ai') },
    { type: 'separator' },
    { label: '显示主界面', click: () => { const w = deps.getWin(); if (w && !w.isDestroyed()) w.show(); } },
    { label: '退出', click: () => app.quit() },
  ]);
  trayInst.setContextMenu(menu);
  // 优先显示最近动作:lastRun 是换图结果,lastInfo 是更一般的状态文案(含启动自愈提示)。
  // 只读 lastRun 会让"已从归档恢复 current.jpg"这类自愈消息无处显示,托盘一直停在"就绪"。
  const lastRun = deps.getLastRun();
  const lastInfo = deps.getLastInfo();
  const tipText = lastRun ? ('上次: ' + lastRun.time + (lastRun.ok ? ' 成功' : ' 失败'))
    : (lastInfo ? lastInfo : '就绪');
  trayInst.setToolTip('ACG壁纸工作室 - ' + tipText);
}

module.exports = { init, trayIcon, buildTrayMenu };
