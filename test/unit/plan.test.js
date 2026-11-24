'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan, linkStrength, _internal: { leafLink, isCreated } } = require('../../lib/plan');
const { endpoint, row, twice } = require('./helpers');

const plan = rows => buildPlan({ rows, setupProjects: [] }, { maxTargeted: 3 });
const faultsOf = (p, r) => p.tests[r.key].faults.filter(Boolean);
const ops = (p, r) => faultsOf(p, r).map(f => f.op);

test('linkStrength: value matchers link, visibility and negated checks are weak, long text is ignored', () => {
  assert.equal(linkStrength('Active', { t: 'Active', m: 'toHaveText' }), 0);
  assert.equal(linkStrength('Active', { t: 'Status: Active', m: 'toContainText' }), 0.2);
  assert.equal(linkStrength('Active', { t: 'Active', m: 'toBeVisible' }), 1.2);
  assert.equal(linkStrength('Active', { t: 'Active', m: 'not.toHaveText' }), 1.2);
  assert.equal(linkStrength('Active', { t: 'x'.repeat(201), m: 'toHaveText' }), null);
  assert.equal(linkStrength('Active', { t: 'Draft', m: 'toHaveText' }), null);
  // A value the test compared in code ranks just below text read off the page.
  assert.equal(linkStrength('Failed', { t: 'Failed', m: 'toBe', k: 'value' }), 0.1);
});

test('a value the test created counts even when only its visibility is checked, unless negated', () => {
  const leaf = { path: ['rows', 1, 'name'], value: 'made-1795288376303', type: 'string', late: true };
  assert.ok(isCreated(leaf));
  assert.equal(leafLink(leaf, { t: 'made-1795288376303', m: 'toBeVisible' }), 0.3);
  assert.equal(leafLink(leaf, { t: 'made-1795288376303', m: 'not.toBeVisible' }), 1.2);
  assert.ok(!isCreated({ ...leaf, late: false }), 'present at page load: not created by the test');
  assert.ok(!isCreated({ ...leaf, value: 'made-row' }), 'no digits: could be anything');
});

test('a text assertion picks a change-value fault on the field it read', () => {
  const r = row({ endpoints: [endpoint('GET', '/api/tasks', { body: { tasks: [{ title: 'Write report', state: 'Open' }] } })],
    asserted: [{ t: 'Write report', m: 'toHaveText' }] });
  const p = plan(twice(r));
  const f = faultsOf(p, r).find(x => x.op === 'change-value');
  assert.deepEqual(f.path, ['tasks', '*', 'title']);
  assert.equal(f.linked, true);
  assert.equal(p.info[r.key].assertionsLinked, true);
  assert.equal(ops(p, r)[0], 'blackout');
});

test('session-wide data is discounted, but a digit-bearing value only one test sees is not', () => {
  const menu = (own) => endpoint('GET', '/api/menu', { body: { items: [{ label: 'Dashboard' }, { label: own }] } });
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push(...twice(row({ title: `t${i}`, endpoints: [menu(`order-17952883763${i}`)],
      asserted: [{ t: 'Dashboard', m: 'toHaveText' }, { t: `order-17952883763${i}`, m: 'toContainText' }] })));
  }
  const p = plan(rows);
  const f = p.tests[rows[0].key].faults.filter(Boolean).find(x => x.op === 'change-value');
  assert.ok(f, 'the own value still gets a fault');
  assert.equal(f.linked, true, 'a value unique to this test is not session-wide');
  const only = [];
  for (let i = 0; i < 5; i++) only.push(...twice(row({ title: `m${i}`, endpoints: [menu('Reports')], asserted: [{ t: 'Dashboard', m: 'toHaveText' }] })));
  assert.equal(plan(only).info[only[0].key].assertionsLinked, false, 'menu text every test sees does not count');
});

