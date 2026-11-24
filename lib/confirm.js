'use strict';
// A second look at the one run each strong or write-gated grade rests on.
//
// Every fault is run once. A test with a race in it can stop at a different step from one run to the
// next: a delete test whose delete was failing timed out on a toast wait in two runs and went past it to
// fail on an assertion in a third (an earlier toast was still showing). One run called it strong, two
// called it write-gated. So the deciding run is repeated once, and when the two disagree the
// weaker result is the one that counts, with a note saying so.
const { isLost } = require('./lost');

const killed = r => r.status !== 'passed' && r.status !== 'skipped';
const ACTION_TIMEOUT = /^(TimeoutError: |Error: )?(locator|proxy|page|frame|elementHandle)\.\w+: Timeout/;
const assertionFailed = r => r.errorKind ? r.errorKind === 'assertion' : !ACTION_TIMEOUT.test(r.error || '');
// 0 stayed green, 1 stopped on a wait or click, 2 an assertion failed.
const outcome = r => !killed(r) ? 0 : assertionFailed(r) ? 2 : 1;
// A repeat that says nothing: skipped, broke before the body, or the fault did not fully apply.
const unusable = r => r.status === 'skipped' || isLost(r) || (killed(r) && r.fault.bodyStarted === false) ||
  r.fault.handlerErrors > 0 || !r.fault.applied;

// One repeat of the deciding run of every strong or write-gated test.
function confirmPlan(plan, rows, graded) {
  const tests = {};
  for (const res of graded.results) {
    if (res.decidedBy === undefined || res.decidedBy < 0) continue;
    const row = rows[res.decidedBy];
    if (!row || row.confirmed !== undefined || row.wavered) continue;
    const { applied, handlerErrors, afterBody, bodyStarted, retryOf, ...fault } = row.fault;
    tests[res.key] = { faults: [{ ...fault, confirmOf: res.decidedBy }] };
  }
  const count = Object.keys(tests).length;
  if (!count) return null;
  // In a serial group a failing test makes Playwright skip the tests after it in that run, so each member
  // of a group gets a repeat of its own (the others are skipped there, which does not stop the group).
  const groups = new Map();
  for (const key of Object.keys(tests)) {
    const g = plan.info[key] && plan.info[key].serialGroup;
    if (!g) continue;
    const members = groups.get(g) || [];
    tests[key].faults = new Array(members.length).fill(null).concat(tests[key].faults);
    members.push(key); groups.set(g, members);
  }
  const maxFaults = Math.max(...Object.values(tests).map(t => t.faults.length));
  return { plan: { ...plan, tests, maxFaults }, count };
}

function mergeConfirm(rows, confirmRows) {
  const out = rows.slice();
  let same = 0, differed = 0;
  for (const second of confirmRows) {
    const i = second.fault && second.fault.confirmOf;
    if (i === undefined || !out[i] || unusable(second)) continue;
    const first = out[i];
    const a = outcome(first), b = outcome(second);
    if (a === b) { out[i] = { ...first, confirmed: true }; same++; continue; }
    differed++;
    const weaker = b < a ? second : first;
    out[i] = { ...weaker, wavered: { first: a, second: b } };
  }
  return { rows: out, same, differed };
}

module.exports = { confirmPlan, mergeConfirm, outcome };
