'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { grade, enclosingName, CHECK_HELPER } = require('../../lib/grade');
const { faultRow } = require('./helpers');

const LIST = 'GET http://app.test/api/tasks';
const SAVE = 'POST http://app.test/api/tasks';
const KEY = 'chromium › a.spec.ts › t';
const info = (extra = {}) => ({ [KEY]: { title: 't', file: 'a.spec.ts', line: 1, project: 'chromium', expects: ['toHaveText'],
  visibilityOnly: false, sleeps: 0, assertionsLinked: true, ...extra } });
const run = (rows, extra, rootDir = '') => grade({ info: info(extra), excluded: {}, tests: {} }, { rootDir, rows }).results[0];
const blackout = (o = {}) => faultRow(KEY, { op: 'blackout' }, { applied: 5, error: 'Error: expect(locator).toHaveText() failed', errorKind: 'assertion', ...o });
const value = { op: 'change-value', endpoint: LIST, path: ['tasks', '*', 'title'], linked: true };
const write = { op: 'fail-write', endpoint: SAVE };
const ASSERT = 'Error: expect(locator).toHaveText(expected) failed';
const CLICK = 'TimeoutError: locator.click: Timeout 5000ms exceeded.';
const WAIT = 'TimeoutError: locator.waitFor: Timeout 5000ms exceeded.';

test('strong: an assertion failed when a value it checks was changed', () => {
  const r = run([blackout(), faultRow(KEY, value, { error: ASSERT, errorKind: 'assertion' })]);
  assert.equal(r.grade, 'strong');
  assert.equal(r.reason, 'Failed when `tasks[*].title` changed in GET /api/tasks.');
});

test('decorative: green with every call failing', () => {
  assert.equal(run([blackout({ status: 'passed', error: '' })]).grade, 'decorative');
});

test('not measurable when the blackout run made no API call', () => {
  const r = run([blackout({ applied: 0 })]);
  assert.equal(r.grade, 'not measurable');
  assert.match(r.reason, /No API call/);
});

test('write-gated: stops only on a wait after its own write fails', () => {
  const r = run([blackout(), faultRow(KEY, write, { error: WAIT, errorKind: 'action' }), faultRow(KEY, value, { status: 'passed' })]);
  assert.equal(r.grade, 'write-gated');
  assert.match(r.reason, /nothing showed that wrong or missing data would be caught/);
  assert.match(r.reason, /stayed green when `tasks\[\*\]\.title` changed/);
});

test('write-gated with a stop on a click that finds the row by the changed value says so', () => {
  const r = run([blackout(), faultRow(KEY, write, { error: WAIT, errorKind: 'action' }), faultRow(KEY, value, { error: CLICK, errorKind: 'action' })]);
  assert.equal(r.grade, 'write-gated');
  assert.equal(r.stopsOnValue, true);
  assert.match(r.reason, /on a click or wait that finds the row by that value/);
});

