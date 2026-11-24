'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sentMatch, _internal: { setPath, changeInRows, changeRowTexts, flipRowBooleans, sentBodies } } = require('../../lib/fixture');

test('setPath walks * across every row', () => {
  const json = { data: { items: [{ name: 'a' }, { name: 'b' }] } };
  assert.equal(setPath(json, ['data', 'items', '*', 'name'], v => v.toUpperCase()), 2);
  assert.deepEqual(json.data.items.map(i => i.name), ['A', 'B']);
  assert.equal(setPath(json, ['data', 'missing', '*'], v => v), 0);
});

test('changeInRows changes the value everywhere in its row (value and displayValue copies)', () => {
  const json = { rows: [{ status: 'Open', label: { displayValue: 'Open' }, other: 'Keep' }] };
  changeInRows(json, ['rows', '*', 'status']);
  const r = json.rows[0];
  assert.notEqual(r.status, 'Open');
  assert.equal(r.label.displayValue, r.status);
  assert.equal(r.other, 'Keep');
});

test('changeRowTexts rewrites texts but leaves ids, urls and dates alone', () => {
  const row = { id: 'abc', title: 'Write report', url: 'http://x', createdDate: '2026-11-22', due: '2026-11-22', note: 'ok' };
  changeRowTexts(row);
  assert.equal(row.id, 'abc');
  assert.equal(row.url, 'http://x');
  assert.equal(row.createdDate, '2026-11-22');
  assert.equal(row.due, '2026-11-22', 'date-like values stay');
  assert.notEqual(row.title, 'Write report');
  assert.notEqual(row.note, 'ok');
});

test('flipRowBooleans flips state but not the fields that decide whether a row is shown', () => {
  const row = { done: true, settings: { enabled: false }, deleted: false, isHidden: false };
  assert.equal(flipRowBooleans(row), 2);
  assert.deepEqual(row, { done: false, settings: { enabled: true }, deleted: false, isHidden: false });
});

test('sentMatch: a whole request body, an object from it, or a long string inside it', () => {
  const ti = {};
  const body = JSON.stringify({ operationName: 'Save', variables: { input: { title: 'req-1795288376303' } } });
  sentBodies.set(ti, [{ key: 'POST http://app.test/#Save', body, json: JSON.parse(body) }]);
  assert.deepEqual(sentMatch(ti, body), { key: 'POST http://app.test/#Save', whole: true });
  assert.equal(sentMatch(ti, JSON.parse(body).variables).whole, true);
  assert.deepEqual(sentMatch(ti, 'req-1795288376303'), { key: 'POST http://app.test/#Save', whole: false });
  assert.equal(sentMatch(ti, 'Save'), null, 'short strings are not matched');
  assert.equal(sentMatch(ti, 'something else entirely'), null);
  assert.equal(sentMatch({}, body), null, 'another test saw no requests');
});
