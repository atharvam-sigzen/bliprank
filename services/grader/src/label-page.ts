/**
 * THE REVIEW PAGE — one self-contained HTML file, opened from disk.
 *
 * ⚠️ WHY A PAGE AND NOT JUST THE CSV. Both are emitted and both produce the
 * same nine columns; the CSV is the durable, diffable, spreadsheet-editable
 * artefact and nothing here replaces it. The page exists because the CSV has
 * two properties that cost accuracy over a hundred rows: a free-text category
 * column invites a typo that `--import` will reject an hour later, and a
 * spreadsheet shows a truncated meta description in a cell the labeller has to
 * widen to read. This page shows the page's own words at full width, offers the
 * fifteen categories as a list rather than as spelling, and moves on by itself.
 *
 * ⚠️ NO NETWORK, NO BUILD, NO DEPENDENCY. It is a file:// page with the
 * worklist inlined as JSON. It fetches nothing — which also means it cannot
 * re-fetch a homepage and show the labeller a page different from the one the
 * classifier read.
 *
 * ⚠️ AND IT CANNOT WRITE THE CSV BACK. A file:// page has no filesystem, and a
 * download from one is a browser-by-browser lottery. So it renders the finished
 * CSV into a textarea with a copy button: the labeller copies it over
 * `worklist.csv` and runs `--import`, which validates every row again. The
 * validation is in the importer, not in this page, so a hand-edited CSV and a
 * page-produced one are held to exactly the same bar.
 *
 * Progress is kept in `localStorage` per file, so closing the tab halfway
 * through a hundred domains does not start again.
 */