test('a row the test created keeps a fault even when generic exact matches outrank it', () => {
  const name = 'attr-1795288376303-x';
  const r = row({
    endpoints: [
      endpoint('GET', '/api/types', { body: { types: [{ label: 'Text' }, { label: 'Number' }] } }),
      endpoint('GET', '/api/menu', { body: { entries: [{ label: 'Text' }] } }),
      endpoint('GET', '/api/settings', { body: { formats: [{ label: 'Text' }] } }),
      endpoint('GET', '/api/attributes', { body: { content: [{ name, type: 'Text' }] }, late: [name] }),
    ],
    asserted: [{ t: 'Text', m: 'toHaveText' }, { t: `${name}\nText\nGlobal`, m: 'toBeVisible' }],
  });
  const p = plan(twice(r));
  assert.ok(faultsOf(p, r).some(f => f.op === 'change-value' && f.endpoint.endsWith('/api/attributes') && f.path.at(-1) === 'name'));
});

test('two baseline runs that created different rows: each run\'s text still links to its own row', () => {
  const run = (name, n) => row({ repeat: n, title: 'creates', asserted: [{ t: name, m: 'toBeVisible' }],
    endpoints: [endpoint('GET', '/api/attributes', { body: { content: [{ name: 'Seed attribute' }, { name }] }, late: [name] })] });
  const r1 = run('ctx_1795288376303_a1', 0);
  // Run 1's row text came back run together, so only run 2's text can link, to run 2's row.
  r1.traffic.asserted = [{ t: 'ctx_1795288376303_a1TextGlobal', m: 'toBeVisible' }];
  const r2 = run('chat_1795288384593_b2', 1);
  const p = plan([r1, r2]);
  assert.ok(faultsOf(p, r1).some(f => f.op === 'change-value' && f.linked === true && f.path.at(-1) === 'name'), 'run 2 text links to run 2 data');
  assert.equal(p.info[r1.key].assertionsLinked, true);
});

test('flip-booleans: an extra fault for checkbox tests on a list they read, never for others', () => {
  const list = endpoint('GET', '/api/tasks', { body: { tasks: [{ title: 'Review PR', done: true }, { title: 'Plan sprint', done: false }] } });
  const config = endpoint('GET', '/api/config', { body: { flags: [{ key: 'beta', on: true }, { key: 'dark', on: false }] } });
  const checkbox = row({ title: 'checkbox', endpoints: [list, config], asserted: [{ t: 'Review PR\tlow\tDone', m: 'toBeChecked' }],
    expects: [{ matcher: 'toBeChecked', ms: 5, failed: false }] });
  const text = row({ title: 'text', endpoints: [list, config], asserted: [{ t: 'Review PR', m: 'toHaveText' }] });
  const noSignal = row({ title: 'no signal', endpoints: [config], asserted: [{ t: 'nothing here', m: 'toBeChecked' }],
    expects: [{ matcher: 'toBeChecked', ms: 5, failed: false }] });
  const p = plan([...twice(checkbox), ...twice(text), ...twice(noSignal)]);
  const flip = faultsOf(p, checkbox).find(f => f.op === 'flip-booleans');
  assert.ok(flip && flip.endpoint.endsWith('/api/tasks'), 'flips the list the checked text comes from');
  assert.deepEqual(flip.path, ['tasks']);
  assert.ok(!ops(p, text).includes('flip-booleans'));
  assert.ok(!ops(p, noSignal).includes('flip-booleans'), 'a config list with no sign of use is not flipped');
  // Its own slot: the other targeted faults are what they would be without it.
  const withoutBool = plan(twice({ ...checkbox, expects: [{ matcher: 'toHaveText', ms: 5, failed: false }] }));
  assert.deepEqual(faultsOf(p, checkbox).filter(f => f.op !== 'flip-booleans'), faultsOf(withoutBool, checkbox));
});

test('exclusions: unstable, skipped, test.fail, no browser traffic', () => {
  const api = [endpoint('GET', '/api/tasks', { body: { tasks: [{ title: 'A task' }] } })];
  const unstable = row({ title: 'unstable', endpoints: api });
  const skipped = row({ title: 'skipped', status: 'skipped', endpoints: api });
  const known = row({ title: 'known bug', status: 'failed', expectedFail: true, endpoints: api });
  const none = row({ title: 'no traffic', endpoints: [] });
  const p = plan([unstable, { ...unstable, status: 'failed', repeat: 1 }, ...twice(skipped), ...twice(known), ...twice(none)]);
  assert.match(p.excluded[unstable.key], /^Unstable/);
  assert.match(p.excluded[skipped.key], /skipped itself/);
  assert.match(p.excluded[known.key], /test\.fail/);
  assert.match(p.excluded[none.key], /No API calls/);
});

