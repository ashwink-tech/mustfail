'use strict';
// What changed since the last report in the same output folder, for the tests graded both times.
const RANK = { decorative: 0, weak: 1, 'no data check': 2, unproven: 3, 'request check': 4, 'write-gated': 5, strong: 6 };

function compare(previous, graded) {
  if (!previous || !Array.isArray(previous.results)) return null;
  const old = new Map(previous.results.map(r => [r.key, r]));
  const better = [], worse = [], other = [];
  let both = 0;
  for (const r of graded.results) {
    const o = old.get(r.key);
    if (!o) continue;
    both++;
    if (o.grade === r.grade) continue;
    r.was = o.grade;
    const change = { title: r.title, file: r.file, line: r.line, from: o.grade, to: r.grade };
    const a = RANK[o.grade], b = RANK[r.grade];
    // "Not measurable" is not better or worse than anything: the test could not be judged that time.
    (a === undefined || b === undefined ? other : b > a ? better : worse).push(change);
  }
  if (!both) return null;
  return { when: (previous.meta && previous.meta.when) || '', both, unchanged: both - better.length - worse.length - other.length, better, worse, other };
}

function compareLines(since) {
  if (!since) return [];
  const n = since.better.length + since.worse.length + since.other.length;
  const head = `Since the last run in this folder${since.when ? ` (${since.when})` : ''}, of ${since.both} ${since.both === 1 ? "test" : "tests"} graded both times: `;
  if (!n) return [head + 'no grade changed.'];
  const out = [head + `${since.better.length} stronger, ${since.worse.length} weaker, ${since.other.length} other, ${since.unchanged} unchanged.`];
  const list = (label, items) => { for (const c of items) out.push(`  ${label}  ${c.file}:${c.line}  ${c.title}: ${c.from} -> ${c.to}`); };
  list('stronger', since.better); list('weaker  ', since.worse); list('other   ', since.other);
  return out;
}

module.exports = { compare, compareLines };
