// 内置 Provider:豆包个人账号(阶段 3.4 / 3.5)
//
// 两个能力共用同一个文件,因为它们在豆包侧是同一个接口(chat/completion),
// 区别只是请求里带不带 input_skill。拆成两个文件反而要复制同一套凭据与错误处理。
//
// kind 说明:
//   text      -> complete(ctx)  普通对话
//   image-gen -> generate(ctx)  生图(内部走 chat + input_skill)
//   本文件同时导出两个 kind 的描述,由 main.js 各注册一份。
//
// 协议约束:Provider 不得 require electron、不得读写文件、不得直接拿 Cookie。
// 传输层(含凭据)经 ctx 注入,Provider 只看到 tx.converse()。

const TRANSPORT_ERR = require('./doubao-transport').ERR;

const AUTH = {
  type: 'account-session',
  required: true,
  statusKey: 'doubao',
  userInitiated: true,
};

// 把传输层错误转成对用户可读的话。不泄露 Cookie,不暴露内部堆栈。
function humanize(err) {
  const kind = (err && err.kind) || TRANSPORT_ERR.UNKNOWN_ERROR;
  switch (kind) {
    case TRANSPORT_ERR.NO_CREDENTIAL: return '尚未登录豆包,请先在设置里扫码登录';
    case TRANSPORT_ERR.AUTH_EXPIRED: return '豆包登录已过期,请重新扫码登录';
    case TRANSPORT_ERR.AUTH_REJECTED: return '豆包拒绝了本次请求,请检查账号状态或重新登录';
    case TRANSPORT_ERR.RATE_LIMITED: return '豆包提示请求过于频繁,请稍后再试(本程序不会自动重试)';
    case TRANSPORT_ERR.CAPTCHA_REQUIRED: return '豆包要求完成安全验证,请用浏览器打开豆包官网完成验证后再试';
    case TRANSPORT_ERR.NETWORK_ERROR: return '网络异常,请检查网络或代理设置';
    case TRANSPORT_ERR.TIMEOUT: return '请求超时';
    case TRANSPORT_ERR.PROTOCOL_CHANGED: return '豆包接口返回了无法识别的结构,可能服务端已更新,建议稍后再试或反馈';
    case TRANSPORT_ERR.SERVER_ERROR: return '豆包服务端返回错误: ' + ((err && err.message) || '');
    case TRANSPORT_ERR.IMAGE_INVALID: return '生成的图片无效';
    default: return (err && err.message) || '未知错误';
  }
}

// ---------- text ----------
const textMeta = {
  id: 'doubao',
  name: '豆包(个人账号)',
  version: '1.0.0',
  kind: 'text',
  capabilities: ['complete'],
  builtin: true,
  auth: AUTH,
  configSchema: {},   // 无需 apiBase/apiKey,凭据由登录流程管理
};

// ctx 约定:{ config, doubao:{ converse } }
//   注意:ctx.doubao 只暴露 converse(),不暴露 Cookie。
async function complete(ctx) {
  const tx = ctx && ctx.doubao;
  if (!tx || typeof tx.converse !== 'function') return { ok: false, error: '豆包传输层未就绪' };

  // 从 messages 里取出用户内容。豆包一次只发一条 user prompt。
  const msgs = Array.isArray(ctx.messages) ? ctx.messages : [];
  const userMsg = msgs.filter(m => m && m.role === 'user').map(m => String(m.content || '')).join('\n').trim();
  const sysMsg = msgs.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n').trim();
  if (!userMsg) return { ok: false, error: '请求内容为空' };
  // 系统提示词并入用户内容:豆包普通对话没有独立 system 通道,
  // 这是行为上的取舍,已在文档中标注为已知限制。
  const prompt = sysMsg ? (sysMsg + '\n\n' + userMsg) : userMsg;

  try {
    const r = await tx.converse({
      prompt, isImage: false,
      modelKey: ctx.modelKey,            // 由 main.js 从配置读取并校验后传入
      reasoningEffort: ctx.reasoningEffort,
      timeoutMs: ctx.timeoutMs || 90000,
      signal: ctx.signal,
    });
    const text = (r.text || '').trim();
    if (!text) return { ok: false, error: '豆包返回为空' + (r.degraded ? '(接口结构可能已变化)' : '') };
    return { ok: true, prompt: text, local: false, conversationId: r.conversationId, degraded: r.degraded };
  } catch (e) {
    return { ok: false, error: humanize(e), errorKind: (e && e.kind) || TRANSPORT_ERR.UNKNOWN_ERROR };
  }
}

