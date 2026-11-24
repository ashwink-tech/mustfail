'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compare, compareLines } = require('../../lib/compare');

const r = (key, grade) => ({ key, title: key, file: 'a.spec.ts', line: 1, grade });

test('compares only tests graded both times and sorts changes by direction', () => {
  const prev = { meta: { when: '2026-11-22 10:00 UTC' }, results: [r('a', 'weak'), r('b', 'strong'), r('c', 'unproven'), r('d', 'strong'), r('gone', 'weak')] };
  const cur = { results: [r('a', 'strong'), r('b', 'write-gated'), r('c', 'not measurable'), r('d', 'strong'), r('new', 'weak')] };
  const s = compare(prev, cur);
  assert.deepEqual([s.both, s.unchanged, s.better.length, s.worse.length, s.other.length], [4, 1, 1, 1, 1]);
  assert.equal(cur.results[0].was, 'weak');
  assert.equal(cur.results[3].was, undefined);
  const lines = compareLines(s);
  assert.equal(lines[0], 'Since the last run in this folder (2026-11-22 10:00 UTC), of 4 tests graded both times: 1 stronger, 1 weaker, 1 other, 1 unchanged.');
  assert.ok(lines.some(l => /stronger\s+a\.spec\.ts:1\s+a: weak -> strong/.test(l)));
});

test('no previous report, or no test in common: nothing to say', () => {
  assert.equal(compare(null, { results: [r('a', 'weak')] }), null);
  assert.equal(compare({ results: [r('x', 'weak')] }, { results: [r('a', 'weak')] }), null);
  assert.deepEqual(compareLines(null), []);
});

test('nothing changed is said in one line', () => {
  const s = compare({ results: [r('a', 'weak')] }, { results: [r('a', 'weak')] });
  assert.deepEqual(compareLines(s), ['Since the last run in this folder, of 1 test graded both times: no grade changed.']);
});