test('request checks are recorded and never linked to responses', () => {
  const save = endpoint('POST', '/api/tasks', { write: true });
  const list = endpoint('GET', '/api/tasks', { body: { tasks: [{ title: 'POST http://app.test/api/tasks' }] } });
  const r = row({ endpoints: [save, list], asserted: [{ t: save.key, m: 'toContain', k: 'request' }] });
  const p = plan(twice(r));
  assert.deepEqual(p.info[r.key].requestChecks, [save.key]);
  assert.equal(p.info[r.key].assertionsLinked, false);
});

test('a write sent in the body is planned even if its response came after the body ended', () => {
  const del = { ...endpoint('POST', '/admin/roles/batch-delete', { write: true }), count: 0, sentOnly: true, inBody: 1 };
  const setup = endpoint('POST', '/admin/users/batch-delete', { write: true, inBody: 0 });
  const list = endpoint('GET', '/admin/roles', { body: { data: [{ name: 'Author' }, { name: 'Editor' }] } });
  const r = row({ endpoints: [del, setup, list], asserted: [{ t: 'Author', m: 'not.toBeVisible' }] });
  const p = plan(twice(r));
  const writes = faultsOf(p, r).filter(f => f.op === 'fail-write').map(f => f.endpoint);
  assert.ok(writes.includes(del.key), 'the test\'s own delete');
  assert.ok(!writes.includes(setup.key), 'a write made only in setup is not the test\'s');
});

test('REST writes that persist rank before helper writes', () => {
  const { _internal: { candidatesFor } } = require('../../lib/plan');
  const del = endpoint('POST', '/admin/roles/batch-delete', { write: true });
  const check = endpoint('POST', '/admin/permissions/check', { write: true });
  const put = endpoint('PUT', '/admin/roles/7', { write: true });
  const { candidates } = candidatesFor([del, check, put], [], new Map(), 1);
  const score = k => candidates.find(c => c.fault.endpoint === k.key).score;
  assert.equal(score(del), 0.5);
  assert.equal(score(put), 0.5);
  assert.equal(score(check), 0.7);
});

test('a plain POST the server answered with 201 is stamped as a save; a 200 helper call is not', () => {
  const create = { ...endpoint('POST', '/api/tasks', { write: true }), status: 201 };
  const slug = endpoint('POST', '/api/uid/generate', { write: true });
  const list = endpoint('GET', '/api/tasks', { body: { tasks: [{ title: 'A task' }] } });
  const r = row({ endpoints: [create, slug, list] });
  const writes = faultsOf(plan(twice(r)), r).filter(f => f.op === 'fail-write');
  assert.equal(writes.find(f => f.endpoint === create.key).persisting, true);
  assert.equal(writes.find(f => f.endpoint === slug.key)?.persisting, undefined);
});

test('a test that fails in the baseline is excluded with its error', () => {
  const api = [endpoint('GET', '/api/tasks', { body: { tasks: [{ title: 'A task' }] } })];
  const broken = row({ title: 'broken', status: 'failed', error: 'Error: connect ECONNREFUSED 127.0.0.1:4124', endpoints: api });
  const p = plan(twice(broken));
  assert.equal(p.excluded[broken.key], 'Fails without any fault (Error: connect ECONNREFUSED 127.0.0.1:4124), so its result says nothing about faults.');
});

test('faults on a call most tests in the run read are stamped session-wide', () => {
  const init = () => endpoint('GET', '/init', { body: { types: [{ name: 'Article' }, { name: 'Author' }] } });
  const own = endpoint('GET', '/api/tasks', { body: { tasks: [{ title: 'Only mine 1' }, { title: 'Only mine 2' }] } });
  const rows = [1, 2, 3, 4].map(i => row({ title: `t${i}`, endpoints: i === 1 ? [init(), own] : [init()] }));
  const p = plan(rows.flatMap(twice));
  const faults = faultsOf(p, rows[0]);
  const on = path => faults.filter(f => (f.endpoint || '').endsWith(path));
  assert.ok(on('/init').length > 0 && on('/init').every(f => f.sessionWide === true));
  assert.ok(on('/api/tasks').length > 0 && on('/api/tasks').every(f => f.sessionWide === undefined));
});
