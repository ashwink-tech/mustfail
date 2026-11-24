'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isLost, suspects, retryPlan, mergeRetry } = require('../../lib/lost');

let t = 0;
const run = (key, status, fault, extra = {}) => ({ key, title: key, status, started: ++t, error: status === 'passed' ? '' : 'Error: boom', fault, ...extra });
const lostFault = (op = 'fail-write') => ({ op, endpoint: 'POST http://app.test/save', applied: 0, handlerErrors: 0, bodyStarted: false });
const realFault = (op = 'blackout') => ({ op, applied: 3, handlerErrors: 0, bodyStarted: true });

test('a run that broke in setup before its fault touched anything is lost', () => {
  assert.equal(isLost(run('a', 'failed', lostFault())), true);
});

test('a setup break the fault caused (it touched calls) is not lost', () => {
  assert.equal(isLost(run('a', 'failed', { ...lostFault('blackout'), applied: 4 })), false);
});

test('passing, body-started and expected-fail runs are not lost', () => {
  assert.equal(isLost(run('a', 'passed', lostFault())), false);
  assert.equal(isLost(run('a', 'failed', { ...lostFault(), bodyStarted: true })), false);
  assert.equal(isLost(run('a', 'failed', lostFault(), { expectedFail: true })), false);
  assert.equal(isLost(run('a', 'failed', { op: 'alone', applied: 0, bodyStarted: false })), false);
});

test('suspects are the tests that failed just before a stretch of lost runs', () => {
  const rows = [
    run('fine', 'passed', realFault()),
    run('leaker', 'failed', realFault()),
    run('setup-only', 'failed', { ...realFault(), bodyStarted: false }),
    run('x', 'failed', lostFault()),
    run('y', 'failed', lostFault()),
  ];
  assert.deepEqual(suspects(rows), ['leaker']);
});

test('retry plan runs suspects clean at repeat 0 and lost runs from repeat 1', () => {
  const rows = [run('leaker', 'failed', realFault()), run('x', 'failed', lostFault()), run('x', 'failed', lostFault('empty-list'))];
  const r = retryPlan({ tests: {}, info: {}, setupProjects: [] }, rows);
  assert.equal(r.lost, 2);
  assert.deepEqual(r.plan.tests.leaker.faults, [{ op: 'clean' }]);
  assert.equal(r.plan.tests.x.faults[0], null);
  assert.deepEqual(r.plan.tests.x.faults.slice(1).map(f => [f.op, f.retryOf]), [['fail-write', 1], ['empty-list', 2]]);
  assert.equal(r.plan.tests.x.faults[1].applied, undefined);
  assert.equal(r.plan.maxFaults, 3);
});

test('no lost runs, no retry', () => {
  assert.equal(retryPlan({ tests: {} }, [run('a', 'failed', realFault())]), null);
});

test('a recovered retry replaces its lost run; one lost again stays lost', () => {
  const rows = [run('x', 'failed', lostFault()), run('y', 'failed', lostFault())];
  const retried = [
    run('x', 'failed', { ...lostFault(), applied: 1, bodyStarted: true, retryOf: 0 }),
    run('y', 'failed', { ...lostFault(), retryOf: 1 }),
    run('leaker', 'passed', { op: 'clean', applied: 1, bodyStarted: true }),
  ];
  const m = mergeRetry(rows, retried, ['leaker']);
  assert.equal(m.rows.length, 2);
  assert.equal(isLost(m.rows[0]), false);
  assert.equal(m.rows[0].retried, true);
  assert.equal(isLost(m.rows[1]), true);
  assert.deepEqual([m.info.lost, m.info.recovered, m.info.stillLost], [2, 1, 1]);
});

test('a run whose body start is unknown (body tracking off) is never lost', () => {
  assert.equal(isLost(run('a', 'failed', { ...lostFault(), bodyStarted: undefined })), false);
});
