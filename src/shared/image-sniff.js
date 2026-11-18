// 图片内容校验(魔数嗅探)。唯一目的:挡住"HTTP 200 但正文是 HTML/JSON 错误页"这类假图片。
// 常见来源:中转站额度用尽、被墙拦截、CDN 返回错误页、签名过期。
// 只认文件头,不信 URL 后缀,也不信 Content-Type —— 豆包实测过 .jpeg 后缀装 PNG。
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'png';
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  // WebP: RIFF....WEBP
  const head4 = buf.slice(0, 4).toString('ascii');
  const head12 = buf.slice(8, 12).toString('ascii');
  if (head4 === 'RIFF' && head12 === 'WEBP') return 'webp';
  return null;
}

// 抛错而不是返回 false:调用方几乎都是"不合法就中断",返回布尔容易被忽略
function assertImage(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('图片内容为空');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片超过 32MB 上限');
  const fmt = sniffImage(buf);
  if (!fmt) {
    // 把响应开头截一段带出来,用户/日志能立刻看出"你拿回来的是个 HTML"而不是干瞪眼
    const peek = buf.slice(0, 200).toString('utf8').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    throw new Error('返回内容不是图片(只接受 PNG/JPEG/WebP)。响应开头: ' + (peek || '(二进制)'));
  }
  return fmt;
}

module.exports = { sniffImage, assertImage, MAX_IMAGE_BYTES };
