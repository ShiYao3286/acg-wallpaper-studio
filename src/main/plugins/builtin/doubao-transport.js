// 豆包传输层(阶段 3.4)
//
// 职责:把"如何向豆包发一个请求"全部收敛在这里,Provider 只关心业务。
//
// 为什么单独一层:
//   阶段 3.1 实测发现请求体是四层嵌套 + 19 个 URL 查询参数 + 6 个伪装请求头。
//   把这些散在 Provider 业务逻辑里,一旦服务端改字段就要满地找。
//
// 安全边界:
//   1. Cookie 由调用方(main.js)通过注入的 getCookieHeader 提供,本模块不持有。
//   2. 错误信息里绝不回显 Cookie;诊断只用字段名和状态码。
//   3. 不自动重试 —— 尤其生图,重复提交可能重复扣额度。
//
// 版本管理:
//   CLIENT_VERSION 等常量来自阶段 3.1 实测。(参考实现自己注明这些值随豆包发版漂移)
//   这里集中成 PROTOCOL 对象,并在响应出现未知事件/必需字段缺失时置 degraded,
//   供上层提示"协议可能变了",而不是静默出错。

const crypto = require('node:crypto');
const stream = require('./doubao-stream');

// 协议适配版本。【升级指引】豆包发版后若出现 PROTOCOL_CHANGED,先核这几个值。
const PROTOCOL = {
  doubaoVersion: '2.31.4',
  runtimeVersion: '3.39.0',
  chromiumVersion: '147.0.7727.149',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
             'Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.31.4',
  referer: 'chrome://doubao-chat/',
};

// 固定客户端标识(不是凭据,是"看起来像同一个安装")
const CLIENT_PARAMS = {
  aid: '582478', real_aid: '582478', version_code: '20800', pc_version: PROTOCOL.doubaoVersion,
  device_id: '2697515174213273', tea_uuid: '2697515174213273',
  web_id: '7677868049198630415', fp: 'verify_2697515174213273',
  chromium_version: PROTOCOL.chromiumVersion, runtime_version: PROTOCOL.runtimeVersion,
  channel: 'win', language: 'zh', region: 'CN', sys_region: 'CN',
  tz_name: 'Asia/Shanghai', pkg_type: 'release_version',
  client_platform: 'pc_client', device_platform: 'web',
  doubao_device_platform: 'desktop', web_platform: 'desktop',
  samantha_web: '1', 'use-olympus-account': '1',
};

const CHAT_URL = 'https://www.doubao.com/chat/completion';
const BOT_ID = '7338286299411103781';
const CARRIER_MODEL = '0';        // 默认载体模型(豆包快速)
const DEFAULT_TEXT_MODEL = '0';
const IMAGE_SKILL_TYPE = 3;       // input_skill.skill_type = 3 -> Seedream 生图

// 模型目录(阶段3 审核:按"是否工作任务"分类)。
//
// 依据:参考实现在 doubao-catalog.ts 里标注 taskMode 的实测清单,
// 加上阶段3.1 与 3.6 的实测。这些 key 是豆包的 model_item_key,不是通用模型名。
//
// 【为什么要有 available 字段】
//   标了「工作任务」的模型(id 5 / 9 / seed-lite-7b 等)会让服务端把这一轮
//   当成工作任务处理,进而尝试调用本地工具执行器。本项目明确不接入该能力,
//   因此这些模型只做展示(让用户知道豆包有什么),但禁止选中。
const MODEL_CATALOG = [
  { key: '0', name: '豆包 快速', taskMode: false, reasoning: false, available: true },
  { key: '3', name: '豆包 2.1 Turbo', taskMode: false, reasoning: true, available: true },
  { key: 'seed-lite-7b', name: '豆包 2.1 Lite', taskMode: true, reasoning: true, available: false, blockedReason: '属于「工作任务」模型,本应用不接入工具执行能力' },
  { key: '5', name: '豆包 2.1 Pro', taskMode: true, reasoning: true, available: false, blockedReason: '属于「工作任务」模型,本应用不接入工具执行能力' },
  { key: '9', name: '自动', taskMode: true, reasoning: true, available: false, blockedReason: '属于「工作任务」模型,本应用不接入工具执行能力' },
];

// 生图模型:豆包生图不是独立 model_item_key,而是 input_skill 触发,
// 服务端按账号权益路由 Seedream 版本。这里给一个稳定的逻辑标识。
const IMAGE_MODEL_KEY = 'image-gen';
const IMAGE_MODEL_NAME = '豆包生图(Seedream,服务端路由)';

function listModels() {
  return MODEL_CATALOG.map(m => ({ ...m }));
}

// 校验模型 key:必须是 available 的才会被真正发出去。
// 传入未知 key 一律回落到默认模型,避免把任意字符串透给服务端。
function resolveTextModel(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return { key: DEFAULT_TEXT_MODEL, blocked: null };
  const hit = MODEL_CATALOG.find(m => m.key === k);
  if (!hit) return { key: DEFAULT_TEXT_MODEL, blocked: { key: k, reason: '未知模型,已回落到默认模型' } };
  if (!hit.available) return { key: DEFAULT_TEXT_MODEL, blocked: { key: k, reason: hit.blockedReason } };
  return { key: hit.key, blocked: null };
}
const REASONING_EFFORT = 5;
const AGENT_MODE_CHAT = 2;        // 2=普通对话,1=工作任务【绝不使用 1】

