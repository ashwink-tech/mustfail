'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { wrapExpect } = require('../../lib/expect-wrap');

// A stand-in for Playwright's expect: sync matchers on values, async ones on "locators".
function fakeExpect(actual) {
  const m = {
    toBe: x => { if (actual !== x) throw new Error('toBe'); },
    toContain: x => { if (!String(actual).includes(x)) throw new Error('toContain'); },
    toEqual: x => { if (JSON.stringify(actual) !== JSON.stringify(x)) throw new Error('toEqual'); },
    toBeTruthy: () => { if (!actual) throw new Error('toBeTruthy'); },
    toBeChecked: async () => {},
    toHaveText: async () => {},
  };
  m.not = { toContain: x => { if (String(actual).includes(x)) throw new Error('not.toContain'); } };
  return m;
}
const record = () => { const seen = []; return { seen, onPass: (texts, m, k) => seen.push({ texts, m, k }) }; };

// Minimal elements for the in-page capture function.
function el({ text = '', attrs = {}, children = [], value, closest = null } = {}) {
  const e = { innerText: text, textContent: text, children, getAttribute: k => (k in attrs ? attrs[k] : null), closest: () => closest };
  if (value !== undefined) e.value = value;
  e.querySelectorAll = () => { const out = []; const walk = n => { for (const c of n.children) { out.push(c); walk(c); } }; walk(e); return out; };
  return e;
}
const locator = els => ({ evaluateAll: async fn => fn(els), page: () => ({}) });

test('plain comparisons record the value; truthiness checks record nothing', () => {
  const { seen, onPass } = record();
  const expect = wrapExpect(fakeExpect, onPass);
  expect('Failed').toBe('Failed');
  expect('yes').toBeTruthy();
  assert.deepEqual(seen, [{ texts: ['Failed'], m: 'toBe', k: 'value' }]);
});

test('an assertion on a request the page sent is recorded as a request check', () => {
  const { seen, onPass } = record();
  const body = '{"title":"req-1795288376303"}';
  const sent = a => (a === body ? { key: 'POST http://app.test/api/tasks', whole: true }
    : a === 'req-1795288376303' ? { key: 'POST http://app.test/api/tasks', whole: false } : null);
  const expect = wrapExpect(fakeExpect, onPass, sent);
  expect(body).toContain('req-');
  expect(body).not.toContain('_isAMomentObject');
  expect('req-1795288376303').toBe('req-1795288376303');
  assert.deepEqual(seen, [
    { texts: ['POST http://app.test/api/tasks'], m: 'toContain', k: 'request' },
    { texts: ['POST http://app.test/api/tasks'], m: 'not.toContain', k: 'request' },
    // A string found inside a body is also kept as a value: it may come from a response too.
    { texts: ['POST http://app.test/api/tasks'], m: 'toBe', k: 'request' },
    { texts: ['req-1795288376303'], m: 'toBe', k: 'value' },
  ]);
});

test('a checkbox assertion records its row\'s text; run-together cells also get a separated copy', async () => {
  const { seen, onPass } = record();
  const expect = wrapExpect(fakeExpect, onPass);
  const cells = [el({ text: 'Review PR' }), el({ text: 'low' }), el({ text: 'Done' })];
  const rowEl = el({ text: 'Review PRlowDone', children: cells });
  const box = el({ attrs: { type: 'checkbox' }, value: 'on', closest: rowEl });
  // isLocator needs evaluateAll and page().
  await expect(locator([box])).toBeChecked();
  assert.deepEqual(seen[0], { texts: ['Review PRlowDone', 'Review PR\nlow\nDone'], m: 'toBeChecked', k: undefined });
  await expect(locator([el({ value: 'typed' })])).toHaveText();
  assert.deepEqual(seen[1].texts, ['typed'], 'an input reports its value');
});
