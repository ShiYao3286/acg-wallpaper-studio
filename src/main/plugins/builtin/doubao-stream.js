// 豆包私有流解析(阶段 3.4)
//
// 为什么单独一个模块:
//   豆包响应【不是标准 SSE】。标准 SSE 每帧只有 data:,而豆包每帧三行:
//     id: 0
//     event: SSE_ACK
//     data: {...}
//   只认 data: 的通用解析器会丢掉 event,于是分不清 SSE_ACK / STREAM_CHUNK /
//   STREAM_ERROR —— 阶段 3.1 实测确认过。
//
// 设计:
//   1. 纯函数模块,不做网络、不依赖 electron,便于大量单测。
//   2. 支持分块输入(一个 chunk 可能把一帧切两半)。
//   3. 不认识的 event 保留下来,供上层判断"协议是不是变了"。
//   4. 坏 JSON 不抛错,计入 parseErrors,由上层决定如何处理。

// 已识别的事件名。不在这里的一律进 unknownEvents。
const KNOWN_EVENTS = new Set([
  'SSE_HEARTBEAT', 'SSE_ACK', 'STREAM_MSG_NOTIFY', 'STREAM_CHUNK',
  'FULL_MSG_NOTIFY', 'DOWNLINK_CMD', 'SSE_REPLY_END', 'SSE_FINISH', 'STREAM_ERROR',
]);

function createParser(options) {
  const opt = options || {};
  const maxBytes = opt.maxBytes || (8 * 1024 * 1024);

  let buffer = '';
  let totalBytes = 0;
  let overflow = false;
  const seen = new Set();
  const st = {
    text: '',
    conversationId: '',
    messageId: '',
    events: [],
    unknownEvents: [],
    errors: [],
    parseErrors: 0,
    creations: [],
    ended: false,
    overflow: false,
  };

  function note(name) {
    if (!name) return;
    if (!seen.has(name)) { seen.add(name); st.events.push(name); }
    if (!KNOWN_EVENTS.has(name) && !st.unknownEvents.includes(name)) st.unknownEvents.push(name);
  }

  function walk(node, depth) {
    if (depth > 12) return;
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const it of node) walk(it, depth + 1); return; }

    if (node.error_code !== undefined && node.error_code !== 0 && node.error_code !== 0) {
      st.errors.push({ code: node.error_code, msg: node.error_msg || node.message || '' });
    }
    if (typeof node.conversation_id === 'string' && node.conversation_id && !st.conversationId) st.conversationId = node.conversation_id;
    if (typeof node.message_id === 'string' && node.message_id && !st.messageId) st.messageId = node.message_id;

    if (node.creation_block && Array.isArray(node.creation_block.creations)) {
      for (const c of node.creation_block.creations) {
        if (c && c.image) {
          const ori = c.image.image_ori || {};
          const prev = c.image.image_preview || {};
          const thumb = c.image.image_thumb || {};
          const url = ori.url || prev.url || thumb.url;
          if (url) st.creations.push({
            taskId: c.id || '', key: c.image.key || '', url,
            width: ori.width || 0, height: ori.height || 0,
          });
        }
      }
    }

    if (node.text_block && typeof node.text_block.text === 'string' && node.text_block.text) {
      st.text += node.text_block.text;
    }

    for (const k of Object.keys(node)) walk(node[k], depth + 1);
  }

  function handleFrame(frame) {
    note(frame.event);
    if (frame.event === 'SSE_REPLY_END' || frame.event === 'SSE_FINISH') st.ended = true;
    if (frame.event === 'SSE_HEARTBEAT') return;
    if (!frame.data) return;
    walk(frame.data, 0);
  }

  // 从缓冲区切出完整帧。帧之间以空行分隔(\n\n 或 \r\n\r\n)。
  function drain() {
    let sep;
    while (true) {
      const i1 = buffer.indexOf('\n\n');
      const i2 = buffer.indexOf('\r\n\r\n');
      let cut = -1, skip = 0;
      if (i1 >= 0 && (i2 < 0 || i1 <= i2)) { cut = i1; skip = 2; }
      else if (i2 >= 0) { cut = i2; skip = 4; }
      if (cut < 0) break;
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + skip);
      parseChunk(chunk);
    }
  }

  function parseChunk(raw) {
    if (!raw.trim()) return;
    const frame = { id: null, event: '', data: null, raw };
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith('id:')) {
        const v = line.slice(3).trim();
        frame.id = v === '' ? null : v;
      } else if (line.startsWith('event:')) {
        frame.event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const v = line.slice(5).trim();
        if (v === '' || v === '{}') { frame.data = frame.data || {}; continue; }
        try { frame.data = JSON.parse(v); }
        catch (e) { st.parseErrors++; }
      }
    }
    handleFrame(frame);
  }

  // 喂入一个网络 chunk
  function write(chunk) {
    if (overflow) return;
    const s = typeof chunk === 'string' ? chunk : String(chunk);
    totalBytes += Buffer.byteLength(s, 'utf8');
    if (totalBytes > maxBytes) { overflow = true; st.overflow = true; return; }
    buffer += s;
    drain();
  }

  // 流结束:冲掉残留(可能最后一帧没有空行结尾)
  function end() {
    if (buffer.trim()) { const rest = buffer; buffer = ''; parseChunk(rest); }
    return snapshot();
  }

  function snapshot() {
    return {
      text: st.text,
      conversationId: st.conversationId,
      messageId: st.messageId,
      events: st.events.slice(),
      unknownEvents: st.unknownEvents.slice(),
      errors: st.errors.slice(),
      parseErrors: st.parseErrors,
      creations: st.creations.slice(),
      ended: st.ended,
      overflow: st.overflow,
    };
  }

  return { write, end, snapshot };
}

// 一次性解析整段文本(测试与短响应方便用)
function parseAll(text, options) {
  const p = createParser(options);
  p.write(text);
  return p.end();
}

module.exports = { createParser, parseAll, KNOWN_EVENTS };