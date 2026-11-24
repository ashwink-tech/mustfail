'use strict';
const { pathLabel, isPersistingWrite } = require('./shared');

const shortEndpoint = key => {
  const [method, rest] = key.split(' ');
  if (rest && rest.includes('#')) return `GraphQL ${rest.split('#')[1]}`;
  try { const u = new URL(rest.split('#')[0]); return `${method} ${u.pathname}${rest.includes('#') ? '#' + rest.split('#')[1] : ''}`; }
  catch { return key; }
};
function describeFault(f) {
  const where = shortEndpoint(f.endpoint || '');
  if (f.op === 'fail-write') return `${where} returned 500`;
  if (f.op === 'empty-list') return `\`${pathLabel(f.path) || '(root)'}\` emptied in ${where}`;
  if (f.op === 'change-rows') return `the text fields in every \`${pathLabel(f.path) || '(root)'}\` row changed in ${where}`;
  if (f.op === 'change-value') return `\`${pathLabel(f.path)}\` changed in ${where}`;
  if (f.op === 'flip-booleans') return `the true/false fields in every \`${pathLabel(f.path) || '(root)'}\` row flipped in ${where}`;
  return 'every API call returned 500';
}
const killed = row => row && row.status !== 'passed' && row.status !== 'skipped';
// A kill counts as "the test checked it" only when an assertion failed. If a click or wait timed
// out first (the row it looks for by name is gone or renamed), the test used the data to find its
// way, which proves it needs the data, not that it checks it.
const ACTION_TIMEOUT = /^(TimeoutError: |Error: )?(locator|proxy|page|frame|elementHandle)\.\w+: Timeout/;
const assertionFailed = row => row.errorKind ? row.errorKind === 'assertion' : !ACTION_TIMEOUT.test(row.error || '');
// Matchers that only check an element exists or is in some state. When one fails after a fault
// that renamed rows, the test was looking for the row by its name: a wait, not a value check.
const STATE_MATCHER = /^(toBeVisible|toBeHidden|toBeAttached|toBeEnabled|toBeDisabled|toBeChecked|toBeEditable|toBeFocused|toBeInViewport|toBeEmpty)$/;
const failedMatcher = row => ((row.error || '').match(/expect\([^)]*\)\.(?:not\.)?(\w+)/) || [])[1] || '';
// State matchers that read a true/false the page took from the server (a checkbox, an enabled button).
const BOOL_MATCHER = /^(toBeChecked|toBeEnabled|toBeDisabled|toBeEditable)$/;
// The failed assertion's call site, when the reporter recorded it (alpha.30 on). inSpec false = the
// assertion sits in a helper the test called, often a page object checking its own setup.
const failedExpect = row => (row.expects || []).find(e => e.failed);
// The name of the function an assertion sits in, read from the source at the recorded line.
const fs = require('fs'), path = require('path');
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'await', 'expect', 'test', 'describe', 'step']);
const srcCache = new Map();
function enclosingName(at, rootDir) {
  const m = /^(.*):(\d+)$/.exec(at || ''); if (!m) return null;
  const file = path.resolve(rootDir || '.', m[1]);
  if (!srcCache.has(file)) { try { srcCache.set(file, fs.readFileSync(file, 'utf8').split(/\r?\n/)); } catch { srcCache.set(file, null); } }
  const lines = srcCache.get(file); if (!lines) return null;
  const re = [
    // method or function declaration: name(args) [: Type] {   (also single-line bodies, or params split over lines)
    /^\s*(?:(?:public|private|protected|static|readonly|export|async)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\((?:[^;]*\)\s*(?::[^={;]+)?\{.*|[^)]*)$/,
    // arrow assigned to a variable or class field: name = async (args) =>
    /^\s*(?:(?:export|const|let|var|public|private|protected|static|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
    /function\s+([A-Za-z_$][\w$]*)\s*\(/];
  for (let i = Math.min(+m[2] - 1, lines.length - 1); i >= 0; i--) {
    for (const r of re) { const x = r.exec(lines[i]); if (x && !NOT_A_NAME.has(x[1])) return x[1]; }
  }
  return null;
}
// A helper named for checking (expectTaskTitle, verifyRow, assertSaved) holds the test's own check moved
// into a page object. Any other helper (createUser, waitForRow, seedProducts) is doing setup.
// The verb may lead (expectRow) or follow a feature prefix (cartExpectItemsAbsent).
const CHECK_HELPER = /^(expect|verify|assert|validate|should)|(Expect|Verify|Assert|Validate|Should)/;
let ROOT = '';
const helperOf = row => {
  const e = failedExpect(row); if (!e || e.inSpec !== false) return null;
  const name = enclosingName(e.at, ROOT);
  // Source not readable (moved, or graded on another machine): say nothing rather than guess "setup".
  if (!name || CHECK_HELPER.test(name)) return null;
  return { at: e.at, name };
};
const inHelper = row => !!helperOf(row);

const { isLost } = require('./lost');

function grade(plan, faultResults) {
  ROOT = process.env.MUSTFAIL_SOURCE_ROOT || faultResults.rootDir || '';
  const byKey = new Map();
  for (const r of faultResults.rows) {
    if (!r.fault) continue;
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }

  const results = [];
  for (const [key, meta] of Object.entries(plan.info)) {
    const base = { key, title: meta.title, file: meta.file, line: meta.line, project: meta.project, notes: [] };
    if (meta.visibilityOnly) base.notes.push('Only checks that elements are visible, not what they show.');
    if (meta.sleeps) base.notes.push(`Uses waitForTimeout (${meta.sleeps === 1 ? "once" : meta.sleeps + " times"}).`);

    if (plan.excluded[key]) { results.push({ ...base, grade: 'not measurable', reason: plan.excluded[key] }); continue; }
    const noAssertions = meta.expects.length === 0;
    if (noAssertions) base.notes.push('No assertion ran: it can only fail when a wait or click times out.');

    const allRows = byKey.get(key) || [];
    const alone = allRows.find(r => r.fault.op === 'alone');
    if (alone && killed(alone)) {
      results.push({ ...base, grade: 'not measurable', reason: 'It fails when run on its own, without the tests before it in its serial group, so it depends on them; its fault runs say nothing about its own checks.' });
      continue;
    }
    const ran = allRows.filter(r => r.fault.op !== 'alone' && r.fault.op !== 'clean');
    // Runs that broke in setup before their fault touched anything (see lost.js) say nothing either way.
    const lostRuns = ran.filter(isLost);
    const rows = ran.filter(r => !isLost(r));
    if (lostRuns.length) {
      const err = (lostRuns[0].error || 'no error message').slice(0, 160);
      const what = `broke in setup before the fault touched anything (${err})`;
      const ownWrite = lostRuns.find(r => r.fault.op === 'fail-write');
      const lostBlackout = lostRuns.find(r => r.fault.op === 'blackout');
      if (lostBlackout || ownWrite || lostRuns.length * 2 >= ran.length) {
        const which = lostBlackout ? 'The run with every API call failing' : ownWrite ? `The run where ${describeFault(ownWrite.fault)}` : `${lostRuns.length} of its ${ran.length} fault runs`;
        results.push({ ...base, grade: 'not measurable', lost: lostRuns.length,
          reason: `${which} ${what}. The fault cannot have caused that: something an earlier failed run left behind did (see the warning at the top). Fix that and run mustfail again.` });
        continue;
      }
      base.notes.push(`${lostRuns.length === 1 ? 'One fault run' : `${lostRuns.length} fault runs`} ${what}; not counted.`);
    }
    const blackout = rows.find(r => r.fault.op === 'blackout');
    if (!blackout) {
      const reason = meta.serial
        ? 'It runs in serial mode (describe.configure({ mode: "serial" }) or the config): when an earlier test in the group failed under a fault, Playwright skipped this one, so it never ran with every API call failing.'
        : 'The fault run did not reach this test.';
      results.push({ ...base, grade: 'not measurable', reason }); continue;
    }
    if (!blackout.fault.applied) { results.push({ ...base, grade: 'not measurable', reason: 'No API call was made during the fault run.' }); continue; }
    const mocked = (meta.mockedEndpoints || []).map(shortEndpoint);
    if (mocked.length) base.notes.push(`Mocks ${mocked.join(', ')} itself.`);
    if (!killed(blackout) && noAssertions) { results.push({ ...base, grade: 'decorative', reason: 'No assertion ran in this test, and it stayed green with every API call failing.' }); continue; }
    if (!killed(blackout)) {
      if (meta.checksMockedData) {
        results.push({ ...base, grade: 'not measurable', reason: `Its assertions check data the test mocks itself (${mocked.join(', ')}), so server faults cannot reach them.` });
      } else if (meta.mocksFailure) {
        results.push({ ...base, grade: 'not measurable', reason: `The test makes a request fail itself (it mocks an error response for ${mocked.join(', ')}), so an outage is the condition it already creates: staying green when every call fails says nothing about it.` });
      } else {
        const n = blackout.fault.applied;
        results.push({ ...base, grade: 'decorative', reason: `Stayed green with every API call failing (${n} ${n === 1 ? 'call' : 'calls'} failed).` });
      }
      continue;
    }

    // A fault that broke the fixture before the body ran says nothing about the test: drop it,
    // like a fault that never applied.
    // A run where our route handler threw (an aborted or superseded request) let some real responses
    // through. A pass then is not "stayed green", and a failure is not clean proof either: with the fault
    // half applied, the test can get past a step the full fault would stop it at (a test found its row by
    // the real name, then failed on the changed one). Such runs count for neither side.
    const leaky = r => r.fault.handlerErrors > 0;
    const allTargeted = rows.filter(r => r.fault.op !== 'blackout' && r.fault.applied > 0 && !(killed(r) && r.fault.bodyStarted === false));
    const targeted = allTargeted.filter(r => !leaky(r));
    if (allTargeted.some(leaky)) base.notes.push(`The run where ${allTargeted.filter(leaky).map(r => describeFault(r.fault)).join(' and where ')} did not reach every response, so it is not counted.`);
    if (blackout.fault.bodyStarted === false) base.notes.push('With every API call failing it broke during setup, before its body ran.');
    // When blocking every call breaks the fixture (a record created through the browser), that
    // says nothing about the test body, so the reasons must not credit the test with failing.
    const setupBroke = blackout.fault.bodyStarted === false;
    const downLead = setupBroke ? 'Its setup breaks when every API call fails, which says nothing about the test itself, and it' : 'Fails when everything is down, but';
    const main0 = meta.mainList;
    // A kill proves the test checks data only if the fault touched what it checks. Emptying a list
    // the test merely clicks into (select a row, open a detail) proves it needs rows, nothing more.
    const proves = f => f.op !== 'empty-list' || f.linked === true ||
      (main0 && main0.checked && f.endpoint === main0.endpoint && JSON.stringify(f.path) === JSON.stringify(main0.path));
    // Faults aimed at a value the test checks (or at its own write) count on any assertion failure.
    // Broad probes (row text rewrites, unlinked changes) count only when a value assertion failed.
    const aimed = f => f.linked === true || f.op === 'fail-write' || (f.op === 'empty-list' && proves(f));
    // A failure before the body started (fixture setup broke) says nothing about the test's checks.
    // A failed write of the test's own counts however the test stopped: waiting for a save that never
    // completes is noticing it. For data faults, a timed-out wait only shows the test needed the data.
    // mustfail cannot tell a write the test is about from one it makes as setup (create a record, then
    // check something else), so a stop on the test's own write counts, and the reason says it was a stop.
    const ownSaveStopped = r => r.fault.op === 'fail-write';
    const isProof = r => killed(r) && r.fault.bodyStarted !== false && proves(r.fault) &&
      (ownSaveStopped(r) || (assertionFailed(r) && (aimed(r.fault) || !STATE_MATCHER.test(failedMatcher(r))
        // Flipped booleans: a checkbox or enabled-state assertion failing is the proof this fault looks for.
        || (r.fault.op === 'flip-booleans' && BOOL_MATCHER.test(failedMatcher(r))))));
    // When several faults made it fail, cite the most telling: a value change, then a persisting write.
    // `persisting` is stamped by the planner (it knows the baseline status); plans made before that lack it.
    const persistingWrite = f => f.op === 'fail-write' && (f.persisting ?? isPersistingWrite(f.endpoint));
    const rank = r => r.fault.op === 'fail-write' ? (persistingWrite(r.fault) ? 1 : 2) : 0;
    // A stop on the test's own write by a timed-out wait shows it waits for the save, not that any
    // assertion looks at the result. That is real, but it is a different claim from "an assertion
    // failed when the data was wrong", so it gets its own grade instead of hiding inside strong.
    const writeOnly = r => r.fault.op === 'fail-write' && !assertionFailed(r);
    const proofs = targeted.filter(isProof).sort((a, b) => rank(a) - rank(b));
    // Prefer a proof whose failed assertion is in the spec; fall back to one inside a helper.
    const caught = proofs.find(r => !writeOnly(r) && !inHelper(r)) || proofs.find(r => !writeOnly(r));
    const gated = caught ? null : proofs[0] || null;
    const needsRows = targeted.find(r => killed(r) && !isProof(r));
    const survived = targeted.filter(r => !killed(r));
    // A write that persists something (by GraphQL name, or REST method and path) that the test made itself.
    const ownWriteSurvived = survived.find(r => persistingWrite(r.fault));
    const main = main0;
    const isMain = f => main && main.touched && f.op === 'empty-list' && f.endpoint === main.endpoint && JSON.stringify(f.path) === JSON.stringify(main.path);
    const emptySurvived = targeted.find(r => r.fault.op === 'empty-list' && !killed(r) && (isMain(r.fault) || r.fault.linked));
    // A run that was repeated and came out differently (confirm.js): the weaker result is the one counted.
    const SAID = ['it stayed green', 'a wait or click timed out', 'an assertion failed'];
    for (const r of targeted) if (r.wavered) base.notes.push(`The run where ${describeFault(r.fault)} was repeated and came out differently (once ${SAID[r.wavered.first]}, once ${SAID[r.wavered.second]}); the weaker result is counted.`);
    const decided = caught || gated;
    if (decided) base.decidedBy = faultResults.rows.indexOf(decided);
    if ((caught || gated) && emptySurvived) base.notes.push(`Still passed when ${describeFault(emptySurvived.fault)}${isMain(emptySurvived.fault) ? ', the largest list on the page' : ''}: it may pass with no data.`);
    if (caught) {
      if (inHelper(caught)) {
        const h = helperOf(caught);
        results.push({ ...base, grade: 'strong', via: 'helper', reason: `Failed when ${describeFault(caught.fault)}, but the assertion that failed is in a helper (${h.name ? h.name + ', ' : ''}${h.at}), not in the test: often a page object checking the setup it just did. Check that the test's own assertions cover what it is named for.`,
          evidence: caught.error });
      } else {
        results.push({ ...base, grade: 'strong', reason: `Failed when ${describeFault(caught.fault)}.`,
          evidence: caught.error });
      }
    } else if (gated) {
      const rest = survived.length ? ` It stayed green when ${survived.map(r => describeFault(r.fault)).join(' and when ')}.` : '';
      // A value the test checks was changed and the test stopped, but on a click or wait that looks the row
      // up by that value: a wrong value does stop it, just not on an assertion. Worth saying; not proof.
      const onClick = targeted.find(r => killed(r) && r.fault.op === 'change-value' && r.fault.linked === true && !assertionFailed(r) && r.fault.bodyStarted !== false);
      const caughtPart = onClick
        ? `no assertion checked the result. When ${describeFault(onClick.fault)} it stopped too, but on a click or wait that finds the row by that value, before any assertion ran: a wrong value does stop it, so it is closer to strong than the grade says.`
        : 'no assertion checked the result, and nothing showed that wrong or missing data would be caught. If that write is only setup, it says even less about what the test is for.';
      results.push({ ...base, grade: 'write-gated', ...(onClick ? { stopsOnValue: true } : {}), reason: `Fails when ${describeFault(gated.fault)}, but only because a wait timed out: ${caughtPart}${rest}`,
        evidence: gated.error });
    } else if (ownWriteSurvived) {
      // Its own save, edit or delete failed and it still passed: what it checks does not depend on that
      // write succeeding (often a final check that cannot fail, or one the UI satisfies optimistically).
      const rest = survived.filter(r => r !== ownWriteSurvived);
      results.push({ ...base, grade: 'weak', reason: `Stayed green when its own write failed (${describeFault(ownWriteSurvived.fault)}): nothing it checks depends on that write succeeding.${rest.length ? ` It also stayed green when ${rest.map(r => describeFault(r.fault)).join(' and when ')}.` : ''}${needsRows ? ` It does fail when ${describeFault(needsRows.fault)}, ${assertionFailed(needsRows) ? 'on an assertion not tied to its values' : 'on a click or wait that needs that data'}.` : ''}` });
    } else if (targeted.length && meta.assertionsLinked && survived.length && !needsRows) {
      const pre = needsRows ? `Fails when ${describeFault(needsRows.fault)}, but` : downLead;
      results.push({ ...base, grade: 'weak', reason: `${pre} stayed green when ${survived.map(r => describeFault(r.fault)).join(' and when ')}.` });
    } else if (needsRows) {
      // It needs the data to exist, but no assertion we could see is tied to its values. Its real check
      // may be one mustfail cannot read (a boolean, a computed value), so this is not "no data check".
      const rest = survived.length ? ` It stayed green when ${survived.map(r => describeFault(r.fault)).join(' and when ')}.` : '';
      const how = assertionFailed(needsRows)
        ? 'so it needs that data, but none of the assertions mustfail could read are tied to its values; it cannot tell whether wrong values would be caught'
        : needsRows.fault.bodyStarted === false ? 'but before the test body started: its setup broke, which says nothing about its checks'
        : 'but only because a click or wait timed out: it uses that data to find its way, and no assertion failed on it';
      // Data nearly every test in the run receives (menus, schema, permissions) breaking a test shows the
      // app needs it, not that this test is about it.
      const wide = needsRows.fault.sessionWide && needsRows.fault.bodyStarted !== false
        ? ' Most tests in this run read that call, so it is probably the app\'s own configuration (menus, schema, permissions) rather than this test\'s data.' : '';
      results.push({ ...base, grade: 'unproven', reason: `Fails when ${describeFault(needsRows.fault)}, ${how}.${wide}${rest}` });
    } else if (targeted.length && !meta.assertionsLinked) {
      results.push({ ...base, grade: 'no data check', reason: `${setupBroke ? 'Its setup breaks when every API call fails, which says nothing about the test itself. None' : 'Fails when the page cannot load, but none'} of its assertions check a value from the server, and it stayed green when ${survived.map(r => describeFault(r.fault)).join(' and when ')}. Fine for browser-only behaviour (selection, date pickers, form rules); a gap if this test is meant to verify data.` });
    } else if (targeted.length) {
      results.push({ ...base, grade: 'weak', reason: `${downLead} stayed green when ${survived.map(r => describeFault(r.fault)).join(' and when ')}.` });
    } else {
      results.push({ ...base, grade: 'unproven', reason: setupBroke ? 'Its setup breaks when every API call fails, which says nothing about the test itself, and no fault could be aimed at its own data.' : 'Fails when everything is down, but no fault could be aimed at its own data.' });
    }
  }
  const order = { decorative: 0, weak: 1, 'no data check': 2, unproven: 3, 'not measurable': 4, 'write-gated': 5, strong: 6 };
  results.sort((a, b) => order[a.grade] - order[b.grade] || a.file.localeCompare(b.file) || a.line - b.line);
  // A test that asserts what its page sent has a real check mustfail cannot fault. Say so on any grade
  // short of strong, so "no data check" or "write-gated" is not read as "checks nothing".
  for (const r of results) {
    const sent = plan.info?.[r.key]?.requestChecks;
    if (!sent?.length) continue;
    r.checksRequest = sent.map(shortEndpoint);
    if (r.grade === 'decorative' || r.grade === 'no data check' || r.grade === 'weak') {
      // Its only real check is on the request: grade it as that, not as checking nothing.
      r.notes.push(r.reason);
      r.grade = 'request check';
      r.reason = `Asserts the request it sent (${r.checksRequest.join(', ')}): a real check of what the app sends, which server faults cannot test. None of its assertions checks a value from the server.`;
    } else if (r.grade !== 'strong' && r.grade !== 'not measurable') {
      r.reason += ` It also asserts the request it sent (${r.checksRequest.join(', ')}): a real check of what the app sends, which server faults cannot test.`;
    }
  }
  const counts = {};
  for (const r of results) counts[r.grade] = (counts[r.grade] || 0) + 1;
  const viaHelper = results.filter(r => r.via === 'helper').length;
  if (viaHelper) counts['strong via a helper'] = viaHelper;
  const sentN = results.filter(r => r.checksRequest && r.grade !== 'request check').length;
  if (sentN) counts['checks its request'] = sentN;
  return { counts, results, ...(faultResults.lost ? { lost: faultResults.lost } : {}) };
}

module.exports = { enclosingName, CHECK_HELPER, grade, describeFault, killed, assertionFailed };
