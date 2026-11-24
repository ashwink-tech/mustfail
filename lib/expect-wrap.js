'use strict';
// Baseline only: wraps `expect` so that when an assertion on a locator passes, we record
// the text it checked. That text tells the planner which response field the test depends on.
const isLocator = v => v && typeof v === 'object' && typeof v.evaluateAll === 'function' && typeof v.page === 'function';

// innerText of an element the browser is not rendering at that instant falls back to textContent, which
// runs cell texts together ("ctx_123TextGlobal"), so a value no longer stands as a word. The leaf elements'
// texts joined by newlines are recorded beside it.
async function captureText(locator) {
  try {
    return await locator.evaluateAll(els => els.slice(0, 20).flatMap(e => {
      // A checkbox, radio or switch says nothing by its value ("on"); what it is about is the row it sits in.
      const type = (e.getAttribute && (e.getAttribute('type') || '')).toLowerCase();
      const role = (e.getAttribute && e.getAttribute('role')) || '';
      if (type === 'checkbox' || type === 'radio' || /^(checkbox|radio|switch)$/.test(role)) {
        const row = e.closest('tr,[role="row"],li,[role="listitem"],[role="option"]');
        if (row) e = row; else return [];
      } else if (('value' in e) && typeof e.value === 'string' && e.value) return [e.value];
      const text = e.innerText || e.textContent || '';
      if (!e.children || !e.children.length) return [text];
      const leaves = [];
      for (const x of e.querySelectorAll('*')) {
        if (x.children.length) continue;
        const t = (x.textContent || '').trim();
        if (t) leaves.push(t);
        if (leaves.length >= 50) break;
      }
      const joined = leaves.join('\n');
      return joined && joined !== text.trim() ? [text, joined] : [text];
    }));
  } catch { return []; }
}

// Strings the test itself wrote as the expected value: toContainText('Static'), toHaveText(['a', 'b']).
const expectedStrings = args => {
  const out = [];
  for (const a of args.slice(0, 2)) {
    if (typeof a === 'string') out.push(a);
    else if (Array.isArray(a)) for (const x of a.slice(0, 20)) if (typeof x === 'string') out.push(x);
  }
  return out.filter(t => t.trim().length >= 3 && t.length <= 200);
};
// Plain values: expect(status).toBe('Failed'), expect(labels).toEqual([...]).
const plainStrings = v => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.slice(0, 20).filter(x => typeof x === 'string') : [])
  .filter(t => t.trim().length >= 3 && t.length <= 200);

const COMPARING = /^(toBe|toEqual|toStrictEqual|toContain|toContainEqual|toMatch|toMatchObject|toHaveProperty)$/;

function wrapMatchers(matchers, actual, onPass, locator, sent) {
  return new Proxy(matchers, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === 'not') return wrapMatchers(value, actual, (texts, m, kind) => onPass(texts, 'not.' + m, kind), locator, sent);
      if (typeof value !== 'function') return value;
      return function (...args) {
        const result = value.apply(target, args);
        if (!locator) {
          // The subject is a request the page sent (or a value inside one): the test checks what the app
          // sends, which no server fault can change. Recorded with the endpoint, not linked to responses.
          const hit = sent && sent(actual);
          if (hit) { onPass([hit.key], String(prop), 'request'); if (hit.whole) return result; }
          if (result && typeof result.then === 'function') return result;
          // Only comparisons say what value the test expects; toBeTruthy(id) says nothing.
          if (!COMPARING.test(String(prop))) return result;
          const texts = plainStrings(actual);
          if (texts.length) onPass(texts, String(prop), 'value');
          return result;
        }
        if (result && typeof result.then === 'function') {
          return result.then(async out => {
            onPass(await captureText(actual), String(prop));
            const exp = expectedStrings(args);
            if (exp.length) onPass(exp, String(prop), 'expected');
            return out;
          });
        }
        return result;
      };
    },
  });
}

function wrapExpect(realExpect, onPass, sent) {
  return new Proxy(realExpect, {
    apply(target, thisArg, args) {
      const matchers = Reflect.apply(target, thisArg, args);
      return wrapMatchers(matchers, args[0], onPass, isLocator(args[0]), sent);
    },
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === 'soft') return wrapExpect(value, onPass, sent);
      if ((prop === 'configure' || prop === 'extend') && typeof value === 'function') {
        return (...args) => wrapExpect(value.apply(target, args), onPass, sent);
      }
      return value;
    },
  });
}

module.exports = { wrapExpect };