// 错误分类。上层据此决定 UI 文案与是否停止重试。
const ERR = {
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  AUTH_REJECTED: 'AUTH_REJECTED',
  RATE_LIMITED: 'RATE_LIMITED',
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  PROTOCOL_CHANGED: 'PROTOCOL_CHANGED',
  SERVER_ERROR: 'SERVER_ERROR',
  IMAGE_INVALID: 'IMAGE_INVALID',
  NO_CREDENTIAL: 'NO_CREDENTIAL',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
};

// 豆包业务错误码 → 分类。只映射有把握的,其余进 SERVER_ERROR 并保留原始码。
function classifyServerError(code, msg) {
  const c = Number(code);
  const m = String(msg || '');
  if (c === 710022004) return ERR.RATE_LIMITED;
  if (/captcha|验证码|滑块/i.test(m)) return ERR.CAPTCHA_REQUIRED;
  if (/登录|会话过期|未授权|session/i.test(m)) return ERR.AUTH_EXPIRED;
  if (/invalid param|参数/i.test(m)) return ERR.PROTOCOL_CHANGED;
  return ERR.SERVER_ERROR;
}

// 统一的传输错误对象。message 可直接展示,不含敏感信息。
function txError(kind, message, extra) {
  const e = new Error(message);
  e.name = 'DoubaoTransportError';
  e.kind = kind;
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
}

let deps = {
  getCookieHeader: async () => '',
  fetchImpl: null,          // 由 main.js 注入带代理的 netFetch
  now: () => Date.now(),
};

function init(opts) {
  deps = Object.assign({}, deps, opts || {});
}

// 构造请求体。isImage=true 时加 input_skill 触发 Seedream。
function buildBody(prompt, opts) {
  const o = opts || {};
  const lid = crypto.randomUUID();
  const plainTask = { server_do_compare: true };
  // 模型必须经 resolveTextModel 过滤:不可用的(工作任务类/未知)一律回落默认,
  // 绝不把任意字符串透给服务端。
  const modelKey = resolveTextModel(o.modelKey).key;
  const effort = Number.isInteger(o.reasoningEffort) ? o.reasoningEffort : REASONING_EFFORT;
  const body = {
    messages: [{
      local_message_id: lid, message_status: 0,
      content_block: [{
        block_type: 10000, block_id: crypto.randomUUID(), parent_id: '', meta_info: [], append_fields: [],
        content: { text_block: { text: prompt, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
      }],
    }],
    option: {
      send_message_scene: '', create_time_ms: deps.now(), collect_id: '',
      is_audio: false, answer_with_suggest: false,
      agent_mode: AGENT_MODE_CHAT,
      tts_switch: false, need_deep_think: 0,
      click_clear_context: false, from_suggest: false, is_regen: false, is_replace: false,
      is_from_click_option: false, is_from_click_softlink: false, disable_sse_cache: false,
      select_text_action: '', is_select_text: false, resend_for_regen: false,
      scene_type: 0, unique_key: crypto.randomUUID(), start_seq: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: modelKey, reasoning_effort: String(effort), mode_id: '1' },
      regen_query_id: [], edit_query_id: [],
      regen_instruction: '', no_replace_for_regen: false, message_from: 0,
      shared_app_name: '', shared_app_id: '',
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true, is_ai_playground: false, is_old_user: true,
      general_task_param: plainTask,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(deps.now() / 1000), append_sse_event_scene: 0 },
      message_storage_type: 0, related_deleted_message_ids: {}, connector_info_list: [],
      model_config: { model_item_key: modelKey, model_extra_params: {}, reasoning_effort: effort },
      aggregate_params: {
        mention_skill_list: '[]', mention_plugin_list: '[]', mention_ext: '[{}]',
        conversation_mode: '', mode_id: '1', model_item_key: modelKey,
        agent_mode: '2', reasoning_effort: String(effort), provider_id: '',
      },
    },
    client_meta: {
      local_conversation_id: 'local_' + crypto.randomUUID(), conversation_id: '',
      bot_id: BOT_ID, last_section_id: '', last_message_index: null,
      local_permissions: [
        { permission_name: 'ACCESS_COARSE_LOCATION', status: 1 },
        { permission_name: 'ACCESS_FINE_LOCATION', status: 1 },
        { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 1 },
      ],
    },
    user_context: [],
    ext: {
      agent_mode: '2', use_deep_think: '0', sub_conv_firstmet_type: '1',
      general_task_param: JSON.stringify(plainTask),
      collection_id: '', is_finish: '1',
      conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
      commerce_credit_config_enable: '0',
    },
  };
  if (o.isImage) {
    body.ext.input_skill = JSON.stringify({ skill_id: String(IMAGE_SKILL_TYPE), skill_type: IMAGE_SKILL_TYPE, variables: {} });
  }
  return body;
}

