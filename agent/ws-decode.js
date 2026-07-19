'use strict';

// Rebuild the delta_encoding v1 SSE payloads carried by ChatGPT's WS pub/sub.

function decodeConversationFrames(frames) {
  const items = [];
  let order = 0;

  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.encoded_item === 'string') {
      items.push({
        encoded: value.encoded_item,
        streamId: value.stream_item_id,
        sequence: Number.isFinite(value.sequence_id) ? value.sequence_id : undefined,
        timestamp: Number.isFinite(value.server_timestamp_ms) ? value.server_timestamp_ms : undefined,
        conversationId: value.conversation_id,
        turnId: value.turn_id,
        order: order++,
      });
      return;
    }
    for (const child of Object.values(value)) collect(child);
  }

  for (const frame of frames || []) {
    try { collect(JSON.parse(frame)); } catch { /* Ignore non-JSON WS frames. */ }
  }

  const seen = new Set();
  const unique = items.filter((item) => {
    // Older captures omit sequence_id; stream_item_id is then the item identity.
    const key = `${item.streamId || item.encoded}\u0000${item.sequence ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => {
    if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence || a.order - b.order;
    if (a.sequence !== undefined) return -1;
    if (b.sequence !== undefined) return 1;
    if (a.timestamp !== undefined && b.timestamp !== undefined) return a.timestamp - b.timestamp || a.order - b.order;
    return a.order - b.order;
  });

  let state = {};
  let lastPath = '';
  let done = false;
  let convId;
  let turnId;

  function partsText() {
    const parts = state?.message?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((part) => typeof part === 'string' ? part : '').join('');
  }

  function pointer(path) {
    return (path || '').split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  }

  function setAt(path, value, append) {
    const keys = pointer(path);
    if (!keys.length) {
      state = append && typeof state === 'string' ? state + String(value) : value;
      return;
    }
    let target = state;
    if (!target || typeof target !== 'object') state = target = {};
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!target[key] || typeof target[key] !== 'object') target[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
      target = target[key];
    }
    const key = keys[keys.length - 1];
    if (append) {
      if (typeof target[key] === 'string' || typeof value === 'string') target[key] = (target[key] || '') + String(value);
      else if (Array.isArray(target[key])) target[key].push(value);
      else target[key] = value;
    } else {
      target[key] = value;
    }
  }

  function checkDone(value) {
    if (value === '[DONE]') { done = true; return; }
    if (!value || typeof value !== 'object') return;
    if (value.type === 'message_stream_complete' || value.is_complete === true || value.status === 'finished_successfully') done = true;
    for (const child of Object.values(value)) checkDone(child);
  }

  function apply(operation) {
    if (!operation || typeof operation !== 'object') return;
    checkDone(operation);
    if ((operation.p === '/message/status' && operation.v === 'finished_successfully') ||
        (operation.p === '/message/is_complete' && operation.v === true)) done = true;
    if (operation.o === 'patch' && Array.isArray(operation.v)) {
      for (const nested of operation.v) apply(nested);
      return;
    }
    const hasPath = Object.prototype.hasOwnProperty.call(operation, 'p');
    const path = hasPath ? operation.p : lastPath;
    if (hasPath) lastPath = path;
    if (!Object.prototype.hasOwnProperty.call(operation, 'v')) return;
    const op = operation.o || 'append';
    if (!operation.o && operation.v?.message) {
      state = operation.v; // A v1 snapshot replaces the previous message state.
      return;
    }
    setAt(path, operation.v, op === 'append');
  }

  for (const item of unique) {
    convId ||= item.conversationId;
    turnId ||= item.turnId;
  }
  // An SSE event can itself cross WS frames, so only parse after rejoining them.
  for (const block of unique.map((item) => item.encoded).join('').replace(/\r\n/g, '\n').split('\n\n')) {
    const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { done = true; continue; }
    try {
      const value = JSON.parse(data);
      convId ||= value.conversation_id;
      turnId ||= value.turn_id || value.turn_exchange_id;
      apply(value);
    } catch { /* Non-JSON SSE metadata does not affect the assistant text. */ }
  }
  return { text: partsText(), done, convId, turnId };
}

module.exports = { decodeConversationFrames };