// ---------- image-gen ----------
const imageMeta = {
  id: 'doubao-image',
  name: '豆包 Seedream(个人账号)',
  version: '1.0.0',
  kind: 'image-gen',
  capabilities: ['generate'],
  builtin: true,
  auth: AUTH,
  configSchema: {},
};

// 图片下载与格式校验。
//
// 【关键】阶段 3.1 实测:豆包返回的 URL 后缀是 .jpeg,实际内容是 PNG。
// 因此绝不信任 URL 后缀,也不单独信任 Content-Type —— 只认文件头魔数 + 实际解码。
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'png';
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  // WebP: RIFF....WEBP
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

// 下载图片并校验。返回 { buffer, format, width, height } 或抛错。
async function fetchImage(ctx, url, hint) {
  let u;
  try { u = new URL(String(url || '')); } catch { throw new Error('图片地址无效'); }
  if (u.protocol !== 'https:') throw new Error('图片地址必须是 https');

  // 图片地址是签名 CDN 链接,网络抖动比主接口常见得多。
  // 这里把"网络/超时"与"内容不对"分开报,用户才知道该重试还是该报缺陷。
  let res;
  try {
    res = await ctx.netFetch(url, { signal: AbortSignal.timeout(120000) });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (e && (e.name === 'AbortError' || /abort|timeout/i.test(msg))) {
      throw new Error('下载生成图片超时,请重试');
    }
    throw new Error('下载生成图片失败(网络异常,请检查网络或代理后重试): ' + msg);
  }
  if (!res.ok) {
    // 403/404 多为签名过期(生成后隔太久才下载),明确告知
    if (res.status === 403 || res.status === 404) {
      throw new Error('生成图片的下载链接已失效(HTTP ' + res.status + '),请重新生成');
    }
    throw new Error('下载图片失败 HTTP ' + res.status);
  }

  // 先看 Content-Length,超限直接拒,避免把超大响应读进内存
  const cl = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
  if (cl && cl > MAX_IMAGE_BYTES) throw new Error('图片超过大小上限');

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('图片为空');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片超过大小上限');

  const format = sniffImage(buf);
  if (!format) throw new Error('无法识别的图片格式(只接受 PNG/JPEG/WebP)');

  // 宽高校验:优先用流里报的,没有就从文件头里读 PNG 的 IHDR
  let width = (hint && hint.width) || 0;
  let height = (hint && hint.height) || 0;
  if (format === 'png' && buf.length > 24) {
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w > 0 && h > 0) { width = w; height = h; }
  }
  if (width && height) {
    if (width > 8192 || height > 8192) throw new Error('图片尺寸超限');
  }

  return { buffer: buf, format, width, height };
}

async function generate(ctx) {
  const tx = ctx && ctx.doubao;
  if (!tx || typeof tx.converse !== 'function') throw new Error('豆包传输层未就绪');

  const prompt = String(ctx.prompt || (ctx.config && ctx.config.ai && ctx.config.ai.prompt) || '').trim();
  if (!prompt) throw new Error('生图提示词为空');

  // 豆包生图要求提示词看起来像"要画图";不满足时补前缀(阶段 3.1 验证过的做法)
  let finalPrompt = prompt;
  if (!/^\s*(生成图片|生成一张|画一张|画个|绘制)/.test(prompt)) finalPrompt = '生成图片：' + prompt;

  let r;
  try {
    r = await tx.converse({
      prompt: finalPrompt, isImage: true,
      modelKey: ctx.modelKey,            // 生图也用同一个载体模型,skill 由 isImage 触发
      timeoutMs: ctx.timeoutMs || 180000,
      signal: ctx.signal,
    });
  } catch (e) {
    // 把 kind 挂到错误上,IPC 层据此区分"网络问题"与"账号问题"
    const err = new Error(humanize(e));
    err.kind = (e && e.kind) || 'UNKNOWN_ERROR';
    throw err;
  }

  if (!r.creations || !r.creations.length) {
    throw new Error(r.degraded ? '豆包未返回图片,且响应结构可能已变化' : '豆包未返回图片');
  }

  // 只取第一张。多张图的场景本轮不做;明确抛错而不是静默丢弃。
  const first = r.creations[0];
  const img = await fetchImage(ctx, first.url, first);

  // 返回契约与现有 openai-image-provider 保持一致:{ buffer }
  // 额外带上 format/width/height 供上层决定扩展名;上层不得据此跳过校验。
  return {
    buffer: img.buffer,
    format: img.format,
    width: img.width,
    height: img.height,
    conversationId: r.conversationId,
  };
}

module.exports = {
  textProvider: Object.assign({}, textMeta, { complete }),
  imageProvider: Object.assign({}, imageMeta, { generate }),
  sniffImage, fetchImage, humanize, MAX_IMAGE_BYTES, AUTH,
};