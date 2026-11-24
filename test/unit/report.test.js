'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { summaryLine, lostWarning, writeHtml } = require('../../lib/report');

test('summary line lists grades worst first, with helper and request counts', () => {
  const line = summaryLine({ strong: 3, 'strong via a helper': 1, weak: 1, 'checks its request': 2 }, 4);
  assert.equal(line, '1 weak · 3 strong (1 via a helper) · 2 more also check the request they send  (of 4 tests)');
});

test('lost-run warning: singular, all recovered, backticks in the error', () => {
  const w = lostWarning({ lost: 1, tests: 1, error: 'Error: `x` failed', errorCount: 1, recovered: 1, stillLost: 0, suspects: ['a.spec.ts:3 leaks'] });
  assert.match(w, /^Warning: 1 fault run in 1 test broke in setup before its fault touched anything, with `Error: 'x' failed`\./);
  assert.match(w, /the test that failed just before them again with no fault \(a\.spec\.ts:3 leaks\)/);
  assert.match(w, /Every retry got past setup/);
  assert.equal(lostWarning(null), '');
});

test('HTML report escapes titles and reasons', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mf-rep-')), 'r.html');
  writeHtml(file, { counts: { weak: 1 }, results: [{ grade: 'weak', title: '<img src=x onerror=alert(1)>', file: 'a.spec.ts', line: 1, reason: 'uses <script>', notes: ['<b>'] }] }, { seconds: 1 });
  const html = fs.readFileSync(file, 'utf8');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('uses <script>'));
  assert.ok(html.includes('uses &lt;script&gt;'));
  assert.ok(!html.includes('<b></div>'), 'notes are escaped');
  assert.ok(html.includes('&lt;img src=x'));
});
