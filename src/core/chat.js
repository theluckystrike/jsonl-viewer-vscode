'use strict';
// Turns a record into chat turns for the chat view. Shared by the webview and the tests.
// Knows OpenAI messages (with tool_calls), Anthropic content blocks, ShareGPT {from, value},
// Gemini {role, parts}, agent session lines {type, message}, and prompt/completion pairs.

const LIST_KEYS = ['messages', 'conversations', 'conversation', 'contents', 'chat', 'dialog'];
const ROLE_ALIASES = { human: 'user', gpt: 'assistant', model: 'assistant', bot: 'assistant', ai: 'assistant', chatgpt: 'assistant', function: 'tool', ipython: 'tool' };

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function role(r) {
  const s = String(r === undefined || r === null ? 'unknown' : r).toLowerCase();
  return ROLE_ALIASES[s] || s;
}

function pretty(v) {
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  return JSON.stringify(v, null, 2);
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v, null, 2);
}

/** Content (string, array of blocks or object) to parts [{kind, text, name?}]. */
function contentParts(c) {
  if (c === undefined || c === null) return [];
  if (typeof c === 'string') return [{ kind: 'text', text: c }];
  if (!Array.isArray(c)) {
    if (isObj(c) && typeof c.text === 'string') return [{ kind: 'text', text: c.text }];
    return [{ kind: 'json', text: pretty(c) }];
  }
  const out = [];
  for (const b of c) {
    if (typeof b === 'string') { out.push({ kind: 'text', text: b }); continue; }
    if (!isObj(b)) { out.push({ kind: 'json', text: pretty(b) }); continue; }
    const t = b.type;
    if (typeof b.text === 'string' && (!t || /text/.test(t))) out.push({ kind: 'text', text: b.text });
    else if (t === 'tool_use' || t === 'function_call' || t === 'server_tool_use') out.push({ kind: 'tool_call', name: String(b.name || 'tool'), text: pretty(b.input !== undefined ? b.input : b.arguments) });
    else if (t === 'tool_result' || t === 'function_call_output' || t === 'function_response') out.push({ kind: 'tool_result', name: String(b.tool_use_id || b.call_id || b.name || ''), text: contentParts(b.content !== undefined ? b.content : b.output !== undefined ? b.output : b.response).map(p => p.text).join('\n') });
    else if (t === 'thinking' || t === 'reasoning' || t === 'redacted_thinking') out.push({ kind: 'thinking', text: textOf(b.thinking !== undefined ? b.thinking : b.text !== undefined ? b.text : b.summary) });
    else if (t === 'image_url' || t === 'image' || t === 'input_image' || b.inline_data || b.inlineData) {
      const url = b.image_url && (b.image_url.url || b.image_url) || b.url || (b.source && (b.source.url || b.source.media_type)) || 'inline data';
      const u = String(typeof url === 'string' ? url : 'inline data');
      out.push({ kind: 'image', text: u.startsWith('data:') ? u.slice(0, u.indexOf(',') > 0 ? u.indexOf(',') : 40) + ',…' : u.slice(0, 300) });
    } else if (b.functionCall) out.push({ kind: 'tool_call', name: String(b.functionCall.name || 'tool'), text: pretty(b.functionCall.args) });
    else if (b.functionResponse) out.push({ kind: 'tool_result', name: String(b.functionResponse.name || ''), text: pretty(b.functionResponse.response) });
    else out.push({ kind: 'json', text: pretty(b) });
  }
  return out;
}

/** One message object to a turn {role, name, parts}. */
function turnOf(m) {
  if (typeof m === 'string') return { role: 'unknown', parts: [{ kind: 'text', text: m }] };
  if (!isObj(m)) return { role: 'unknown', parts: [{ kind: 'json', text: pretty(m) }] };
  if (isObj(m.message) && (m.message.role || m.message.content !== undefined)) {
    const t = turnOf(m.message);
    if (!m.message.role && m.type) t.role = role(m.type);
    return t;
  }
  const r = role(m.role !== undefined ? m.role : m.from !== undefined ? m.from : m.speaker !== undefined ? m.speaker : m.author);
  const parts = contentParts(m.content !== undefined ? m.content : m.value !== undefined ? m.value : m.parts !== undefined ? m.parts : m.text);
  if (typeof m.reasoning_content === 'string' && m.reasoning_content) parts.unshift({ kind: 'thinking', text: m.reasoning_content });
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      const f = isObj(tc) && isObj(tc.function) ? tc.function : tc;
      parts.push({ kind: 'tool_call', name: String((f && f.name) || 'tool'), text: pretty(f && f.arguments !== undefined ? f.arguments : f && f.input) });
    }
  }
  if (isObj(m.function_call)) parts.push({ kind: 'tool_call', name: String(m.function_call.name || 'function'), text: pretty(m.function_call.arguments) });
  const t = { role: r, parts };
  const name = m.name || m.tool_call_id;
  if (name) t.name = String(name);
  return t;
}

/** Chat turns for a record, or null when the record does not hold a conversation. */
function chatTurns(rec) {
  if (!isObj(rec)) return null;
  for (const k of LIST_KEYS) {
    if (Array.isArray(rec[k]) && rec[k].length && rec[k].every(m => isObj(m) || typeof m === 'string')) {
      const turns = rec[k].map(turnOf);
      if (k === 'contents' || k === 'messages') { /* fine */ }
      return { key: k, turns };
    }
  }
  if (typeof rec.prompt === 'string' || Array.isArray(rec.prompt)) {
    const turns = Array.isArray(rec.prompt) ? rec.prompt.map(turnOf) : [{ role: 'user', parts: [{ kind: 'text', text: rec.prompt }] }];
    for (const k of ['completion', 'response', 'chosen', 'rejected']) {
      const v = rec[k];
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const m of v) { const t = turnOf(m); if (k === 'chosen' || k === 'rejected') t.name = k; turns.push(t); }
      else turns.push({ role: 'assistant', name: k === 'completion' || k === 'response' ? undefined : k, parts: contentParts(v) });
    }
    return { key: 'prompt', turns };
  }
  if ((rec.role !== undefined && (rec.content !== undefined || rec.parts !== undefined || rec.text !== undefined)) || (isObj(rec.message) && (rec.message.role || rec.message.content !== undefined))) {
    return { key: '', turns: [turnOf(rec)] };
  }
  return null;
}

/** Short top-level fields to show above a conversation (not the chat list itself). */
function chatMeta(rec, key, max = 8) {
  if (!isObj(rec)) return [];
  const skip = new Set([key, 'prompt', 'completion', 'response', 'chosen', 'rejected', 'role', 'content', 'message', 'parts']);
  const out = [];
  for (const k of Object.keys(rec)) {
    if (skip.has(k)) continue;
    const v = rec[k];
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s === undefined) continue;
    if (s.length > 80) s = s.slice(0, 80) + '…';
    out.push([k, s]);
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { chatTurns, chatMeta, contentParts, turnOf };
