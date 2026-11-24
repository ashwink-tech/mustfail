'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const BIN = path.join(__dirname, '..', '..', 'bin', 'mustfail.js');
const cli = (args, cwd = os.tmpdir()) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

test('--help, -h and no command print the help', () => {
  for (const a of [['--help'], ['-h'], [], ['help']]) {
    const r = cli(a); assert.equal(r.status, 0); assert.match(r.stdout, /Usage:/);
  }
});

test('--version prints the package version', () => {
  const r = cli(['--version']);
  assert.equal(r.stdout.trim(), require('../../package.json').version);
});

test('bad arguments stop with exit code 2 and say why', () => {
  const cases = [
    [['frobnicate'], /Unknown command: frobnicate/],
    [['run', '--bogus'], /Unknown option: --bogus/],
    [['run', '--out'], /--out needs a value/],
    [['run', '--max-targeted', 'x'], /--max-targeted needs a number/],
    [['run', '--fail-on', 'weak,nope'], /unknown grade nope/],
  ];
  for (const [args, msg] of cases) { const r = cli(args); assert.equal(r.status, 2, args.join(' ')); assert.match(r.stderr, msg); }
});

test('a folder with no Playwright config, or no @playwright/test, says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-cli-'));
  let r = cli(['run', '--yes'], dir);
  assert.equal(r.status, 2); assert.match(r.stderr, /No playwright.config found/);
  fs.writeFileSync(path.join(dir, 'playwright.config.js'), 'module.exports = {}');
  r = cli(['run', '--yes'], dir);
  assert.equal(r.status, 2); assert.match(r.stderr, /Could not find @playwright\/test/);
});

test('Playwright flags that would break the runs are refused', () => {
  for (const f of ['--retries=2', '--repeat-each', '--reporter=dot', '-x', '--max-failures=1', '--ui']) {
    const r = cli(['run', '--', f]);
    assert.equal(r.status, 2, f); assert.match(r.stderr, /cannot be passed to Playwright through mustfail/);
  }
});

test('snapshot updates and --last-failed are refused too', () => {
  for (const f of ['-u', '--update-snapshots', '--last-failed', '--global-timeout=1000']) {
    const r = cli(['run', '--', f]);
    assert.equal(r.status, 2, f); assert.match(r.stderr, /cannot be passed to Playwright through mustfail/);
  }
});
