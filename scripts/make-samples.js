'use strict';
// Writes the sample files to samples/ (or the folder given as argv[2]). All data is generated
// from a fixed seed: no real logs, people or datasets. Each file stays under 5 MB.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'samples'));
fs.mkdirSync(out, { recursive: true });

let seed = 20261106;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
const pick = a => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// ---- chat-finetune.jsonl: 300 OpenAI-style conversations with tool calls ----
const cities = ['Lisbon', 'Osaka', 'Nairobi', 'Denver', 'Tallinn', 'Hobart', 'Quito', 'Gdansk', 'Recife', 'Busan'];
const items = ['trail shoes', 'a desk lamp', 'noise-cancelling headphones', 'a cast iron pan', 'a rain jacket', 'a mechanical keyboard'];
const units = [['miles', 'kilometers', 1.609344], ['pounds', 'kilograms', 0.45359237], ['fahrenheit', 'celsius', null], ['gallons', 'liters', 3.785411784]];
const SYS = 'You are Juniper, the support assistant for Northwind Outfitters (a made-up store). Be brief. Use tools when you need live data.';
const chat = [];
for (let i = 0; i < 300; i++) {
  const kind = i % 4;
  const messages = [{ role: 'system', content: SYS }];
  if (kind === 0) {
    const city = pick(cities), t = int(-5, 33), id = `call_${(i * 7919).toString(36)}`;
    messages.push({ role: 'user', content: `Will I need a jacket in ${city} tomorrow?` });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'get_forecast', arguments: JSON.stringify({ city, days: 1 }) } }] });
    messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ city, high_c: t, low_c: t - int(4, 9), rain_mm: int(0, 12) }) });
    messages.push({ role: 'assistant', content: t < 14 ? `Yes. ${city} tops out at ${t}°C tomorrow, so a light jacket is a good idea.` : `Probably not. ${city} reaches ${t}°C tomorrow. A t-shirt should do. 🌤️` });
  } else if (kind === 1) {
    const order = `NW-${int(10000, 99999)}`, item = pick(items), id = `call_${(i * 104729).toString(36)}`;
    messages.push({ role: 'user', content: `Where is my order ${order}? It was ${item}.` });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'lookup_order', arguments: JSON.stringify({ order_id: order }) } }] });
    const st = pick(['in transit', 'out for delivery', 'delivered', 'label created']);
    messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ order_id: order, status: st, eta_days: st === 'delivered' ? 0 : int(1, 4) }) });
    messages.push({ role: 'assistant', content: st === 'delivered' ? `Order ${order} shows as delivered. If it isn't at your door, I can open a trace for you.` : `Order ${order} (${item}) is ${st}. It should arrive in about ${int(1, 4)} days.` });
  } else if (kind === 2) {
    const [a, b, f] = pick(units), v = int(2, 250);
    const r = f ? Math.round(v * f * 100) / 100 : Math.round(((v - 32) * 5 / 9) * 10) / 10;
    messages.push({ role: 'user', content: `How many ${b} is ${v} ${a}?` });
    messages.push({ role: 'assistant', content: `${v} ${a} is ${r} ${b}.` });
  } else {
    messages.push({ role: 'user', content: 'Can you write a two-line haiku about a lost parcel? I know haiku have three lines.' });
    messages.push({ role: 'assistant', content: `Box waits in the rain,\nthe porch light knows its name now.\n(A third line, for luck: ${pick(cities)} at dusk.)` });
    messages.push({ role: 'user', content: 'Ha. Thanks, Juniper.' });
    messages.push({ role: 'assistant', content: 'Any time. Your parcel will turn up.' });
  }
  chat.push(JSON.stringify({ messages }));
}
fs.writeFileSync(path.join(out, 'chat-finetune.jsonl'), chat.join('\n') + '\n');

