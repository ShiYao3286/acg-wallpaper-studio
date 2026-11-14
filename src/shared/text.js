// 文本工具(主进程/渲染进程共用)
// PowerShell 5.1 的 Set-Content -Encoding UTF8 会写出带 BOM 的 JSON 文件
// (旧脚本 legacy-wallpaper-example.ps1 即如此),而 JSON.parse 不接受 BOM,
// 会在第一个字符处抛 SyntaxError。读取旧脚本产物前必须先剥掉 BOM。
// 对不含 BOM 的字符串是恒等函数,无副作用。
function stripBom(s) {
  return (typeof s === 'string' && s.charCodeAt(0) === 0xFEFF) ? s.slice(1) : s;
}
module.exports = { stripBom };
