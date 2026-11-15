// 内置 Provider:OpenAI 兼容文本生成
//
// 从 main.js 的 ai-assist-prompt() 中"有文本服务"分支原样迁移。
// 无文本服务时的本地词池兜底不属于 Provider 职责,仍留在 main.js。
//
// ctx 约定:{ config, netFetch, findService }

const meta = {
  id: 'openai-text',
  name: 'OpenAI 兼容文本模型',
  version: '1.0.0',
  kind: 'text',
  capabilities: ['complete', 'list-models', 'test-conn'],
  builtin: true,
  configSchema: {
    apiBase: { type: 'string', required: true, label: 'API 地址' },
    apiKey: { type: 'string', required: true, label: 'API Key' },
    model: { type: 'string', required: true, label: '模型名' },
  },
};

function apiBase(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

// messages: [{ role, content }];返回 { ok, prompt, local:false } 或 { ok:false, error }
async function complete(ctx) {
  const svc = ctx.findService(ctx.config, ctx.serviceId || ctx.config.activeTextService);
  if (!svc) return { ok: false, error: '未找到文本 API 服务' };
  const base = apiBase(svc.apiBase);
  const res = await ctx.netFetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + svc.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: svc.model, messages: ctx.messages, max_tokens: ctx.maxTokens || 300 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ': ' + (await res.text()).slice(0, 150) };
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    ? data.choices[0].message.content.trim() : '';
  return text ? { ok: true, prompt: text, local: false } : { ok: false, error: '模型返回为空' };
}

module.exports = { ...meta, complete, apiBase };
