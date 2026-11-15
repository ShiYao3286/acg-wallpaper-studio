// 内置 Provider:Lolicon 随机二次元图源
//
// 从 main.js 的 fetchLolicon() 原样迁移,行为必须完全一致。
// 唯一变化:netFetch 改为通过 ctx 注入,不再直接引用 main.js 的闭包实现。
//
// 注意:本 Provider 不需要用户 API Key,apiBase 来自配置的 lolicon.apiBase。

const meta = {
  id: 'lolicon',
  name: 'Lolicon 随机二次元',
  version: '1.0.0',
  kind: 'image-source',
  capabilities: ['fetch-random'],
  builtin: true,
  configSchema: {
    r18: { type: 'number', required: false, label: 'R18 过滤(0=非 R18)' },
    size: { type: 'string', required: false, label: '图片尺寸(regular/original)' },
    proxy: { type: 'string', required: false, label: '图片反代域名' },
    excludeAI: { type: 'boolean', required: false, label: '排除 AI 生成' },
    tags: { type: 'string', required: false, label: '标签池(逗号分隔)' },
    apiBase: { type: 'string', required: true, label: 'API 地址' },
  },
};

// ctx 约定:{ config, netFetch }
//   config   : 完整应用配置(本 Provider 只用 config.lolicon)
//   netFetch : 已带代理的统一出网函数
async function fetchOne(ctx) {
  const L = (ctx.config && ctx.config.lolicon) || {};
  const tags = Array.isArray(L.tags) ? L.tags.filter(Boolean) : [];
  const tag = tags.length ? tags[Math.floor(Math.random() * tags.length)] : null;
  const url = L.apiBase + '?num=1&r18=' + L.r18 + '&size=' + L.size + '&proxy=' + L.proxy +
    (L.excludeAI ? '&excludeAI=true' : '') + (tag ? '&tag=' + encodeURIComponent(tag) : '');
  const res = await ctx.netFetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('API HTTP ' + res.status);
  const json = await res.json();
  const d = json.data && json.data[0];
  if (!d || !d.urls || !d.urls.regular) throw new Error('API 未返回图片地址');
  return { url: d.urls.regular, title: d.title, author: d.author, pid: d.pid, tag };
}

module.exports = { ...meta, fetch: fetchOne };
