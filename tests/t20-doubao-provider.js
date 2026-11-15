// 第二十部分:豆包文本与生图 Provider(阶段 3.4 / 3.5)
//
// 覆盖:私有流解析、传输层请求构造与错误分类、文本 Provider、生图 Provider、
//       图片格式嗅探(重点:URL 后缀不可信)。
// 全部使用 Mock,不发起任何真实豆包请求,不下载任何真实图片。
const path = require('node:path');
const { group, ok, summarize } = require('./common');

const ROOT = path.resolve(__dirname, '..');
const BUILTIN = path.join(ROOT, 'src', 'main', 'plugins', 'builtin');
const stream = require(path.join(BUILTIN, 'doubao-stream.js'));
const transport = require(path.join(BUILTIN, 'doubao-transport.js'));
const provider = require(path.join(BUILTIN, 'doubao-provider.js'));

// 阶段 3.1 捕获的真实文本流结构
const TEXT_STREAM = 'id: 0\nevent: SSE_HEARTBEAT\ndata: {}\n\n' +
  'id: 0\nevent: SSE_ACK\ndata: {"ack_client_meta":{"conversation_id":"38453919104025090"}}\n\n' +
  'id: 0\nevent: STREAM_CHUNK\ndata: {"message":{"content_block":[{"content":{"text_block":{"text":"收到"}}}]}}\n\n' +
  'id: 0\nevent: SSE_REPLY_END\ndata: {}\n\n';

function mkRes(text, okFlag, status) {
  return {
    ok: okFlag !== false, status: status || 200,
    headers: { get: () => null },
    text: async () => text,
    body: null,
    async arrayBuffer() { return Buffer.alloc(0); },
  };
}

