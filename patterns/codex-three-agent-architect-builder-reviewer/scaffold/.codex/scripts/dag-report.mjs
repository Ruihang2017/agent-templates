#!/usr/bin/env node
// dag-report.mjs — human-facing view of the execution plan, for Gate 1.
//
// milestone-dag.mjs answers "what order does the runner dispatch in". This answers the
// question a human has at sign-off: how many execution lanes does this decomposition
// actually have, where is it serial, and what `concurrency` is worth passing to
// /start-all? Both read the same graph via dag-core.mjs.
//
// ONE flowchart covers the whole PRD — every ticket, colored by its module — under two
// schedules the reader can toggle between:
//   global  — what /start-all does: it schedules every ticket from the flat DAG, so
//             module boundaries never gate anything (catalog issue #71).
//   runner  — what /start-milestone does: one module at a time, so a barrier sits
//             between modules and `cap` fans out only within the one running.
// Showing both prices the difference, so a reviewer can see what running module by
// module would cost on this particular decomposition.
//
// Usage: node .codex/scripts/dag-report.mjs [prd-root] [--out <path>]
//        prd-root defaults to docs/prd; --out defaults to <prd-root>/dag.html
// Output: a self-contained HTML page (no CDN, no network), a text summary on stdout,
//         and a final machine-readable line:
//   DAG-REPORT-JSON: {"out":"...","recommendedConcurrency":N,"schedules":{...},...}
// Exit 1 on the same spec defects milestone-dag.mjs rejects: missing root, no modules,
// a blocked_by referencing an unknown ticket, or a dependency cycle.
//
// The page is DETERMINISTIC — no timestamps, no machine core count. Re-running on an
// unchanged docs/prd rewrites a byte-identical file, so it can be committed and
// reviewed in the breakdown PR without churning the diff on every run.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { allDeps, buildPlan, globalSchedule, intraModuleDeps, laneProfile, runnerSchedule, scheduleProfile } from './dag-core.mjs'

const argv = process.argv.slice(2)
const outIx = argv.indexOf('--out')
const root = argv.filter((a, i) => a !== '--out' && argv[i - 1] !== '--out')[0] || 'docs/prd'
const out = outIx !== -1 && argv[outIx + 1] ? argv[outIx + 1] : join(root, 'dag.html')
// join() yields backslashes on Windows; report a forward-slash path so stdout and the
// JSON contract read the same on every platform (the E2E matrix runs ubuntu + windows).
const outShown = out.replace(/\\/g, '/')

if (!existsSync(root)) {
  console.error(`no such prd root: ${root}`)
  process.exit(1)
}

const plan = buildPlan(root)
if (plan.empty) {
  console.error(`no modules with tickets under ${root}`)
  process.exit(1)
}
if (plan.errors && plan.errors.length) {
  for (const e of plan.errors) console.error(`x ${e}`)
  process.exit(1)
}
if (plan.moduleCycle) {
  console.error(`x dependency cycle among: ${plan.moduleCycle.join(', ')}`)
  process.exit(1)
}
if (plan.ticketCycle) {
  console.error(`x intra-module dependency cycle in ${plan.ticketCycle.module} among: ${plan.ticketCycle.cycle.join(', ')}`)
  process.exit(1)
}

const { order, modules, ticketOrder } = plan
const deps = allDeps(modules)
const allIds = order.flatMap((m) => ticketOrder[m])
const n = allIds.length
// Bound the embedded schedule tables: n caps x n ids. Past 32 lanes the harness cap
// (min(16, cores-2)) has long since bound the run anyway.
const capMax = Math.min(n, 32)

const runnerProfile = scheduleProfile((cap) => runnerSchedule(order, modules, ticketOrder, cap), capMax)
const globalProfile = scheduleProfile((cap) => globalSchedule(order, modules, ticketOrder, cap), capMax)

// Per-module lane facts still drive the recommendation for the runner schedule: with a
// module barrier between every pair, the useful lane count is the max any single
// module can occupy — never the sum.
const perModule = order.map((name, i) => {
  const d = intraModuleDeps(modules[name])
  const p = laneProfile(ticketOrder[name], (id) => d[id])
  return { name, position: i + 1, dependsOn: [...modules[name].dependsOn].sort(),
    tickets: ticketOrder[name], maxUsefulLanes: p.maxUsefulLanes, minWaves: p.minWaves }
})

