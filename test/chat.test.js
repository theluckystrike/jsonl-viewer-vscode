'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { chatTurns, chatMeta } = require('../src/core/chat');

test('OpenAI messages with tool calls', () => {
  const r = chatTurns({ messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get', arguments: '{"a":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
  ] });
  assert.strictEqual(r.key, 'messages');
  assert.deepStrictEqual(r.turns.map(t => t.role), ['system', 'user', 'assistant', 'tool']);
  assert.deepStrictEqual(r.turns[1].parts.map(p => p.kind), ['text', 'image']);
  assert.strictEqual(r.turns[1].parts[1].text, 'data:image/png;base64,…');
  assert.strictEqual(r.turns[2].parts[0].kind, 'tool_call');
  assert.strictEqual(r.turns[2].parts[0].name, 'get');
  assert.strictEqual(r.turns[2].parts[0].text, '{\n  "a": 1\n}');
  assert.strictEqual(r.turns[3].name, 'c1');
});

test('Anthropic blocks, ShareGPT, Gemini and prompt/completion', () => {
  const a = chatTurns({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'ls', input: { p: '.' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }] }] });
  assert.deepStrictEqual(a.turns[0].parts.map(p => p.kind), ['thinking', 'tool_call']);
  assert.strictEqual(a.turns[1].parts[0].text, 'a.txt');
  const s = chatTurns({ conversations: [{ from: 'human', value: 'q' }, { from: 'gpt', value: 'a' }] });
  assert.deepStrictEqual(s.turns.map(t => t.role), ['user', 'assistant']);
  const g = chatTurns({ contents: [{ role: 'model', parts: [{ text: 'x' }, { functionCall: { name: 'f', args: { a: 1 } } }] }] });
  assert.deepStrictEqual(g.turns[0].parts.map(p => p.kind), ['text', 'tool_call']);
  assert.strictEqual(g.turns[0].role, 'assistant');
  const p = chatTurns({ prompt: 'q', chosen: 'good', rejected: 'bad' });
  assert.deepStrictEqual(p.turns.map(t => [t.role, t.name]), [['user', undefined], ['assistant', 'chosen'], ['assistant', 'rejected']]);
});

test('single turns and agent session lines', () => {
  assert.strictEqual(chatTurns({ role: 'user', content: 'x' }).turns[0].role, 'user');
  const t = chatTurns({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  assert.strictEqual(t.turns[0].parts[0].text, 'done');
});

test('non-chat records give null; meta skips the chat key', () => {
  assert.strictEqual(chatTurns({ level: 'info' }), null);
  assert.strictEqual(chatTurns([1, 2]), null);
  assert.strictEqual(chatTurns({ messages: [] }), null);
  assert.deepStrictEqual(chatMeta({ id: 'a', messages: [], score: 1 }, 'messages'), [['id', 'a'], ['score', '1']]);
});
