'use strict';
const fs = require('fs');
const path = require('path');

const GRADES = ['decorative', 'weak', 'no data check', 'unproven', 'not measurable', 'request check', 'write-gated', 'strong'];
const MEANING = {
  decorative: 'Stays green when the app is broken',
  weak: 'Checks server data, but missed it being wrong',
  'no data check': 'Assertions never check server data',
  unproven: 'Notices an outage; nothing more could be tested',
  'not measurable': 'mustfail could not test it',
  'write-gated': 'Waits for its write; no assertion checks the result',
  strong: 'An assertion failed when the data was wrong',
  'request check': 'Asserts what the page sent; server faults cannot test that',
};

function summaryLine(counts, total) {
  return GRADES.filter(g => counts[g]).map(g => g === 'strong' && counts['strong via a helper']
    ? `${counts[g]} strong (${counts['strong via a helper']} via a helper)` : `${counts[g]} ${g}`).join(' · ')
    + (counts['checks its request'] ? ` · ${counts['checks its request']} more also check the request they send` : '') + `  (of ${total} tests)`;
}

// Fault runs that broke in setup for a reason the fault cannot explain (lost.js).
function lostWarning(lost) {
  if (!lost) return '';
  const who = lost.suspects?.length ? ` It ran ${lost.suspects.length === 1 ? 'the test that failed' : `the ${lost.suspects.length} tests that failed`} just before them again with no fault (${lost.suspects.slice(0, 12).join('; ')}${lost.suspects.length > 12 ? '; …' : ''}), then retried them: ${lost.recovered} recovered, ${lost.stillLost} still broke.` : '';
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const err = String(lost.error).replace(/`/g, "'");
  return `Warning: ${n(lost.lost, 'fault run')} in ${n(lost.tests, 'test')} broke in setup before ${lost.lost === 1 ? 'its' : 'their'} fault touched anything` +
    `${lost.errorCount > 1 && lost.errorCount < lost.lost ? `, ${lost.errorCount} of them with` : ', with'} \`${err}\`.` +
    ' The fault cannot cause that. Usually a test that failed partway, as fault runs make it, skipped any cleanup at the end of its body' +
    ' (turning a setting back off, deleting what it made), and what it left behind broke the tests after it.' + who +
    (lost.stillLost ? ' Tests whose key runs still broke are graded not measurable.' : ' Every retry got past setup, so the grades below count them.') + ' Move cleanup into afterEach or a finally block, and the same will not happen when a real bug makes a test fail.';
}

function lostWarningHtml(lost) {
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const sus = (lost.suspects || []).map(x => `<li>${esc(x)}</li>`).join('');
  return `<div class="warn"><b>${n(lost.lost, 'fault run')} in ${n(lost.tests, 'test')} broke in setup before the fault touched anything.</b>
<p>${lost.errorCount < lost.lost ? `${lost.errorCount} of them with:` : 'Error:'}</p><pre>${esc(lost.error)}</pre>
<p>The fault cannot cause that. Usually a test that failed partway, as fault runs make it, skipped cleanup at the end of its body (turning a setting back off, deleting what it made), and what it left behind broke the tests after it. Move that cleanup into <code>afterEach</code> or a <code>finally</code> block, and the same will not happen when a real bug makes a test fail.</p>
${sus ? `<p>mustfail re-ran the tests that failed just before them with no fault, then retried them: <b>${lost.recovered} recovered, ${lost.stillLost} still broke</b>.${lost.stillLost ? ' Tests whose key runs still broke are graded not measurable.' : ' The grades below count the retries.'} The tests it re-ran (a shortlist, not a diagnosis):</p><ul>${sus}</ul>` : ''}</div>`;
}

function printConsole(graded) {
  const { counts, results } = graded;
  const out = [];
  out.push('', `mustfail: ${summaryLine(counts, results.length)}`, '');
  if (graded.lost) out.push(lostWarning(graded.lost), '');
  for (const g of GRADES) {
    const rows = results.filter(r => r.grade === g);
    if (!rows.length) continue;
    out.push(`${g.toUpperCase()} — ${MEANING[g]}`);
    for (const r of rows) {
      out.push(`  ${r.file}:${r.line}  ${r.title}${r.project ? `  [${r.project}]` : ''}`);
      out.push(`      ${r.reason}`);
      for (const n of r.notes) out.push(`      note: ${n}`);
    }
    out.push('');
  }
  console.log(out.join('\n'));
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const code = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

function writeHtml(file, graded, meta) {
  const { counts, results } = graded;
  const cls = g => `g-${g.replace(/ /g, '-')}`;
  // Tiles are buttons: click one to show only that grade, click it again to show all.
  const tiles = GRADES.map(g => `<button type="button" class="tile ${cls(g)}" data-grade="${cls(g)}" aria-pressed="false"${counts[g] ? '' : ' disabled'}><b>${counts[g] || 0}</b><span>${g}</span><small>${MEANING[g]}</small></button>`).join('');
  const rows = results.map(r => `<tr class="${cls(r.grade)}">
<td><span class="pill">${r.grade}${r.via === 'helper' ? ' (helper)' : ''}</span>${r.was ? `<div class="was">was ${esc(r.was)}</div>` : ''}</td>
<td><div class="t">${esc(r.title)}</div><div class="f">${esc(r.file)}:${r.line}${r.project ? ` · ${esc(r.project)}` : ''}</div></td>
<td>${code(r.reason)}${r.evidence ? `<div class="ev">Failed with: ${esc(String(r.evidence).slice(0, 300))}</div>` : ''}${r.notes.map(n => `<div class="note">${esc(n)}</div>`).join('')}</td></tr>`).join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>mustfail report</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;color:#1d1d1f;background:#fafafa}
main{max-width:1100px;margin:0 auto;padding:32px 24px}
h1{font-size:22px;margin:0 0 4px}.sub{color:#666;margin:0 0 24px}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
@media(max-width:700px){.tiles{grid-template-columns:repeat(2,1fr)}}
.tile{background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:14px;border-top:4px solid var(--c);font:inherit;color:inherit;text-align:left;cursor:pointer}
.tile:disabled{opacity:.45;cursor:default}.tile[aria-pressed=true]{outline:2px solid var(--c);outline-offset:1px}.tile:focus-visible{outline:2px solid #1d1d1f;outline-offset:2px}
.bar{display:flex;gap:12px;align-items:center;margin-bottom:12px}.bar input{flex:1;font:inherit;padding:8px 10px;border:1px solid #ccc;border-radius:6px}.bar span{color:#666;white-space:nowrap}
tr[hidden]{display:none}.was{color:#666;font-size:12px;margin-top:4px;white-space:nowrap}.ev{color:#666;font-family:ui-monospace,monospace;font-size:12px;margin-top:4px;word-break:break-word}
.tile b{display:block;font-size:26px}.tile span{font-weight:600;text-transform:capitalize}.tile small{display:block;color:#666;margin-top:4px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top}th{background:#f3f3f3;font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--c);color:#fff;font-size:12px;white-space:nowrap}
.t{font-weight:600}.f{color:#666;font-family:ui-monospace,monospace;font-size:12px}
.warn{background:#fff4e5;border:1px solid #f0c36d;border-radius:8px;padding:12px 16px;margin:0 0 20px}
.warn p{margin:8px 0}.warn pre{white-space:pre-wrap;word-break:break-word;background:#fff;padding:8px;border-radius:6px;margin:4px 0;font-size:12px}.warn ul{margin:4px 0 0;padding-left:20px;font-size:13px}
.note{color:#8a5a00;font-size:12px;margin-top:4px}code{background:#f0f0f0;padding:0 4px;border-radius:3px}
.g-decorative{--c:#c0392b}.g-weak{--c:#d68910}.g-no-data-check{--c:#5d6d7e}.g-unproven{--c:#7f8c8d}.g-not-measurable{--c:#95a5a6}.g-write-gated{--c:#2e86c1}.g-request-check{--c:#7d3c98}.g-strong{--c:#1e8449}
</style></head><body><main>
<h1>mustfail report</h1>
<p class="sub">${esc(summaryLine(counts, results.length))} · ${esc(meta.when)} · Playwright ${esc(meta.playwright)}</p>
${graded.since ? `<p class="sub">${esc(require('./compare').compareLines(graded.since)[0])}${graded.since.better.length + graded.since.worse.length + graded.since.other.length ? ' Changed tests show their previous grade under the new one.' : ''}</p>` : ''}
${graded.lost ? lostWarningHtml(graded.lost) : ''}
<div class="tiles">${tiles}</div>
<div class="bar"><input id="q" type="search" placeholder="Filter by test name or file" aria-label="Filter by test name or file"><span id="n"></span></div>
<table><thead><tr><th>Grade</th><th>Test</th><th>Why</th></tr></thead><tbody>
${rows}
</tbody></table>
<p class="sub" style="margin-top:20px">Decorative: passed a run where every API call returned 500. Weak: its assertions check server data, but it passed when that data was changed, its list emptied or its own save failed. No data check: fails when the page cannot load, but no assertion checks a server value. Unproven: needs the data to be there, but nothing showed a wrong value would be caught. Not measurable: mustfail could not test it (skipped, unstable, mocked, or out of its reach). Request check: asserts what the page sent, which server faults cannot test. Write-gated: stops when its own write fails, but only because a wait timed out; no assertion checked the result. Strong: an assertion failed when a targeted fault changed or emptied data it checks.</p>
</main>
<script>
(function () {
  var grade = null, q = document.getElementById('q'), n = document.getElementById('n');
  var rows = [].slice.call(document.querySelectorAll('tbody tr')), tiles = [].slice.call(document.querySelectorAll('.tile'));
  function apply() {
    var text = q.value.trim().toLowerCase(), shown = 0;
    rows.forEach(function (r) {
      var ok = (!grade || r.classList.contains(grade)) && (!text || r.cells[1].textContent.toLowerCase().indexOf(text) >= 0);
      r.hidden = !ok; if (ok) shown++;
    });
    n.textContent = shown === rows.length ? rows.length + ' tests' : shown + ' of ' + rows.length + ' tests';
    tiles.forEach(function (t) { t.setAttribute('aria-pressed', String(t.dataset.grade === grade)); });
  }
  tiles.forEach(function (t) { t.addEventListener('click', function () { grade = grade === t.dataset.grade ? null : t.dataset.grade; apply(); }); });
  q.addEventListener('input', apply);
  apply();
})();
</script>
</body></html>`;
  fs.writeFileSync(file, html);
}

module.exports = { printConsole, writeHtml, summaryLine, lostWarning, GRADES };