const recommended = perModule.reduce((m, x) => Math.max(m, x.maxUsefulLanes), 1)
const recommendedGlobal = globalProfile.maxUsefulLanes
const sliderMax = Math.min(32, Math.max(recommended, recommendedGlobal) + 2, Math.max(2, n))
const serial = perModule.filter((m) => m.maxUsefulLanes === 1 && m.tickets.length > 1).map((m) => m.name)

// Categorical color = module identity, assigned in FIXED order and never cycled.
// Cards from different modules sit arbitrarily adjacent in a wave column, so this is
// the all-pairs case: an exhaustive search over the reference palette found 4 to be the
// largest subset clearing the all-pairs CVD and normal-vision floors in BOTH modes
// (slots 1/4/5/6). Modules past the 4th take the neutral and are identified by their
// chip, the legend, and click-to-highlight — a 9th generated hue would be a lie about
// distinguishability. The chip is also the secondary encoding that makes dark mode's
// worst pair (CVD dE 6.9, in the 6-8 band) legal at all, so it is mandatory.
const HUES = 4
const ticketMeta = {}
for (const [name, mod] of Object.entries(modules)) {
  const slot = order.indexOf(name)
  for (const t of mod.tickets) {
    ticketMeta[t.id] = { m: name, s: slot < HUES ? slot : -1, title: t.title, lane: t.lane, size: t.size, deps: deps[t.id] }
  }
}

const data = {
  recommended,
  recommendedGlobal,
  totalTickets: n,
  sliderMax,
  hues: HUES,
  modules: perModule.map((m) => ({ name: m.name, position: m.position, count: m.tickets.length,
    lanes: m.maxUsefulLanes, waves: m.minWaves, dependsOn: m.dependsOn, slot: m.position - 1 < HUES ? m.position - 1 : -1 })),
  tickets: ticketMeta,
  runner: runnerProfile.roundsByCap,
  global: globalProfile.roundsByCap,
}

// ---- page ------------------------------------------------------------------------
const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  color-scheme:light dark;
  --bg:#f7f7f5; --panel:#fff; --ink:#1a1a18; --muted:#6b6b66; --line:#e2e2dd;
  --accent:#b4552d; --accent-soft:#f4e7e0; --warn:#a8791f;
  --card:#fff; --card-line:#d9d9d3; --ghost:#ecece6; --edge:#a8a89e;
  --m0:#2a78d6; --m1:#eda100; --m2:#e87ba4; --m3:#008300; --mx:#7c7c74;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#16161a; --panel:#1e1e23; --ink:#ecece8; --muted:#9a9a94; --line:#2e2e35;
  --accent:#e08a5f; --accent-soft:#3a2820; --warn:#d6b06a;
  --card:#25252b; --card-line:#3a3a43; --ghost:#232329; --edge:#61616e;
  --m0:#3987e5; --m1:#c98500; --m2:#d55181; --m3:#008300; --mx:#8f8f99;
}}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:32px 20px 72px}
h1{font-size:1.5rem;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0 0 24px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}

.hero{display:flex;flex-wrap:wrap;gap:24px;align-items:stretch}
.hero .big{min-width:150px;padding-right:24px;border-right:1px solid var(--line)}
.hero .big .n{font-size:3rem;line-height:1;font-weight:650;color:var(--accent)}
.hero .big .l{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;margin-top:6px}
.hero .facts{flex:1;min-width:280px;display:flex;flex-direction:column;gap:7px;justify-content:center}
.hero .facts p{margin:0}
.cmd{display:inline-block;background:var(--accent-soft);color:var(--accent);border-radius:6px;padding:3px 9px}

