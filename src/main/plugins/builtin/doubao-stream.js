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

  function walk(node, depth, opt) {
    const takeText = !opt || opt.text !== false;
    const takeCreations = !opt || opt.creations !== false;
    if (depth > 12) return;
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const it of node) walk(it, depth + 1, opt); return; }

    if (node.error_code !== undefined && node.error_code !== 0 && node.error_code !== 0) {
      st.errors.push({ code: node.error_code, msg: node.error_msg || node.message || '' });
    }
    if (typeof node.conversation_id === 'string' && node.conversation_id && !st.conversationId) st.conversationId = node.conversation_id;
    if (typeof node.message_id === 'string' && node.message_id && !st.messageId) st.messageId = node.message_id;

    if (takeCreations && node.creation_block && Array.isArray(node.creation_block.creations)) {
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

    if (takeText && node.text_block && typeof node.text_block.text === 'string' && node.text_block.text) {
      st.text += node.text_block.text;
    }

    for (const k of Object.keys(node)) walk(node[k], depth + 1, opt);
  }

  // 事件语义(阶段3 用真实流逐帧核对过,别再凭猜改):
  //
  //   FULL_MSG_NOTIFY    用户自己那条消息的回显。判据:ext.message_from === 'InputBox'。
  //                      【不能取文本】—— 否则答案前面会粘上用户的问题。
  //   STREAM_MSG_NOTIFY  助手回复的快照。实测普通对话的答案就在这里的
  //                      content.content_block[].content.text_block.text。
  //   STREAM_CHUNK       增量补丁(patch_op)。普通对话里常常只带 is_finish 之类的
  //                      空 text_block;只有开了 chunk delta 才会带真实增量。
  //   其它(SSE_ACK 等)  只取元信息。
  //
  // 结论:文本要同时从 STREAM_MSG_NOTIFY 与 STREAM_CHUNK 取,但从
  //       FULL_MSG_NOTIFY 取时必须先确认它不是用户消息。
  function isUserEcho(data) {
    if (!data || typeof data !== 'object') return false;
    const msg = data.message;
    if (msg && typeof msg === 'object') {
      const ext = msg.ext;
      if (ext && typeof ext === 'object' && ext.message_from === 'InputBox') return true;
    }
    const ext2 = data.ext;
    if (ext2 && typeof ext2 === 'object' && ext2.message_from === 'InputBox') return true;
    return false;
  }

  function handleFrame(frame) {
    note(frame.event);
    if (frame.event === 'SSE_REPLY_END' || frame.event === 'SSE_FINISH') st.ended = true;
    if (frame.event === 'SSE_HEARTBEAT') return;
    if (!frame.data) return;

    if (frame.event === 'FULL_MSG_NOTIFY') {
      // 用户消息回显:绝不取文本;创建块照取(理论上不会有,但保持一致)
      walk(frame.data, 0, { text: false, creations: true });
      return;
    }
    if (frame.event === 'STREAM_MSG_NOTIFY' || frame.event === 'STREAM_CHUNK' || frame.event === 'CHUNK_DELTA') {
      if (isUserEcho(frame.data)) {
        walk(frame.data, 0, { text: false, creations: true });
        return;
      }
      // 【快照去重】STREAM_MSG_NOTIFY 可能多次推送累积文本。
      // 用 block_id 记录每个块已计入的长度,只取新增部分,避免重复拼接。
      walkWithDelta(frame.data, 0);
      return;
    }
    walk(frame.data, 0, { text: false, creations: true });
  }

  // 按 block_id 做增量:同一块的新快照只追加"比上次更长"的部分。
  //
  // 注意:一旦在一个 block 节点上处理过 text_block,就不再深入它的 text_block,
  // 否则同一个内容会被本函数在子节点上再命中一次(实测会拼成 "你你好你好呀")。
  const blockSeen = new Map();
  // ctxId:向下传递的 block_id。
  // 真实结构是 { block_type, block_id, content: { text_block: {...} } } ——
  // block_id 与 text_block 不在同一层,所以必须带着它往下走。
  function walkWithDelta(node, depth, ctxId) {
    if (depth > 12) return;
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const it of node) walkWithDelta(it, depth + 1, ctxId); return; }

    const ownId = typeof node.block_id === 'string' ? node.block_id : '';
    const bid = ownId || ctxId;
    const tb = node.text_block;
    if (tb && typeof tb === 'object' && typeof tb.text === 'string') {
      const full = tb.text;
      if (bid) {
        const prev = blockSeen.get(bid) || '';
        if (full.length > prev.length && full.startsWith(prev)) {
          st.text += full.slice(prev.length);   // 追加新增部分
        } else if (full !== prev) {
          // 不是前缀关系(内容被替换):无法可靠增量,按整段追加
          st.text += full;
        }
        blockSeen.set(bid, full);
      } else {
        // 无 block_id 的增量:直接追加
        st.text += full;
      }
      // 已在本层处理过文本,不再深入 text_block 子节点,避免重复命中
      return;
    }

    if (node.creation_block && Array.isArray(node.creation_block.creations)) {
      for (const c of node.creation_block.creations) {
        if (c && c.image) {
          const ori = c.image.image_ori || {};
          const prev = c.image.image_preview || {};
          const thumb = c.image.image_thumb || {};
          const url = ori.url || prev.url || thumb.url;
          // 同一 taskId 可能多次推送(先占位后有 URL),按 taskId 去重
          if (url && !st.creations.some(x => x.taskId && x.taskId === c.id)) {
            st.creations.push({
              taskId: c.id || '', key: c.image.key || '', url,
              width: ori.width || 0, height: ori.height || 0,
            });
          }
        }
      }
    }

    for (const k of Object.keys(node)) walkWithDelta(node[k], depth + 1, bid);
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