// ---- app-logs.ndjson: 30,000 structured log lines ----
const routes = ['/api/orders', '/api/cart', '/api/search', '/api/login', '/healthz', '/api/payments'];
const regions = ['eu-west', 'us-east', 'ap-south'];
const msgs = {
  debug: ['cache hit', 'query planned', 'retrying idempotent call'],
  info: ['request done', 'user signed in', 'order created', 'cart updated'],
  warn: ['slow query', 'retry budget low', 'deprecated header used'],
  error: ['upstream timeout', 'payment declined by test gateway', 'db connection reset'],
};
const logs = [];
let ts = Date.UTC(2026, 10, 5, 8, 0, 0);
for (let i = 0; i < 30000; i++) {
  ts += int(5, 400);
  const r = rnd();
  const level = r < 0.02 ? 'error' : r < 0.08 ? 'warn' : r < 0.2 ? 'debug' : 'info';
  const route = pick(routes);
  const ms = level === 'warn' ? int(800, 4000) : int(2, 600);
  const rec = { ts: new Date(ts).toISOString(), level, msg: pick(msgs[level]), ctx: { req: (i * 2654435761 >>> 0).toString(16), route, ms, region: pick(regions), user: `u${int(1, 900)}` } };
  if (level === 'error') rec.err = { code: pick(['ETIMEDOUT', 'ECONNRESET', 'DECLINED']), retry: rnd() < 0.5 };
  logs.push(JSON.stringify(rec));
}
const logText = logs.join('\n') + '\n';
fs.writeFileSync(path.join(out, 'app-logs.ndjson'), logText);
fs.writeFileSync(path.join(out, 'logs.jsonl.gz'), zlib.gzipSync(Buffer.from(logText), { level: 9 }));

// ---- eval-results.jsonl ----
const evals = [];
const ops = [['+', (a, b) => a + b], ['-', (a, b) => a - b], ['*', (a, b) => a * b]];
for (let i = 0; i < 600; i++) {
  const [s, f] = pick(ops), a = int(2, 99), b = int(2, 99), want = f(a, b);
  const wrong = rnd() < 0.18;
  const got = wrong ? want + pick([-10, -1, 1, 2, 100]) : want;
  evals.push(JSON.stringify({
    id: `arith-${String(i).padStart(4, '0')}`,
    input: `What is ${a} ${s} ${b}? Reply with the number only.`,
    expected: String(want),
    output: rnd() < 0.05 ? `The answer is ${got}.` : String(got),
    score: wrong ? 0 : 1,
    latency_ms: int(180, 2400),
    tags: [s === '*' ? 'multiply' : s === '+' ? 'add' : 'subtract', a > 50 || b > 50 ? 'two-digit' : 'small'],
    model: pick(['model-a', 'model-b']),
  }));
}
fs.writeFileSync(path.join(out, 'eval-results.jsonl'), evals.join('\n') + '\n');

// ---- mixed-edge.jsonl: unicode, emoji, deep nesting, blank lines, 3 bad lines, one 2 MB line ----
let deep = { leaf: 'bottom' };
for (let d = 0; d < 40; d++) deep = { level: 40 - d, child: deep };
const edge = [
  JSON.stringify({ id: 1, text: 'Plain ASCII line' }),
  JSON.stringify({ id: 2, text: 'Ünïcödé: 日本語, Ελληνικά, עברית, العربية', emoji: '🚀🧪🦊👩🏽‍💻' }),
  '',
  JSON.stringify({ id: 3, text: 'tab\tand newline\\n escaped, quote " and backslash \\', html: '<script>alert(1)</script><img src=x onerror=alert(2)>' }),
  '   ',
  JSON.stringify({ id: 4, deep }),
  '{"id": 5, "text": "missing closing brace"',
  JSON.stringify({ id: 6, arr: [1, 'two', null, true, { three: 3 }, [4, [5, [6]]]] }),
  "{'id': 7, 'text': 'single quotes are not JSON'}",
  JSON.stringify({ id: 8, big: 'x'.repeat(2 * 1024 * 1024 - 40) }),
  JSON.stringify([1, 2, 3]),
  '"just a string"',
  'NaN',
  JSON.stringify({ id: 12, 'key with spaces': 1, 'dotted.key': 2, 'quote\'s': 3, nested: { 'a-b': [10, 20] } }),
  '\r',
  JSON.stringify({ id: 13, text: 'last line, Windows line ending' }) + '\r',
];
fs.writeFileSync(path.join(out, 'mixed-edge.jsonl'), edge.join('\n') + '\n');

for (const f of fs.readdirSync(out)) {
  const s = fs.statSync(path.join(out, f)).size;
  console.log(`${f}\t${(s / 1024 / 1024).toFixed(2)} MB`);
  if (s >= 5 * 1024 * 1024) { console.error(`${f} is over 5 MB`); process.exitCode = 1; }
}