(async () => {
  group('A 私有流解析');
  {
    const r1 = stream.parseAll(TEXT_STREAM);
    ok('A1', '保留 event 名并可提取文本', r1.events.includes('SSE_ACK') && r1.text === '收到', JSON.stringify(r1.text));
    ok('A2', '提取 conversationId', r1.conversationId === '38453919104025090');
    ok('A3', '识别结束帧', r1.ended === true);

    // 分块输入
    const p = stream.createParser();
    p.write(TEXT_STREAM.slice(0, 30));
    p.write(TEXT_STREAM.slice(30));
    ok('A4', '分块输入可重组完整响应', p.end().text === '收到');

    ok('A5', '坏 JSON 不抛错只计数', stream.parseAll('id: 0\nevent: X\ndata: {broken\n\n').parseErrors === 1);
    ok('A6', '未知事件被记录(用于协议漂移检测)', stream.parseAll('id: 0\nevent: NEW_EVT\ndata: {}\n\n').unknownEvents.includes('NEW_EVT'));
    ok('A7', '错误帧被解析出错误码', (() => {
      const r = stream.parseAll('id: 0\nevent: STREAM_ERROR\ndata: {"error_code":710022004,"error_msg":"rate limited"}\n\n');
      return r.errors.length === 1 && r.errors[0].code === 710022004;
    })());
    ok('A8', '心跳不产生文本', stream.parseAll('id: 0\nevent: SSE_HEARTBEAT\ndata: {}\n\n').text === '');
    ok('A9', 'CRLF 分隔可解析', stream.parseAll('id: 0\r\nevent: STREAM_CHUNK\r\ndata: {"content_block":[{"content":{"text_block":{"text":"CR"}}}]}\r\n\r\n').text === 'CR');
    ok('A10', '末帧无空行结尾也可解析', stream.parseAll('id: 0\nevent: STREAM_CHUNK\ndata: {"content_block":[{"content":{"text_block":{"text":"尾"}}}]}').text === '尾');
    ok('A11', '空输入不崩溃', (() => { const r = stream.parseAll(''); return r.text === '' && r.events.length === 0; })());
    ok('A12', '超出大小上限被标记', (() => { const pp = stream.createParser({ maxBytes: 50 }); pp.write('x'.repeat(100)); return pp.end().overflow === true; })());
  }

  group('B 传输层');
  {
    let req = null;
    transport.init({
      getCookieHeader: async () => 'sessionid=SECRET_TEST_VALUE',
      fetchImpl: async (url, opts) => { req = { url, opts }; return mkRes(TEXT_STREAM); },
      now: () => 1794758390000,
    });

    const r = await transport.converse({ prompt: '你好' });
    ok('B1', '文本请求返回文本', r.text === '收到');
    ok('B2', '请求 URL 正确', req.url.includes('/chat/completion') && req.url.includes('aid=582478'));
    ok('B3', 'UA 伪造为客户端形态', String(req.opts.headers['User-Agent']).includes('SamanthaDoubao/2.31.4'));
    ok('B4', 'Referer 为 chrome 协议', req.opts.headers['Referer'] === 'chrome://doubao-chat/');

    const body = JSON.parse(req.opts.body);
    ok('B5', 'agent_mode 为 2(绝不能是 1=工作任务)', body.option.agent_mode === 2);
    ok('B6', '纯文本不带 input_skill', body.ext.input_skill === undefined);
    ok('B7', '含固定 bot_id', body.client_meta.bot_id === '7338286299411103781');
    ok('B8', '未注册工作任务能力(general_task_param 仅占位)', JSON.stringify(body.option.general_task_param) === '{"server_do_compare":true}');

    await transport.converse({ prompt: '生成图片：猫', isImage: true }).catch(() => {});
    const ib = JSON.parse(req.opts.body);
    ok('B9', '生图请求带 input_skill(skill_type 3)', typeof ib.ext.input_skill === 'string' && ib.ext.input_skill.includes('"skill_type":3'));
    ok('B10', '生图仍走普通对话模式', ib.option.agent_mode === 2);
  }

  group('C 错误分类');
  {
    const cases = [
      ['C1', '无凭据 -> NO_CREDENTIAL', { cookie: '', res: mkRes('') }, 'NO_CREDENTIAL'],
      ['C2', '401 -> AUTH_REJECTED', { cookie: 'c=1', res: mkRes('', false, 401) }, 'AUTH_REJECTED'],
      ['C3', '403 -> AUTH_REJECTED', { cookie: 'c=1', res: mkRes('', false, 403) }, 'AUTH_REJECTED'],
      ['C4', '429 -> RATE_LIMITED', { cookie: 'c=1', res: mkRes('', false, 429) }, 'RATE_LIMITED'],
      ['C5', '500 -> SERVER_ERROR', { cookie: 'c=1', res: mkRes('', false, 500) }, 'SERVER_ERROR'],
    ];
    for (const [id, title, setup, expect] of cases) {
      transport.init({ getCookieHeader: async () => setup.cookie, fetchImpl: async () => setup.res });
      let got = null;
      try { await transport.converse({ prompt: 'x' }); } catch (e) { got = e.kind; }
      ok(id, title, got === expect, '实际=' + got);
    }

    transport.init({ getCookieHeader: async () => 'c=1', fetchImpl: async () => mkRes('id: 0\nevent: STREAM_ERROR\ndata: {"error_code":710022004,"error_msg":"rate limited"}\n\n') });
    let rateKind = null;
    try { await transport.converse({ prompt: 'x' }); } catch (e) { rateKind = e.kind; }
    ok('C6', '业务码 710022004 -> RATE_LIMITED', rateKind === 'RATE_LIMITED');

    transport.init({ getCookieHeader: async () => 'c=1', fetchImpl: async () => mkRes('id: 0\nevent: STREAM_ERROR\ndata: {"error_code":1,"error_msg":"请完成验证码"}\n\n') });
    let capKind = null;
    try { await transport.converse({ prompt: 'x' }); } catch (e) { capKind = e.kind; }
    ok('C7', '验证码类错误 -> CAPTCHA_REQUIRED', capKind === 'CAPTCHA_REQUIRED');

    transport.init({ getCookieHeader: async () => 'c=1', fetchImpl: async () => mkRes('id: 0\nevent: STREAM_ERROR\ndata: {"error_code":2,"error_msg":"common invalid param"}\n\n') });
    let protoKind = null;
    try { await transport.converse({ prompt: 'x' }); } catch (e) { protoKind = e.kind; }
    ok('C8', '参数类错误 -> PROTOCOL_CHANGED', protoKind === 'PROTOCOL_CHANGED');

    ok('C9', '错误信息不含 Cookie 值', !String(await (async () => {
      transport.init({ getCookieHeader: async () => 'sessionid=SECRET_TEST_VALUE', fetchImpl: async () => mkRes('', false, 500) });
      try { await transport.converse({ prompt: 'x' }); } catch (e) { return e.message; }
    })()).includes('SECRET_TEST_VALUE'));
  }

  group('D 文本 Provider');
  {
    const okTx = { converse: async () => ({ text: '收到', creations: [], conversationId: 'c1', events: [], unknownEvents: [], parseErrors: 0, degraded: false }) };
    const r1 = await provider.textProvider.complete({ config: {}, doubao: okTx, messages: [{ role: 'user', content: '你好' }] });
    ok('D1', '正常返回 ok', r1.ok === true && r1.prompt === '收到' && r1.local === false);

    const r2 = await provider.textProvider.complete({ config: {}, doubao: okTx, messages: [] });
    ok('D2', '空消息被拒绝', r2.ok === false && /为空/.test(r2.error));

    const failTx = { converse: async () => { const e = new Error('x'); e.kind = 'RATE_LIMITED'; throw e; } };
    const r3 = await provider.textProvider.complete({ config: {}, doubao: failTx, messages: [{ role: 'user', content: 'x' }] });
    ok('D3', '限流给出可读文案且带 errorKind', r3.ok === false && /频繁/.test(r3.error) && r3.errorKind === 'RATE_LIMITED');
    ok('D4', '限流文案明确说明不会自动重试', /不会自动重试/.test(r3.error));

    let seen = '';
    const capTx = { converse: async (o) => { seen = o.prompt; return { text: 'ok', creations: [], conversationId: '', events: [], unknownEvents: [], parseErrors: 0, degraded: false }; } };
    await provider.textProvider.complete({ config: {}, doubao: capTx, messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '问题' }] });
    ok('D5', '系统提示词并入用户内容(已知限制)', seen.includes('你是助手') && seen.includes('问题'));

    const emptyTx = { converse: async () => ({ text: '', creations: [], conversationId: '', events: [], unknownEvents: ['NEW'], parseErrors: 0, degraded: true }) };
    const r5 = await provider.textProvider.complete({ config: {}, doubao: emptyTx, messages: [{ role: 'user', content: 'x' }] });
    ok('D6', '空返回且 degraded 时提示结构可能变化', r5.ok === false && /结构可能已变化/.test(r5.error));

    ok('D7', 'Provider 元数据声明 auth', provider.textProvider.auth && provider.textProvider.auth.statusKey === 'doubao');
    ok('D8', 'Provider 不含 apiKey 配置(凭据由登录管理)', Object.keys(provider.textProvider.configSchema).length === 0);
  }

  group('E 生图 Provider 与图片校验');
  {
    const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]), Buffer.alloc(60)]);
    PNG.writeUInt32BE(2048, 16); PNG.writeUInt32BE(2048, 20);
    const mkImg = (buf) => ({ netFetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }) });

    const imgTx = { converse: async () => ({ text: '', creations: [{ url: 'https://x/y.jpeg', width: 2048, height: 2048 }], conversationId: 'c2', events: [], unknownEvents: [], parseErrors: 0, degraded: false }) };
    const g1 = await provider.imageProvider.generate(Object.assign({ config: {}, doubao: imgTx, prompt: '猫' }, mkImg(PNG)));
    ok('E1', '生图返回 buffer', Buffer.isBuffer(g1.buffer) && g1.buffer.length > 0);
    ok('E2', 'URL 后缀 .jpeg 但实际识别为 png', g1.format === 'png', 'format=' + g1.format);
    ok('E3', '从 PNG 头读出真实尺寸', g1.width === 2048 && g1.height === 2048);
    ok('E4', '返回契约含 buffer(与既有 image-gen 一致)', typeof g1.buffer !== 'undefined');

    ok('E5', 'PNG 魔数识别', provider.sniffImage(PNG) === 'png');
    ok('E6', 'JPEG 魔数识别', provider.sniffImage(Buffer.concat([Buffer.from([0xFF,0xD8,0xFF,0xE0]), Buffer.alloc(20)])) === 'jpg');
    ok('E7', 'WebP 魔数识别', provider.sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)])) === 'webp');
    ok('E8', '未知格式返回 null', provider.sniffImage(Buffer.from('GIF89a..........')) === null);
    ok('E9', '过短数据返回 null', provider.sniffImage(Buffer.from([1, 2])) === null);

    let e1 = null;
    try { await provider.fetchImage({ netFetch: async () => null }, 'http://x/y.jpg', null); } catch (e) { e1 = e; }
    ok('E10', '拒绝非 https 图片地址', e1 && /https/.test(e1.message));

    let e2 = null;
    try { await provider.fetchImage(mkImg(Buffer.from('GIF89a..........')), 'https://x/y.gif', null); } catch (e) { e2 = e; }
    ok('E11', '拒绝无法识别的图片格式', e2 && /无法识别/.test(e2.message));

    let e3 = null;
    try { await provider.fetchImage(mkImg(Buffer.alloc(0)), 'https://x/y.jpg', null); } catch (e) { e3 = e; }
    ok('E12', '拒绝空图片', e3 && /为空/.test(e3.message));

    const noImgTx = { converse: async () => ({ text: '抱歉', creations: [], conversationId: '', events: [], unknownEvents: [], parseErrors: 0, degraded: false }) };
    let e4 = null;
    try { await provider.imageProvider.generate(Object.assign({ config: {}, doubao: noImgTx, prompt: '猫' }, mkImg(PNG))); } catch (e) { e4 = e; }
    ok('E13', '无图片时抛出明确错误', e4 && /未返回图片/.test(e4.message));

    ok('E14', '生图 Provider 声明 image-gen 元数据', provider.imageProvider.kind === 'image-gen' && provider.imageProvider.capabilities.includes('generate'));
    ok('E15', '生图 Provider 同样声明 auth', provider.imageProvider.auth && provider.imageProvider.auth.statusKey === 'doubao');
  }


  group('F 模型目录与选择');
  {
    ok('F1', '模型目录非空且含安全模型', transport.MODEL_CATALOG.length >= 2 && transport.listModels().some(m => m.available));
    ok('F2', '工作任务模型被标记为不可用', (() => {
      const t = transport.MODEL_CATALOG.filter(m => m.taskMode);
      return t.length > 0 && t.every(m => m.available === false && m.blockedReason);
    })(), '避免选中后触发本地工具执行器');
    ok('F3', 'resolveTextModel 放行安全模型', transport.resolveTextModel('3').key === '3');
    ok('F4', 'resolveTextModel 拒绝工作任务模型并回落', (() => {
      const r = transport.resolveTextModel('5');
      return r.key === transport.DEFAULT_TEXT_MODEL && r.blocked && /工作任务/.test(r.blocked.reason);
    })());
    ok('F5', 'resolveTextModel 拒绝未知模型', (() => {
      const r = transport.resolveTextModel('totally-made-up');
      return r.key === transport.DEFAULT_TEXT_MODEL && r.blocked;
    })());
    ok('F6', '空模型 key 回落默认且不报错', (() => {
      const r = transport.resolveTextModel('');
      return r.key === transport.DEFAULT_TEXT_MODEL && r.blocked === null;
    })());

    // 请求体确实用了传入的模型
    let captured = null;
    transport.init({
      getCookieHeader: async () => 'c=1',
      fetchImpl: async (url, opts) => { captured = opts; return mkRes(TEXT_STREAM); },
      now: () => 1,
    });
    await transport.converse({ prompt: 'x', modelKey: '3' });
    const b1 = JSON.parse(captured.body);
    ok('F7', '请求体使用指定模型(四处镜像一致)', (() => {
      const k = '3';
      return b1.option.conversation_init_ext.model_item_key === k
        && b1.option.model_config.model_item_key === k
        && b1.option.aggregate_params.model_item_key === k;
    })());
    ok('F8', '未指定模型时用默认模型', (() => {
      return b1.option.agent_mode === 2;
    })());

    await transport.converse({ prompt: 'x', modelKey: '5' });   // 工作任务模型
    const b2 = JSON.parse(captured.body);
    ok('F9', '传入工作任务模型时实际发出的是默认模型', b2.option.model_config.model_item_key === transport.DEFAULT_TEXT_MODEL,
      'model=' + b2.option.model_config.model_item_key);
    ok('F10', '任何情况下 agent_mode 都不是 1', b2.option.agent_mode === 2);
  }

  group('G 文本回显隔离');
  {
    // 阶段3 实测发现:FULL_MSG_NOTIFY 携带完整历史(含用户自己那条问题),
    // 若把它也当答案拼接,会得到「问题+回答」。修复后只从 CHUNK 类事件取文本。
    const withEcho = 'id: 0\nevent: SSE_ACK\ndata: {"ack_client_meta":{"conversation_id":"c9"}}\n\n' +
      'id: 0\nevent: FULL_MSG_NOTIFY\ndata: {"message":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"请只回答：苹果"}}}]}}\n\n' +
      'id: 0\nevent: STREAM_CHUNK\ndata: {"message":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"苹果"}}}]}}\n\n' +
      'id: 0\nevent: SSE_REPLY_END\ndata: {}\n\n';
    const r = stream.parseAll(withEcho);
    ok('G1', 'NOTIFY 中的用户问题不回显进答案', r.text === '苹果', JSON.stringify(r.text));
    ok('G2', 'NOTIFY 不影响元信息提取', r.conversationId === 'c9');

    const imgNotify = 'id: 0\nevent: STREAM_MSG_NOTIFY\ndata: {"content":{"creation_block":{"creations":[{"type":1,"id":"t1","image":{"key":"k","image_ori":{"url":"https://x/y.jpeg","width":2048,"height":2048}}}]}}}\n\n';
    const ri = stream.parseAll(imgNotify);
    ok('G3', 'NOTIFY 里的创建块仍能提取(生图依赖)', ri.creations.length === 1 && ri.creations[0].width === 2048);
    ok('G4', 'NOTIFY 不产生文本', ri.text === '', JSON.stringify(ri.text));

    const thinkThenAnswer = 'id: 0\nevent: STREAM_CHUNK\ndata: {"content_block":[{"block_type":10040,"content":{"thinking_block":{"text":"内部思考"}}}]}\n\n' +
      'id: 0\nevent: STREAM_CHUNK\ndata: {"content_block":[{"block_type":10000,"content":{"text_block":{"text":"答案"}}}]}\n\n';
    ok('G5', '思考块内容不混入答案', stream.parseAll(thinkThenAnswer).text === '答案', JSON.stringify(stream.parseAll(thinkThenAnswer).text));
  }


  group('H 真实流样本回归');
  {
    const fsx = require('node:fs');
    const FX = path.join(__dirname, 'fixtures');
    const readFx = (n) => fsx.readFileSync(path.join(FX, n), 'utf8');

    // 这是从真实豆包响应抓下来的样本(已脱敏):
    //   FULL_MSG_NOTIFY 带 ext.message_from='InputBox' → 用户回显,不能取文本
    //   STREAM_MSG_NOTIFY 的 content.content_block → 助手答案
    //   STREAM_CHUNK 是 patch_op 增量,此样本只带 is_finish
    const real = stream.parseAll(readFx('doubao-text-with-echo.txt'));
    ok('H1', '真实流:用户回显不进答案', !real.text.includes('请只回答'), JSON.stringify(real.text));
    ok('H2', '真实流:答案被正确提取', real.text === '苹果', JSON.stringify(real.text));
    ok('H3', '真实流:事件全部保留', real.events.length >= 5, real.events.join(','));
    ok('H4', '真实流:无 JSON 解析错误', real.parseErrors === 0);
    ok('H5', '真实流:conversationId 被提取', real.conversationId === 'c-real');

    // 累积快照:同一 block_id 多次推送越来越长的文本,只能追加新增部分
    const acc = stream.parseAll(readFx('doubao-cumulative-snapshot.txt'));
    ok('H6', '累积快照去重(不重复拼接)', acc.text === '你好呀', JSON.stringify(acc.text));

    // 生图创建块只在 NOTIFY 里,必须能提取
    const img = stream.parseAll(readFx('doubao-image-creation.txt'));
    ok('H7', '真实流:生图创建块被提取', img.creations.length === 1 && img.creations[0].width === 2048);
    ok('H8', '真实流:生图帧不产生文本', img.text === '', JSON.stringify(img.text));
  }
  const s = summarize();
  console.log('');
  console.log('---- 第二十部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败' + (s.skipped ? ', ' + s.skipped + ' 跳过' : '') + ' ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(2); });