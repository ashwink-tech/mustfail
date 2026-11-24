'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shapeOf, mergeShapes, appearsIn, endpointKey, isWrite, graphqlInfo, isAuthUrl, pathLabel } = require('../../lib/shared');

test('shapeOf keeps scalars with their type, reads at most five rows, skips id-like keys', () => {
  const s = shapeOf({ items: Array.from({ length: 8 }, (_, i) => ({ id: i, name: `n${i}`, done: i % 2 === 0, total: i })) });
  assert.deepEqual(s.arrays, [{ path: ['items'], length: 8 }]);
  const names = s.leaves.filter(l => l.path[2] === 'name').map(l => l.value);
  assert.deepEqual(names, ['n0', 'n1', 'n2', 'n3', 'n4']);
  assert.ok(s.leaves.some(l => l.type === 'boolean' && l.path[2] === 'done'));
  assert.ok(!s.leaves.some(l => l.path[2] === 'id'));
});

test('mergeShapes marks values first seen in a later response as late, and keeps the longer list', () => {
  const a = shapeOf({ rows: [{ name: 'Seed row' }] });
  const b = shapeOf({ rows: [{ name: 'Seed row' }, { name: 'made-1795288376303' }] });
  const m = mergeShapes(a, b);
  assert.equal(m.leaves.find(l => l.value === 'Seed row').late, undefined);
  assert.equal(m.leaves.find(l => l.value === 'made-1795288376303').late, true);
  assert.equal(m.arrays.find(x => x.path[0] === 'rows').length, 2);
  assert.equal(mergeShapes(null, b), b);
  assert.equal(mergeShapes(a, null), a);
});

test('appearsIn matches whole words and standalone numbers only', () => {
  assert.ok(appearsIn('Active', 'Status: Active'));
  assert.ok(!appearsIn('read', 'spreadsheet'));
  assert.ok(appearsIn('ctx_123_ab', 'ctx_123_ab\nText\nGlobal'));
  assert.ok(!appearsIn('ctx_123_ab', 'ctx_123_abTextGlobal'), 'run-together cell text hides the value');
  assert.ok(appearsIn(42, 'Total 42 items'));
  assert.ok(!appearsIn(1, '6af5fbb1e8'));
  assert.ok(appearsIn(42.5, 'Total 42.50'));
  assert.ok(!appearsIn('abc', 'abc'), 'strings under four characters never match');
});

test('endpointKey folds ids and timestamps and names GraphQL operations', () => {
  assert.equal(endpointKey('GET', 'http://x.test/api/users/123/posts'), 'GET http://x.test/api/users/:id/posts');
  assert.equal(endpointKey('PUT', 'http://x.test/upload/1795288376303.png'), 'PUT http://x.test/upload/:n.png');
  const body = JSON.stringify({ operationName: 'TaskList', query: 'query TaskList { tasks { id } }' });
  assert.equal(endpointKey('POST', 'http://x.test/', body), 'POST http://x.test/#TaskList');
});

test('isWrite: HTTP methods, GraphQL mutations, and read-named operations', () => {
  assert.equal(isWrite('GET', 'http://x.test/a'), false);
  assert.equal(isWrite('POST', 'http://x.test/a', '{"title":"x"}'), true);
  assert.equal(isWrite('POST', 'http://x.test/', JSON.stringify({ query: 'mutation AddTask { addTask { id } }' })), true);
  assert.equal(isWrite('POST', 'http://x.test/', JSON.stringify({ query: 'query Tasks { tasks { id } }' })), false);
  assert.equal(isWrite('POST', 'http://x.test/', JSON.stringify({ operationName: 'getTasks', extensions: { persistedQuery: {} } })), false);
  assert.equal(graphqlInfo('http://x.test/', 'not json'), null);
});

test('isAuthUrl and pathLabel', () => {
  assert.ok(isAuthUrl('http://x.test/api/login'));
  assert.ok(!isAuthUrl('http://x.test/api/tasks'));
  assert.equal(pathLabel(['data', 'items', '*', 'name']), 'data.items[*].name');
});

test('isPersistingWrite: GraphQL names by whole words', () => {
  const { isPersistingWrite: p } = require('../../lib/shared');
  for (const name of ['OrderUpdate', 'ProductCreate', 'createUser', 'saveDraft', 'UpdateHTTPSettings']) assert.equal(p(`POST http://app.test/graphql#${name}`), true, name);
  // "Asset" holds "set" and "Address" holds "add": neither is a saving verb.
  for (const name of ['AssetPreview', 'AddressLookup', 'ResetFilters', 'TrackSettingsView']) assert.equal(p(`POST http://app.test/graphql#${name}`), false, name);
});

test('isPersistingWrite: REST by method, path words and a 201 in the baseline', () => {
  const { isPersistingWrite: p } = require('../../lib/shared');
  assert.equal(p('PUT http://app.test/admin/homepage/layout'), true);
  assert.equal(p('DELETE http://app.test/api/tasks/:id'), true);
  assert.equal(p('POST http://app.test/admin/roles/batch-delete'), true);
  assert.equal(p('POST http://app.test/api/x/actions/bulkPublish'), true);
  assert.equal(p('POST http://app.test/api/assets/search'), false);
  assert.equal(p('POST http://app.test/uid/generate', 200), false);
  // A plain POST to a collection is a create only when the server said so.
  assert.equal(p('POST http://app.test/api/tasks'), false);
  assert.equal(p('POST http://app.test/api/tasks', 201), true);
  assert.equal(p('GET http://app.test/api/tasks/create'), false);
});

test('endpointKey folds generated ids that are neither numbers nor UUIDs', () => {
  const { endpointKey: k } = require('../../lib/shared');
  assert.equal(k('POST', 'http://app.test/types/api::x.x/afx9rllvwj5apmc19ckfe5eu/actions/publish'), 'POST http://app.test/types/api::x.x/:id/actions/publish');
  assert.equal(k('GET', 'http://app.test/files/01ARZ3NDEKTSV4RRFFQ69G5FAV'), 'GET http://app.test/files/:id');
  // Long words and slugs without digits are path names, not ids.
  assert.equal(k('POST', 'http://app.test/api/bulkFindForValidation'), 'POST http://app.test/api/bulkFindForValidation');
  assert.equal(k('GET', 'http://app.test/blog/my-first-post-about-playwright'), 'GET http://app.test/blog/my-first-post-about-playwright');
});
