'use strict';
// Re-exports the project's own copy of @playwright/test with `test` extended by our
// fixtures. Resolving from the project root keeps a single Playwright instance.
const realPath = require.resolve('@playwright/test', { paths: [process.env.MUSTFAIL_ROOT || process.cwd()] });
const real = require(realPath);
const { extendTest, recordAsserted, markBodyDone, markBodyStarted, setBodyTracking, MODE, sentMatch } = require('./fixture');
const { wrapExpect } = require('./expect-wrap');

// Marks the end of each test body, so faults stop before afterEach hooks and fixture teardown.
// Playwright reads fixture names from the function's source, so the wrapper reports the original's.
function wrapBody(fn) {
  const wrapped = async function (fixtures, testInfo) {
    markBodyStarted(testInfo);
    try { return await fn.call(this, fixtures, testInfo); } finally { markBodyDone(testInfo); }
  };
  wrapped.toString = () => fn.toString();
  return wrapped;
}
// Wrap every test body as Playwright creates the test. Patching its internal _createTest (guarded:
// if the internals move, faults simply keep running through teardown, as before) keeps the test's
// own file and line, which a wrapper around test() would replace with ours.
function patchCreateTest(t) {
  if (MODE === 'off') return false;
  const sym = Object.getOwnPropertySymbols(t).find(x => x.description === 'testType');
  const proto = sym && t[sym] && Object.getPrototypeOf(t[sym]);
  if (!proto || typeof proto._createTest !== 'function' || proto._createTest.__mustfail) return !!proto?._createTest?.__mustfail;
  const orig = proto._createTest;
  const patched = function (type, location, title, fnOrDetails, fn) {
    if (typeof fnOrDetails === 'function') fnOrDetails = wrapBody(fnOrDetails);
    else if (typeof fn === 'function') fn = wrapBody(fn);
    return orig.call(this, type, location, title, fnOrDetails, fn);
  };
  patched.__mustfail = true;
  proto._createTest = patched;
  return true;
}
if (MODE !== 'off') setBodyTracking(patchCreateTest(real.test));
const test = extendTest(real.test);
const onPass = (texts, matcher, kind) => { try { recordAsserted(real.test.info(), texts, matcher, kind); } catch {} };
const sent = actual => { try { return sentMatch(real.test.info(), actual); } catch { return null; } };
const expect = MODE === 'baseline' ? wrapExpect(real.expect, onPass, sent) : real.expect;
// mergeExpects() builds a new expect from the real one: wrap its result too, or a suite that merges its
// custom matchers would have none of its assertions recorded.
const mergeExpects = MODE === 'baseline' && typeof real.mergeExpects === 'function'
  ? (...list) => wrapExpect(real.mergeExpects(...list), onPass, sent) : real.mergeExpects;
module.exports = { ...real, test, expect, mergeExpects, default: test };
