'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseFilter, testFilter, parsePath, getPath, FilterError } = require('../src/core/filter');

const rec = { level: 'error', score: 0.75, n: 12, tags: ['smoke', 'fast'], ctx: { user: { id: 7 }, route: '/api/Orders' }, 'odd key': 'yes', nul: null };
const t = src => testFilter(parseFilter(src), rec);

test('paths', () => {
  assert.deepStrictEqual(parsePath('a.b[2]["odd key"].c'), ['a', 'b', 2, 'odd key', 'c']);
  assert.deepStrictEqual(parsePath('$.ctx.user'), ['ctx', 'user']);
  assert.strictEqual(getPath(rec, ['tags', 1]), 'fast');
  assert.strictEqual(getPath(rec, ['tags', 'x']), undefined);
  assert.strictEqual(getPath(rec, ['level', 'x']), undefined);
});

test('comparisons', () => {
  assert.ok(t('level == error'));
  assert.ok(t('level == "error"'));
  assert.ok(!t('level != error'));
  assert.ok(t('score >= 0.5'));
  assert.ok(!t('score > 0.75'));
  assert.ok(t('n < 100'));
  assert.ok(t('ctx.user.id == 7'));
  assert.ok(t('ctx.user.id == "7"'));
  assert.ok(t('tags[0] == smoke'));
  assert.ok(t('["odd key"] == yes'));
  assert.ok(t('nul == null'));
  assert.ok(!t('nul > 1'));
});

test('contains, regex, exists and and', () => {
  assert.ok(t('ctx.route contains orders'));
  assert.ok(t('tags contains fast'));
  assert.ok(t('ctx.route !contains cart'));
  assert.ok(t('ctx.route =~ ^/api/'));
  assert.ok(t('ctx.route =~ /orders$/i'));
  assert.ok(t('nul exists'));
  assert.ok(t('nope missing'));
  assert.ok(!t('nope exists'));
  assert.ok(t('level == error and n > 10 AND tags contains smoke'));
  assert.ok(!t('level == error and n > 20'));
});

test('empty filter is null, bad filters throw FilterError', () => {
  assert.strictEqual(parseFilter('  '), null);
  for (const bad of ['level', 'level ==', 'a exists 3', 'a[x] == 1', 'a =~ (', 'x'.repeat(2001)]) {
    assert.throws(() => parseFilter(bad), FilterError, bad);
  }
});
