'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { confirmPlan, mergeConfirm, outcome } = require('../../lib/confirm');
const { grade } = require('../../lib/grade');
const { faultRow } = require('./helpers');

const KEY = 'chromium › a.spec.ts › t';
const DELETE = { op: 'fail-write', endpoint: 'POST http://app.test/graphql#ItemDelete' };
const ASSERT = { error: 'Error: expect(locator).toBeHidden() failed', errorKind: 'assertion' };
const WAIT = { error: 'TimeoutError: locator.waitFor: Timeout 10000ms exceeded.', errorKind: 'action' };
const blackout = faultRow(KEY, { op: 'blackout' }, { applied: 5, ...WAIT });
const plan = { info: { [KEY]: { title: 't', file: 'a.spec.ts', line: 1, project: 'chromium', expects: ['toBeHidden'], assertionsLinked: false } }, excluded: {}, tests: {} };
const gradeOf = rows => grade(plan, { rows });

test('the deciding run of a strong or write-gated test is planned for one repeat', () => {
  const rows = [blackout, faultRow(KEY, DELETE, ASSERT)];
  const g = gradeOf(rows);
  assert.equal(g.results[0].grade, 'strong');
  const c = confirmPlan(plan, rows, g);
  assert.equal(c.count, 1);
  const [f] = c.plan.tests[KEY].faults;
  assert.deepEqual([f.op, f.endpoint, f.confirmOf, f.applied], ['fail-write', DELETE.endpoint, 1, undefined]);
  assert.equal(c.plan.maxFaults, 1);
});

test('nothing to confirm when no grade rests on a single run', () => {
  const rows = [faultRow(KEY, { op: 'blackout' }, { status: 'passed', applied: 5 })];
  assert.equal(confirmPlan(plan, rows, gradeOf(rows)), null);
});

test('same outcome twice confirms the run', () => {
  const rows = [blackout, faultRow(KEY, DELETE, ASSERT)];
  const m = mergeConfirm(rows, [faultRow(KEY, { ...DELETE, confirmOf: 1 }, ASSERT)]);
  assert.deepEqual([m.same, m.differed, m.rows[1].confirmed], [1, 0, true]);
  assert.equal(gradeOf(m.rows).results[0].grade, 'strong');
});

test('an assertion once and a timed-out wait once: the weaker result counts, with a note', () => {
  // A race: strong in one run, write-gated in another, on the same failed delete.
  for (const [first, second] of [[ASSERT, WAIT], [WAIT, ASSERT]]) {
    const rows = [blackout, faultRow(KEY, DELETE, first)];
    const m = mergeConfirm(rows, [faultRow(KEY, { ...DELETE, confirmOf: 1 }, second)]);
    assert.equal(m.differed, 1);
    assert.equal(outcome(m.rows[1]), 1);
    const r = gradeOf(m.rows).results[0];
    assert.equal(r.grade, 'write-gated');
    assert.ok(r.notes.some(n => /was repeated and came out differently \(once (an assertion failed|a wait or click timed out), once/.test(n)), r.notes.join('|'));
  }
});

test('a repeat that passed makes the proof disappear', () => {
  const rows = [blackout, faultRow(KEY, DELETE, ASSERT)];
  const m = mergeConfirm(rows, [faultRow(KEY, { ...DELETE, confirmOf: 1 }, { status: 'passed' })]);
  const r = gradeOf(m.rows).results[0];
  assert.notEqual(r.grade, 'strong');
  assert.notEqual(r.grade, 'write-gated');
});

test('a repeat that broke in setup or never applied the fault says nothing', () => {
  const rows = [blackout, faultRow(KEY, DELETE, ASSERT)];
  for (const bad of [{ ...WAIT, bodyStarted: false, applied: 0 }, { status: 'passed', applied: 0 }, { ...WAIT, handlerErrors: 1 }, { status: 'skipped' }]) {
    const m = mergeConfirm(rows, [faultRow(KEY, { ...DELETE, confirmOf: 1 }, bad)]);
    assert.deepEqual([m.same, m.differed], [0, 0]);
    assert.equal(m.rows[1], rows[1]);
  }
});

test('members of a serial group are repeated in separate runs', () => {
  const K2 = 'chromium › a.spec.ts › u';
  const serial = { info: { [KEY]: { ...plan.info[KEY], serialGroup: 'g' }, [K2]: { ...plan.info[KEY], title: 'u', serialGroup: 'g' } }, excluded: {}, tests: {} };
  const rows = [blackout, faultRow(KEY, DELETE, ASSERT), faultRow(K2, { op: 'blackout' }, { applied: 5, ...WAIT }), faultRow(K2, DELETE, ASSERT)];
  const c = confirmPlan(serial, rows, grade(serial, { rows }));
  assert.equal(c.count, 2);
  assert.deepEqual(c.plan.tests[KEY].faults.map(f => f && f.confirmOf), [1]);
  assert.deepEqual(c.plan.tests[K2].faults.map(f => f && f.confirmOf), [null, 3]);
  assert.equal(c.plan.maxFaults, 2);
});