test('a run whose fault handler threw counts for neither side', () => {
  // Passing under a half-applied fault is not "stayed green" ...
  const passed = run([blackout(), faultRow(KEY, value, { status: 'passed', handlerErrors: 1 })]);
  assert.doesNotMatch(passed.reason, /stayed green when `tasks/);
  assert.ok(passed.notes.some(n => /did not reach every response/.test(n)));
  // ... and failing under one is not proof.
  const failed = run([blackout(), faultRow(KEY, value, { error: ASSERT, errorKind: 'assertion', handlerErrors: 1 })]);
  assert.notEqual(failed.grade, 'strong');
});

test('a failure inside a setup helper is strong via a helper; inside a check helper it is plain strong', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
  fs.mkdirSync(path.join(root, 'pages'));
  fs.writeFileSync(path.join(root, 'pages', 'p.ts'), [
    'export class P {',
    '  async createTask(name: string) {',
    '    await expect(this.row(name)).toBeVisible();',
    '  }',
    '  async expectTaskTitle(name: string) { await expect(this.row(name)).toHaveText(name); }',
    '}'].join('\n'));
  const at = line => [{ kind: 'expect', matcher: 'toBeVisible', failed: true, at: `pages/p.ts:${line}`, inSpec: false }];
  const viaSetup = run([blackout(), faultRow(KEY, value, { error: ASSERT, errorKind: 'assertion', expects: at(3) })], {}, root);
  assert.equal(viaSetup.grade, 'strong');
  assert.equal(viaSetup.via, 'helper');
  assert.match(viaSetup.reason, /createTask, pages\/p\.ts:3/);
  const viaCheck = run([blackout(), faultRow(KEY, value, { error: ASSERT, errorKind: 'assertion', expects: at(5) })], {}, root);
  assert.equal(viaCheck.grade, 'strong');
  assert.equal(viaCheck.via, undefined);
  // Source that cannot be read: no guess.
  const unknown = run([blackout(), faultRow(KEY, value, { error: ASSERT, errorKind: 'assertion', expects: at(3) })], {}, '/nonexistent');
  assert.equal(unknown.via, undefined);
});

test('enclosingName and CHECK_HELPER', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
  fs.writeFileSync(path.join(root, 'h.ts'), [
    'export const waitForTile = async (name: string) => {',
    '  await expect(tile).toBeVisible();',
    '};',
    'export async function seedThings(a, b) {',
    '  if (a) {',
    '    await expect(x).toBeVisible();',
    '  }',
    '}'].join('\n'));
  assert.equal(enclosingName('h.ts:2', root), 'waitForTile');
  assert.equal(enclosingName('h.ts:6', root), 'seedThings');
  for (const n of ['expectRow', 'verifyTotal', 'cartExpectItemsAbsent', 'assertSaved']) assert.ok(CHECK_HELPER.test(n), n);
  for (const n of ['createMetric', 'waitForTile', 'deleteFromOpenDrawer']) assert.ok(!CHECK_HELPER.test(n), n);
});

test('flipped booleans prove a checkbox check, not a row that vanished', () => {
  const flip = { op: 'flip-booleans', endpoint: LIST, path: ['tasks'] };
  const checked = run([blackout(), faultRow(KEY, flip, { error: 'Error: expect(locator).toBeChecked() failed', errorKind: 'assertion' })],
    { expects: ['toBeChecked'] });
  assert.equal(checked.grade, 'strong');
  assert.match(checked.reason, /true\/false fields in every `tasks` row flipped/);
  const gone = run([blackout(), faultRow(KEY, flip, { error: 'Error: expect(locator).toBeVisible() failed', errorKind: 'assertion' })],
    { expects: ['toBeChecked'] });
  assert.notEqual(gone.grade, 'strong');
});

test('request checks: their own grade when nothing else is checked, a note otherwise', () => {
  const only = run([blackout({ status: 'passed', error: '' })], { requestChecks: [SAVE] });
  assert.equal(only.grade, 'request check');
  assert.match(only.reason, /Asserts the request it sent \(POST \/api\/tasks\)/);
  const gated = run([blackout(), faultRow(KEY, write, { error: WAIT, errorKind: 'action' })], { requestChecks: [SAVE] });
  assert.equal(gated.grade, 'write-gated');
  assert.match(gated.reason, /also asserts the request it sent/);
  assert.deepEqual(gated.checksRequest, ['POST /api/tasks']);
});

test('counts carry the helper and request extras', () => {
  const g = grade({ info: info({ requestChecks: [SAVE] }), excluded: {}, tests: {} },
    { rootDir: '', rows: [blackout(), faultRow(KEY, write, { error: WAIT, errorKind: 'action' })] });
  assert.deepEqual(g.counts, { 'write-gated': 1, 'checks its request': 1 });
});

test('weak: stayed green when its own persisting write failed, even if the page needs other data', () => {
  const del = { op: 'fail-write', endpoint: 'POST http://app.test/admin/roles/batch-delete' };
  const empty = { op: 'empty-list', endpoint: LIST, path: ['tasks'] };
  const r = run([blackout(), faultRow(KEY, del, { status: 'passed' }), faultRow(KEY, empty, { error: CLICK, errorKind: 'action' })]);
  assert.equal(r.grade, 'weak');
  assert.match(r.reason, /^Stayed green when its own write failed \(POST \/admin\/roles\/batch-delete returned 500\)/);
  assert.match(r.reason, /does fail when `tasks` emptied/);
  // A helper write (a permission check by POST) surviving is not that evidence.
  const check = { op: 'fail-write', endpoint: 'POST http://app.test/admin/permissions/check' };
  assert.notEqual(run([blackout(), faultRow(KEY, check, { status: 'passed' }), faultRow(KEY, empty, { error: CLICK, errorKind: 'action' })]).grade, 'weak');
  // Strong and write-gated still win.
  assert.equal(run([blackout(), faultRow(KEY, del, { status: 'passed' }), faultRow(KEY, value, { error: ASSERT, errorKind: 'assertion' })]).grade, 'strong');
});

test('not measurable when its own write run broke in setup before the fault touched anything', () => {
  const lost = { error: 'Error: API login failed: HTTP 429', errorKind: 'action', applied: 0, bodyStarted: false };
  const r = run([blackout(), faultRow(KEY, write, lost), faultRow(KEY, value, { status: 'passed' })]);
  assert.equal(r.grade, 'not measurable');
  assert.match(r.reason, /broke in setup before the fault touched anything \(Error: API login failed: HTTP 429\)/);
});

test('one lost run among several is a note, not the grade', () => {
  const lost = { error: 'Error: boom', errorKind: 'action', applied: 0, bodyStarted: false };
  const other = { op: 'change-value', endpoint: LIST, path: ['tasks', '*', 'done'], linked: false };
  const r = run([blackout(), faultRow(KEY, value, { error: ASSERT, errorKind: 'assertion' }), faultRow(KEY, write, { error: ASSERT, errorKind: 'assertion' }), faultRow(KEY, other, lost)]);
  assert.equal(r.grade, 'strong');
  assert.ok(r.notes.some(n => /One fault run broke in setup/.test(n)));
});

test('weak on a plain POST only when the planner stamped it as a save', () => {
  const list = { op: 'empty-list', endpoint: LIST, path: ['tasks'] };
  const rows = stamp => [blackout(), faultRow(KEY, { ...write, ...stamp }, { status: 'passed' }), faultRow(KEY, list, { status: 'passed' })];
  assert.equal(run(rows({ persisting: true }), { assertionsLinked: false }).grade, 'weak');
  assert.match(run(rows({ persisting: true }), { assertionsLinked: false }).reason, /^Stayed green when its own write failed \(POST \/api\/tasks returned 500\)/);
  // No stamp and no saving verb in the path: a POST that may be a search stays out of the weak rule.
  assert.equal(run(rows({}), { assertionsLinked: false }).grade, 'no data check');
});

test('unproven on data most tests in the run read says it is probably app configuration', () => {
  const init = { op: 'empty-list', endpoint: 'GET http://app.test/init', path: ['contentTypes'], sessionWide: true };
  const own = { op: 'empty-list', endpoint: LIST, path: ['tasks'] };
  const r = run([blackout(), faultRow(KEY, init, { error: ASSERT, errorKind: 'assertion' }), faultRow(KEY, own, { status: 'passed' })], { assertionsLinked: false });
  assert.equal(r.grade, 'unproven');
  assert.match(r.reason, /Most tests in this run read that call, so it is probably the app's own configuration/);
  const plain = run([blackout(), faultRow(KEY, { ...init, sessionWide: undefined }, { error: ASSERT, errorKind: 'assertion' })], { assertionsLinked: false });
  assert.doesNotMatch(plain.reason, /Most tests in this run/);
});
