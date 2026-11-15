// 测试用 wallpaper 包模拟:不做真实系统改动,只记录调用。
// 行为可注入(globalThis.__wallpaperBehavior),用于触发生产代码的失败/回滚分支:
//   undefined       -> 正常返回并记录路径
//   'throw'         -> 每次都抛错
//   { failTimes:n } -> 前 n 次抛错,之后成功
// 被替换的是"操作系统设置壁纸"这一外部能力,不是被测的生产逻辑。
const fn = async function setWallpaper(p) {
  globalThis.__wallpaperCalls = globalThis.__wallpaperCalls || [];
  globalThis.__wallpaperAttempts = (globalThis.__wallpaperAttempts || 0) + 1;
  const b = globalThis.__wallpaperBehavior;
  if (b === 'throw') throw new Error('mock setWallpaper 失败(强制)');
  if (b && typeof b === 'object' && typeof b.failTimes === 'number' && globalThis.__wallpaperAttempts <= b.failTimes) {
    throw new Error('mock setWallpaper 第 ' + globalThis.__wallpaperAttempts + ' 次失败(强制)');
  }
  globalThis.__wallpaperCalls.push(p);
};
fn.resetWallpaper = function (behavior) {
  globalThis.__wallpaperCalls = [];
  globalThis.__wallpaperAttempts = 0;
  globalThis.__wallpaperBehavior = behavior;
};
// main.js 的加载逻辑: mod.setWallpaper 是函数就用 mod,否则用 mod.default
// 两种形状都挂上,确保被测代码走的是"真正的调用"而不会 TypeError
fn.setWallpaper = fn;
fn.default = fn;
module.exports = fn;