// 构造请求头。注意:Cookie 只在这一次调用的实参里出现,不存字段。
function buildHeaders(cookieHeader) {
  return {
    'Content-Type': 'application/json',
    'Cookie': cookieHeader,
    'User-Agent': PROTOCOL.userAgent,
    'Referer': PROTOCOL.referer,
    'accept': '*/*', 'accept-language': 'zh-CN,zh;q=0.9',
    'sec-ch-ua': '"Chromium";v="147", "Not.A/Brand";v="8"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
    'agw-js-conv': 'str',
    'x-flow-trace': crypto.randomUUID().replace(/-/g, '') + '-' + crypto.randomUUID().replace(/-/g, '') + '-01',
    'last-event-id': 'undefined',
  };
}

function buildUrl() {
  const qs = new URLSearchParams(Object.assign({}, CLIENT_PARAMS, { web_tab_id: crypto.randomUUID() }));
  return CHAT_URL + '?' + qs.toString();
}

// 主入口:发一次对话(可带生图 skill)。
// opts: { prompt, isImage, timeoutMs, signal }
// 返回 { text, creations, conversationId, events, unknownEvents, degraded }
async function converse(opts) {
  const o = opts || {};
  const prompt = String(o.prompt || '').trim();
  if (!prompt) throw txError(ERR.PROTOCOL_CHANGED, '请求内容为空');
  if (prompt.length > 8000) throw txError(ERR.PROTOCOL_CHANGED, '请求内容过长');

  let cookie;
  try { cookie = await deps.getCookieHeader(); }
  catch (e) { throw txError(ERR.NO_CREDENTIAL, '读取登录凭据失败: ' + ((e && e.message) || e)); }
  if (!cookie) throw txError(ERR.NO_CREDENTIAL, '尚未登录豆包,请先在设置里扫码登录');

  const timeoutMs = o.timeoutMs || (o.isImage ? 180000 : 90000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 外部取消信号也要能中止
  let onAbort = null;
  if (o.signal) {
    if (o.signal.aborted) { clearTimeout(timer); throw txError(ERR.TIMEOUT, '请求已取消'); }
    onAbort = () => controller.abort();
    o.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const fetchImpl = deps.fetchImpl || fetch;
    const res = await fetchImpl(buildUrl(), {
      method: 'POST',
      headers: buildHeaders(cookie),
      body: JSON.stringify(buildBody(prompt, o)),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 401/403 不一律当登录过期:要把服务端原因带上(脱敏)
      const snippet = await res.text().catch(() => '');
      const kind = res.status === 401 ? ERR.AUTH_REJECTED
        : res.status === 403 ? ERR.AUTH_REJECTED
        : res.status === 429 ? ERR.RATE_LIMITED
        : ERR.SERVER_ERROR;
      throw txError(kind, '豆包返回 HTTP ' + res.status, { httpStatus: res.status, detail: snippet.slice(0, 200) });
    }

    // 走流式读取,边读边解析(生图响应可达数百 KB)
    const parser = stream.createParser({});
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.write(decoder.decode(value, { stream: true }));
      }
    } else {
      // 兼容不支持流的环境(测试里的假 fetch)
      parser.write(await res.text());
    }
    const result = parser.end();

    // 服务端明确报错 → 分类后抛出
    if (result.errors.length) {
      const first = result.errors[0];
      const kind = classifyServerError(first.code, first.msg);
      throw txError(kind, '豆包返回错误: ' + (first.msg || first.code), { serverCode: first.code });
    }
    if (result.overflow) throw txError(ERR.PROTOCOL_CHANGED, '响应体异常过大');

    // 协议漂移信号:未知事件 / 一个词都没有 / 解析错误过多
    const degraded = result.unknownEvents.length > 0 || result.parseErrors > 0
      || (o.isImage ? result.creations.length === 0 : result.text === '');

    return {
      text: result.text,
      creations: result.creations,
      conversationId: result.conversationId,
      events: result.events,
      unknownEvents: result.unknownEvents,
      parseErrors: result.parseErrors,
      degraded,
    };
  } catch (e) {
    if (e && e.kind) throw e;               // 已分类,直接透出
    if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)))) {
      throw txError(ERR.TIMEOUT, '请求超时或被取消');
    }
    throw txError(ERR.NETWORK_ERROR, '网络请求失败: ' + ((e && e.message) || e));
  } finally {
    clearTimeout(timer);
    if (o.signal && onAbort) { try { o.signal.removeEventListener('abort', onAbort); } catch {} }
  }
}

module.exports = {
  init, converse, buildBody, buildHeaders, buildUrl, classifyServerError,
  ERR, PROTOCOL, CLIENT_PARAMS, CHAT_URL, BOT_ID,
  CARRIER_MODEL, DEFAULT_TEXT_MODEL, IMAGE_MODEL_KEY, IMAGE_MODEL_NAME, IMAGE_SKILL_TYPE,
  MODEL_CATALOG, listModels, resolveTextModel, AGENT_MODE_CHAT,
};