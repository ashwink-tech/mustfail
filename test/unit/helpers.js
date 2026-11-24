'use strict';
// Builders for the data mustfail passes between phases, so tests state only what matters to them.
const { shapeOf, testKey } = require('../../lib/shared');

const API = 'http://app.test';
let seq = 0;

// One endpoint as the baseline recorder writes it. `body` is a JSON response (or a list of them, in
// arrival order, so later rows can be marked late the way the recorder does).
function endpoint(method, path, { body, write = false, op, inBody = 1, real = 1, mocked = false, late = [] } = {}) {
  const url = API + path;
  const key = op ? `${method} ${url}#${op}` : `${method} ${url}`;
  let shape = null;
  if (body !== undefined) {
    shape = shapeOf(body);
    for (const l of shape.leaves) if (late.some(v => v === l.value)) l.late = true;
  }
  return { key, method, url, status: 200, count: 1, real, mocked, write, auth: false, telemetry: false, inBody, shape };
}

// One baseline row (one run of one test).
function row({ title = `test ${++seq}`, project = 'chromium', file = 'a.spec.ts', status = 'passed', endpoints = [],
  asserted = [], expects = [{ matcher: 'toHaveText', ms: 10, failed: false }], repeat = 0, ...rest } = {}) {
  return { key: testKey(project, [file, title]), project, title, file, line: 1, repeat, status, ms: 100,
    expectedFail: false, expects, sleeps: 0, visibilityOnly: false, traffic: { endpoints, asserted }, ...rest };
}

// Two identical passing baseline runs, the way mustfail records each test.
const twice = r => [r, { ...r, repeat: 1 }];

// A fault-run row for the grader.
function faultRow(key, fault, { status = 'failed', error = '', errorKind, expects = [], bodyStarted = true, applied = 1, handlerErrors = 0 } = {}) {
  return { key, status, error, ...(errorKind ? { errorKind } : {}), expects,
    fault: { ...fault, applied, handlerErrors, afterBody: 0, bodyStarted } };
}

module.exports = { API, endpoint, row, twice, faultRow };
