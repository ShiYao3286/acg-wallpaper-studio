// 内置 Provider:OpenAI 兼容文生图
//
// 从 main.js 的 fetchAI() 原样迁移,行为必须完全一致:
//   POST {base}/v1/images/generations
//   支持 b64_json 与 url 两种返回(后者二次下载)
//
// ctx 约定:{ config, netFetch, findService }
//   findService(cfg, id) : 按 id 找服务对象,由 main.js 注入,避免本模块依赖配置读取逻辑

const meta = {
  id: 'openai-image',
  name: 'OpenAI 兼容文生图',
  version: '1.0.0',
  kind: 'image-gen',
  capabilities: ['generate', 'list-models', 'test-conn'],
  builtin: true,
  configSchema: {
    apiBase: { type: 'string', required: true, label: 'API 地址' },
    apiKey: { type: 'string', required: true, label: 'API Key' },
    model: { type: 'string', required: true, label: '模型名' },
  },
};

// 规范化 API 地址:去掉尾部斜杠与多余的 /v1,统一由拼接处补 /v1/...
// 与 main.js 的 apiBase() 保持完全一致 —— 两处实现若漂移会导致请求路径不同。
const { assertImage } = require('../../../shared/image-sniff');

function apiBase(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function generate(ctx) {
  const svc = ctx.findService(ctx.config, ctx.serviceId || ctx.config.activeImageService);
  if (!svc) throw new Error('未找到画图 API 服务,请到「API 服务」页配置');
  const base = apiBase(svc.apiBase);
  const res = await ctx.netFetch(base + '/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + svc.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: svc.model,
      prompt: ctx.prompt || ctx.config.ai.prompt,
      n: 1,
      size: ctx.config.ai.size,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error('AI API HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const json = await res.json();
  const item = json.data && json.data[0];
  if (!item) throw new Error('AI API 未返回数据');
  let out = null;
  if (item.b64_json) out = { buffer: Buffer.from(item.b64_json, 'base64') };
  else if (item.url) {
    const r2 = await ctx.netFetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!r2.ok) throw new Error('下载 AI 图片失败 HTTP ' + r2.status);
    out = { buffer: Buffer.from(await r2.arrayBuffer()) };
  }
  if (!out) throw new Error('AI API 响应中无图片');
  // 早失败:别等落到壁纸目录才发现拿回来的是一张 HTML
  assertImage(out.buffer);
  return out;
}

module.exports = { ...meta, generate, apiBase };