import type { WorklistRow } from './label.js'

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function reviewPage(rows: readonly WorklistRow[], choices: readonly string[]): string {
  // ⚠️ Serialised into a <script> as JSON, with `<` escaped. A meta description
  // containing "</script>" would otherwise close the tag and break the page —
  // and these strings come from arbitrary homepages.
  const data = JSON.stringify(rows).replace(/</g, '\\u003c')
  const opts = JSON.stringify(choices).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Classification labelling — ${rows.length} domains</title>
<style>
  :root { color-scheme: light dark; --line: #8883; --muted: #7a7f87; }
  * { box-sizing: border-box }
  body { margin: 0; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { position: sticky; top: 0; padding: 12px 20px; border-bottom: 1px solid var(--line);
           background: Canvas; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; z-index: 2 }
  header b { font-size: 18px }
  .muted { color: var(--muted) }
  main { max-width: 900px; margin: 0 auto; padding: 20px }
  .card { border: 1px solid var(--line); border-radius: 6px; padding: 16px 18px; margin-bottom: 14px }
  .card[data-done="1"] { opacity: .5 }
  .dom { font: 600 17px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all }
  .title { margin: 8px 0 2px; font-weight: 600 }
  .desc { margin: 0 0 10px; color: var(--muted) }
  .prop { font: 13px ui-monospace, Menlo, monospace; padding: 8px 10px; border-left: 3px solid var(--line); margin: 10px 0 }
  .ev { color: var(--muted); font-size: 12px }
  button { font: inherit; padding: 6px 14px; border: 1px solid var(--line); border-radius: 5px; background: transparent; cursor: pointer }
  button.on { border-color: currentColor; font-weight: 600 }
  select, textarea { font: inherit; padding: 6px; border: 1px solid var(--line); border-radius: 5px; background: transparent; color: inherit }
  textarea { width: 100%; height: 240px; font: 12px ui-monospace, Menlo, monospace }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px }
  .note { width: 100%; padding: 6px; margin-top: 6px }
  kbd { border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; font: 12px ui-monospace, Menlo, monospace }
  #out { display: none; padding: 20px; border-top: 1px solid var(--line) }
</style></head><body>
<header>
  <b>Classification labelling</b>
  <span id="count" class="muted"></span>
  <span class="muted">·</span>
  <span class="muted"><kbd>1</kbd> right &nbsp;<kbd>2</kbd> wrong &nbsp;<kbd>3</kbd> unsure &nbsp;<kbd>j</kbd>/<kbd>k</kbd> move</span>
  <span style="flex:1"></span>
  <button id="finish">Produce the CSV</button>
</header>
<main id="list"></main>
<section id="out">
  <p><b>Copy this over <code>worklist.csv</code>, then run <code>--import</code>.</b>
     Every row is validated again there, so nothing here can wave a bad row through.</p>
  <button id="copy">Copy to clipboard</button>
  <textarea id="csv" readonly></textarea>
</section>
<script>
const ROWS = ${data}, CHOICES = ${opts};
const KEY = 'bliprank-labelling-' + ROWS.length + '-' + (ROWS[0] ? ROWS[0].domain : '');
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}') } catch (e) { state = {} }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)) } catch (e) {} };
let cur = 0;

const list = document.getElementById('list');
ROWS.forEach((r, i) => {
  const s = state[r.domain] || { verdict: '?', correct: '', notes: '' };
  const c = document.createElement('div');
  c.className = 'card'; c.id = 'c' + i;
  c.innerHTML =
    '<div class="dom"></div>' +
    '<p class="title"></p><p class="desc"></p>' +
    '<div class="prop">proposed: <b class="pp"></b> &nbsp;via <span class="ss"></span><br><span class="ev"></span></div>' +
    '<div class="row">' +
      '<button data-v="ok">1 · right</button>' +
      '<button data-v="wrong">2 · wrong</button>' +
      '<button data-v="unsure">3 · unsure</button>' +
      '<select class="fix" hidden></select>' +
    '</div>' +
    '<input class="note" placeholder="note (optional)">';
  c.querySelector('.dom').textContent = r.domain;
  // ⚠️ "not read" and "read, and empty" are different facts. Rungs 1 and 2
  // decide from the hostname, so a tracked brand's page is never fetched.
  c.querySelector('.title').textContent = r.fetched ? (r.title || '(the page has no title)') : 'the page was not read';
  c.querySelector('.desc').textContent = r.fetched
    ? (r.description || '(the page has no description)')
    : 'the hostname alone decided this one, so no homepage was fetched — judge it on the domain and the evidence below';
  c.querySelector('.pp').textContent = r.proposed || '(none)';
  c.querySelector('.ss').textContent = r.signal;
  c.querySelector('.ev').textContent = r.evidence;
  const sel = c.querySelector('.fix');
  sel.innerHTML = '<option value="">which is right?</option>' +
    CHOICES.filter(x => x !== r.proposed).map(x => '<option>' + x + '</option>').join('');
  sel.value = s.correct || '';
  sel.onchange = () => { state[r.domain] = Object.assign({}, state[r.domain], { correct: sel.value }); save(); paint() };
  c.querySelector('.note').value = s.notes || '';
  c.querySelector('.note').oninput = e => { state[r.domain] = Object.assign({}, state[r.domain], { notes: e.target.value }); save() };
  c.querySelectorAll('button[data-v]').forEach(b => {
    b.onclick = () => { set(i, b.dataset.v) };
  });
  list.appendChild(c);
});

function set(i, v) {
  const r = ROWS[i];
  state[r.domain] = Object.assign({ correct: '', notes: '' }, state[r.domain], { verdict: v });
  save(); paint();
  // "wrong" needs a category before moving on; the other two are complete.
  if (v !== 'wrong') { cur = Math.min(i + 1, ROWS.length - 1); focus() }
}
function focus() {
  const el = document.getElementById('c' + cur);
  if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); paint() }
}
function paint() {
  let done = 0;
  ROWS.forEach((r, i) => {
    const s = state[r.domain] || { verdict: '?' };
    const c = document.getElementById('c' + i);
    const complete = s.verdict === 'ok' || s.verdict === 'unsure' || (s.verdict === 'wrong' && s.correct);
    if (complete) done++;
    c.dataset.done = complete ? '1' : '0';
    c.style.outline = i === cur ? '2px solid currentColor' : 'none';
    c.querySelectorAll('button[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === s.verdict));
    c.querySelector('.fix').hidden = s.verdict !== 'wrong';
  });
  document.getElementById('count').textContent = done + ' of ' + ROWS.length + ' reviewed';
}
document.addEventListener('keydown', e => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === '1') set(cur, 'ok');
  else if (e.key === '2') set(cur, 'wrong');
  else if (e.key === '3') set(cur, 'unsure');
  else if (e.key === 'j') { cur = Math.min(cur + 1, ROWS.length - 1); focus() }
  else if (e.key === 'k') { cur = Math.max(cur - 1, 0); focus() }
  else return;
  e.preventDefault();
});

const q = s => /[",\\n\\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
document.getElementById('finish').onclick = () => {
  const head = ['domain','title','description','proposed','signal','evidence','verdict','correct','notes'];
  const body = ROWS.map(r => {
    const s = state[r.domain] || { verdict: '?', correct: '', notes: '' };
    return [r.domain, r.title, r.description, r.proposed, r.signal, r.evidence, s.verdict || '?', s.correct || '', s.notes || ''].map(q).join(',');
  });
  document.getElementById('csv').value = [head.join(','), ...body].join('\\n') + '\\n';
  document.getElementById('out').style.display = 'block';
  document.getElementById('out').scrollIntoView({ behavior: 'smooth' });
};
document.getElementById('copy').onclick = () => {
  const t = document.getElementById('csv'); t.select();
  navigator.clipboard ? navigator.clipboard.writeText(t.value) : document.execCommand('copy');
  document.getElementById('copy').textContent = 'Copied';
};
paint();
</script></body></html>
`
}