.controls{position:sticky;top:0;z-index:6;display:flex;flex-wrap:wrap;gap:14px 18px;align-items:center}
.controls label{font-weight:600;white-space:nowrap}
.controls input[type=range]{flex:1;min-width:180px;accent-color:var(--accent)}
.pill{background:var(--accent);color:#fff;border-radius:999px;padding:3px 12px;font-weight:650;min-width:2.6em;text-align:center}
.seg{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;background:transparent;color:var(--muted);font:inherit;font-size:.87rem;
  padding:6px 12px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--accent);color:#fff;font-weight:600}
.readout{color:var(--muted);font-size:.9rem;flex-basis:100%}
.readout b{color:var(--ink)}
.readout .save{color:var(--accent);font-weight:650}

.legend{display:flex;flex-wrap:wrap;gap:8px;margin:0}
.legend button{display:flex;align-items:center;gap:7px;border:1px solid var(--line);background:transparent;
  color:var(--ink);font:inherit;font-size:.85rem;border-radius:999px;padding:4px 12px 4px 8px;cursor:pointer}
.legend button[aria-pressed=true]{border-color:var(--accent);background:var(--accent-soft)}
.legend .sw{width:11px;height:11px;border-radius:3px;flex:none}
.legend .ct{color:var(--muted);font-size:.78rem}

.flow{position:relative;display:flex;gap:28px;overflow-x:auto;overflow-y:hidden;padding:20px 2px 6px}
.wave{position:relative;z-index:1;display:flex;flex-direction:column;gap:8px;min-width:186px}
.wave .wl{color:var(--muted);font-size:.74rem;text-transform:uppercase;letter-spacing:.05em}
.tk{background:var(--card);border:1px solid var(--card-line);border-left:3px solid var(--mx);
  border-radius:7px;padding:7px 10px;transition:opacity .12s}
.tk.dim{opacity:.22}
.tk .id{font-size:.85rem;font-weight:650}
.tk .ti{font-size:.82rem;color:var(--muted);margin-top:1px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tk .mt{margin-top:5px;display:flex;gap:5px;flex-wrap:wrap;align-items:center}
.chip{font-size:.69rem;border-radius:4px;padding:1px 6px;color:#fff;font-weight:600;white-space:nowrap}
.tk .mt .meta{font-size:.69rem;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
.slot{border:1px dashed var(--card-line);border-radius:7px;min-height:36px;background:var(--ghost);
  display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:.71rem}
.edges{position:absolute;top:0;left:0;pointer-events:none;z-index:0;overflow:visible}
.edges path{fill:none;stroke:var(--edge);stroke-width:1.75;stroke-linecap:round}
.edges path.cross{stroke-dasharray:5 4}

table{border-collapse:collapse;width:100%;font-size:.88rem}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-size:.76rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
td.num{font-variant-numeric:tabular-nums}
.tag{font-size:.7rem;border-radius:4px;padding:1px 6px;border:1px solid currentColor;color:var(--warn)}
h3{margin:0 0 10px;font-size:.95rem}
.notes ul{margin:0;padding-left:20px;color:var(--muted)}
.notes li{margin:5px 0}
.notes b{color:var(--ink)}
`

const JS = `
var DATA = JSON.parse(document.getElementById('dag-data').textContent);
var slider = document.getElementById('cc');
var pill = document.getElementById('ccv');
var readout = document.getElementById('readout');
var flow = document.getElementById('flow');
var svg = document.getElementById('edges');
var mode = 'global';
var focus = null;

function el(t, c, x){ var e = document.createElement(t); if(c) e.className = c;
  if(x !== undefined) e.textContent = x; return e; }
function colorOf(slot){ return slot < 0 ? 'var(--mx)' : 'var(--m' + slot + ')'; }
function roundsAt(which, c){ var t = DATA[which]; return t[Math.min(c, t.length) - 1] || []; }

function render(){
  var c = +slider.value;
  pill.textContent = c;
  var rounds = roundsAt(mode, c);
  var other = roundsAt(mode === 'runner' ? 'global' : 'runner', c);

  while (flow.firstChild) flow.removeChild(flow.firstChild);
  flow.appendChild(svg);

  var idle = 0;
  rounds.forEach(function(batch, wi){
    idle += Math.max(0, c - batch.length);
    var col = el('div', 'wave');
    col.appendChild(el('div', 'wl', 'Wave ' + (wi + 1) + '  \\u00b7  ' + batch.length + '/' + c));
    batch.forEach(function(id){
      var t = DATA.tickets[id];
      var card = el('div', 'tk');
      card.id = 'tk-' + id;
      card.style.borderLeftColor = colorOf(t.s);
      if (focus && t.m !== focus) card.classList.add('dim');
      card.appendChild(el('div', 'id mono', id));
      if (t.title) card.appendChild(el('div', 'ti', t.title));
      var mt = el('div', 'mt');
      // the module chip is the secondary encoding the palette depends on -- identity
      // must never rest on hue alone, and past the 4th module there IS no hue
      var chip = el('span', 'chip', t.m);
      chip.style.background = colorOf(t.s);
      mt.appendChild(chip);
      if (t.lane) mt.appendChild(el('span', 'meta', 'lane ' + t.lane));
      if (t.size) mt.appendChild(el('span', 'meta', t.size));
      card.appendChild(mt);
      card.title = id + (t.title ? ' \\u2014 ' + t.title : '') + '\\nmodule: ' + t.m +
        (t.deps.length ? '\\nblocked_by: ' + t.deps.join(', ') : '\\nno blockers');
      col.appendChild(card);
    });
    for (var k = batch.length; k < c; k++) col.appendChild(el('div', 'slot', 'idle lane'));
    flow.appendChild(col);
  });

  drawEdges();

  // module-by-module is always the longer of the two, so the cost is runner - global
  var lost = mode === 'runner' ? rounds.length - other.length : other.length - rounds.length;
  var txt = '<b>' + rounds.length + '</b> ticket-rounds at concurrency ' + c +
    ' \\u00b7 <b>' + idle + '</b> idle lane-slots \\u00b7 ';
  if (mode === 'global') {
    txt += lost > 0
      ? 'running module by module would take <b>' + other.length + '</b> \\u2014 <span class="save">' +
        lost + ' rounds (' + Math.round(lost / other.length * 100) + '%) more</span>'
      : 'running module by module takes the same <b>' + other.length + '</b> \\u2014 module boundaries cost nothing here';
  } else {
    txt += lost > 0
      ? '<code>/start-all</code> finishes the same work in <b>' + other.length + '</b> \\u2014 <span class="save">' +
        lost + ' rounds (' + Math.round(lost / rounds.length * 100) + '%) saved by scheduling globally</span>'
      : '<code>/start-all</code> takes the same <b>' + other.length + '</b> \\u2014 module boundaries cost nothing here';
  }
  readout.innerHTML = txt;
}

function drawEdges(){
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  var box = flow.getBoundingClientRect();
  var ox = flow.scrollLeft, oy = flow.scrollTop;
  var w = flow.scrollWidth, h = flow.clientHeight;
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  Object.keys(DATA.tickets).forEach(function(id){
    var t = DATA.tickets[id];
    t.deps.forEach(function(dep){
      var a = document.getElementById('tk-' + dep), b = document.getElementById('tk-' + id);
      if (!a || !b) return;
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var x1 = ra.right - box.left + ox, y1 = ra.top + ra.height / 2 - box.top + oy;
      var x2 = rb.left - box.left + ox, y2 = rb.top + rb.height / 2 - box.top + oy;
      var dx = Math.max(18, (x2 - x1) / 2);
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      // dashed = crosses a module boundary; these edges are invisible in any
      // per-module view, and they are exactly what the module barrier over-enforces
      if (DATA.tickets[dep].m !== t.m) p.setAttribute('class', 'cross');
      p.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' +
        (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2);
      if (focus && t.m !== focus && DATA.tickets[dep].m !== focus) p.setAttribute('opacity', '0.2');
      svg.appendChild(p);
    });
  });
}

document.querySelectorAll('.seg button').forEach(function(b){
  b.addEventListener('click', function(){
    mode = b.dataset.mode;
    document.querySelectorAll('.seg button').forEach(function(o){
      o.setAttribute('aria-pressed', String(o === b)); });
    render();
  });
});
document.querySelectorAll('.legend button').forEach(function(b){
  b.addEventListener('click', function(){
    focus = (focus === b.dataset.mod) ? null : b.dataset.mod;
    document.querySelectorAll('.legend button').forEach(function(o){
      o.setAttribute('aria-pressed', String(o.dataset.mod === focus)); });
    render();
  });
});
slider.addEventListener('input', render);
window.addEventListener('resize', render);
render();
`

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const swatch = (slot) => `background:${slot < 0 ? 'var(--mx)' : `var(--m${slot})`}`

const rows = data.modules.map((m) => `      <tr>
        <td><span class="legend"><span class="sw" style="${swatch(m.slot)};display:inline-block"></span></span> <code>${esc(m.name)}</code>${serial.includes(m.name) ? ' <span class="tag">fully serial</span>' : ''}</td>
        <td class="num">${m.count}</td>
        <td class="num">${m.lanes}</td>
        <td class="num">${m.waves}</td>
        <td>${m.dependsOn.length ? m.dependsOn.map((d) => `<code>${esc(d)}</code>`).join(', ') : '&mdash;'}</td>
      </tr>`).join('\n')

const html = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>PRD execution plan</title>',
  `<style>${CSS}</style>`,
  '</head>',
  '<body>',
  '<div class="wrap">',
  '<h1>PRD execution plan</h1>',
  `<p class="sub">Every ticket under <code>${esc(root)}</code> in one dependency graph, colored by module. Review before Gate 1 sign-off.</p>`,
  '<div class="panel hero">',
  `  <div class="big"><div class="n">${recommendedGlobal}</div><div class="l">recommended concurrency</div></div>`,
  '  <div class="facts">',
  `    <p><b>${data.modules.length}</b> module(s), <b>${n}</b> ticket(s).</p>`,
  `    <p>Start the run with <code class="cmd">/start-all autonomous ${recommendedGlobal}</code></p>`,
  `    <p><code>/start-all</code> schedules every ticket from this one graph, so module boundaries never gate anything. Running module by module instead (<code>/start-milestone</code>) uses at most <b>${recommended}</b> lane(s) &mdash; the widest single module.${serial.length ? ` Fully serial: ${serial.map((s) => `<code>${esc(s)}</code>`).join(', ')} &mdash; a decomposition signal, not a scheduling one.` : ''}</p>`,
  '  </div>',
  '</div>',
  '<div class="panel controls">',
  '  <div class="seg" role="group" aria-label="schedule">',
  '    <button type="button" data-mode="global" aria-pressed="true">/start-all (global DAG)</button>',
  '    <button type="button" data-mode="runner" aria-pressed="false">/start-milestone (module by module)</button>',
  '  </div>',
  '  <label for="cc">concurrency</label>',
  `  <input id="cc" type="range" min="1" max="${sliderMax}" value="${recommendedGlobal}" step="1">`,
  `  <span class="pill" id="ccv">${recommendedGlobal}</span>`,
  '  <span class="readout" id="readout"></span>',
  '</div>',
  '<div class="panel">',
  '  <h3>Modules <span style="font-weight:400;color:var(--muted)">&mdash; click to highlight</span></h3>',
  '  <div class="legend">',
  data.modules.map((m) => `    <button type="button" data-mod="${esc(m.name)}" aria-pressed="false"><span class="sw" style="${swatch(m.slot)}"></span><span class="mono">${esc(m.name)}</span><span class="ct">${m.count} tickets &middot; ${m.lanes} lane${m.lanes === 1 ? '' : 's'}</span></button>`).join('\n'),
  '  </div>',
  '</div>',
  '<div class="panel"><div class="flow" id="flow"><svg class="edges" id="edges"></svg></div></div>',
  '<div class="panel">',
  '  <h3>Modules in dispatch order</h3>',
  '  <table>',
  '    <thead><tr><th>Module</th><th>Tickets</th><th>Max useful lanes</th><th>Waves</th><th>Runs after</th></tr></thead>',
  `    <tbody>\n${rows}\n    </tbody>`,
  '  </table>',
  '</div>',
  '<div class="panel notes">',
  '  <h3>How to read this</h3>',
  '  <ul>',
  '    <li><b>Two schedules, one graph.</b> <em>/start-all</em> schedules every ticket from this graph, gated only by <code>blocked_by</code> &mdash; module boundaries never gate anything. <em>/start-milestone</em> runs one module at a time, so a barrier sits between modules and <code>concurrency</code> fans out only within the one running. Both are executable; the difference is what running module by module costs on this decomposition.</li>',
  '    <li><b>Dashed edges cross a module boundary.</b> They are real <code>blocked_by</code> dependencies, and <code>/start-all</code> enforces them directly. Running module by module additionally serializes tickets with <em>no</em> edge between them at all, which is where the extra rounds come from.</li>',
  '    <li><b>The DAG is live during a run.</b> <code>/start-all</code> reloads it every few settled tickets, so a ticket added while it runs is published, scheduled, and rendered here on the next reload. A dependency added to a ticket that already started cannot be applied retroactively &mdash; the run escalates it instead of pretending it was enforced.</li>',
  '    <li><b>Max useful lanes</b> is the lowest concurrency that still reaches the minimum round count. Above it lanes sit idle; below it, independent tickets are serialized.</li>',
  '    <li><b>Uniform-duration model &mdash; read the wave count as a ceiling, not a forecast.</b> Every ticket counts as one round and a wave ends when all its lanes finish. Measured on a real 6-ticket run (catalog issue #75, 2026-07-27): the model predicted <b>3.0&times;</b> going from 1 lane to 4, and the run delivered <b>2.21&times;</b> &mdash; the model over-predicted by 36%. Two structural reasons: ticket durations vary, so a wave is paced by its slowest lane; and the <b>deliver step is serialized behind a mutex</b>, so lanes that finish building together then queue to merge. Speed-up grows with lane count more slowly than the wave count suggests.</li>',
  '    <li><b>A fully serial module is a decomposition problem, not a scheduling one.</b> Its tickets form one <code>blocked_by</code> chain &mdash; revisit the file-scope split before signing off.</li>',
  `    <li><b>Color covers the first ${HUES} modules only.</b> Cards from any two modules can sit side by side, so the palette must clear the all-pairs contrast floors; ${HUES} is the largest set that does in both light and dark. Module ${HUES + 1} onward take the neutral swatch &mdash; identity comes from the chip on every card, the legend, and click-to-highlight, never from hue alone.</li>`,
  '    <li><b>Caps that still apply at run time:</b> <code>supervised</code> mode forces concurrency to 1, and the harness caps concurrent agents at <code>min(16, cores - 2)</code> on the machine that runs it. That machine is unknown here, so it is shown as a formula rather than a number.</li>',
  '    <li>Regenerate with <code>node .codex/scripts/dag-report.mjs</code> after any ticket <code>blocked_by</code> change. Output is deterministic &mdash; an unchanged DAG rewrites an identical file.</li>',
  '  </ul>',
  '</div>',
  '</div>',
  `<script id="dag-data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`,
  `<script>${JS}</script>`,
  '</body>',
  '</html>',
].join('\n') + '\n'

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, html)

// ---- stdout summary (the agent relays this; nobody has to open the page) ----------
const rr = runnerProfile.roundsByCap[Math.min(recommendedGlobal, capMax) - 1].length
const gr = globalProfile.roundsByCap[Math.min(recommendedGlobal, capMax) - 1].length
console.log(`execution plan: ${data.modules.length} module(s), ${n} ticket(s) — /start-all schedules them all from one DAG`)
for (const m of perModule) {
  const flags = []
  if (m.maxUsefulLanes === recommended && perModule.length > 1) flags.push('widest')
  if (m.maxUsefulLanes === 1 && m.tickets.length > 1) flags.push('fully serial')
  const d = m.dependsOn.length ? `  <- after: ${m.dependsOn.join(', ')}` : ''
  console.log(`  ${m.position}. ${m.name}  (${m.tickets.length} ticket(s))  ` +
    `${m.maxUsefulLanes} lane(s) / ${m.minWaves} wave(s)${flags.length ? '  [' + flags.join(', ') + ']' : ''}${d}`)
}
console.log(`recommended concurrency: ${recommendedGlobal}   ->   /start-all autonomous ${recommendedGlobal}`)
console.log(`at that concurrency: ${gr} ticket-rounds via /start-all (global DAG); ${rr} module-by-module via /start-milestone` +
  (rr > gr ? `  (running module by module costs ${rr - gr} more rounds, ${Math.round((rr - gr) / rr * 100)}%)` : '  (module boundaries cost nothing here)'))
console.log(`wrote ${outShown}`)
console.log('DAG-REPORT-JSON: ' + JSON.stringify({
  out: outShown,
  recommendedConcurrency: recommendedGlobal,
  recommendedConcurrencyPerModule: recommended,
  totalTickets: n,
  schedules: { atRecommended: { runnerRounds: rr, globalRounds: gr }, runnerMinRounds: runnerProfile.minRounds, globalMinRounds: globalProfile.minRounds },
  modules: perModule.map((m) => ({ name: m.name, position: m.position, tickets: m.tickets.length,
    maxUsefulLanes: m.maxUsefulLanes, minWaves: m.minWaves, dependsOn: m.dependsOn })),
}))
