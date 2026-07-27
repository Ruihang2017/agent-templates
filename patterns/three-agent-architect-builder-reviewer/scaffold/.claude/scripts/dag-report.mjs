#!/usr/bin/env node
// dag-report.mjs — human-facing view of the execution plan, for Gate 1.
//
// milestone-dag.mjs answers "what order does the runner dispatch in". This answers the
// question a human has at sign-off: how many execution lanes does this decomposition
// actually have, where is it serial, and what `concurrency` is worth passing to
// /start-all? Both read the same graph via dag-core.mjs.
//
// Usage: node .claude/scripts/dag-report.mjs [prd-root] [--out <path>]
//        prd-root defaults to docs/prd; --out defaults to <prd-root>/dag.html
// Output: a self-contained HTML page (no CDN, no network), a text summary on stdout,
//         and a final machine-readable line:
//   DAG-REPORT-JSON: {"out":"...","recommendedConcurrency":N,"modules":[...]}
// Exit 1 on the same spec defects milestone-dag.mjs rejects: missing root, no modules,
// a blocked_by referencing an unknown ticket, or a dependency cycle.
//
// The page is DETERMINISTIC — no timestamps, no machine core count. Re-running on an
// unchanged docs/prd rewrites a byte-identical file, so it can be committed and
// reviewed in the breakdown PR without churning the diff on every run.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildPlan, intraModuleDeps, laneProfile } from './dag-core.mjs'

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

// ---- compute the lane profile per module -----------------------------------------
// Modules run SEQUENTIALLY (start-all awaits each run-milestone), so lanes are an
// intra-module property and the PRD-wide recommendation is the max across modules —
// never the sum.
const mods = []
for (let i = 0; i < plan.order.length; i++) {
  const name = plan.order[i]
  const mod = plan.modules[name]
  const deps = intraModuleDeps(mod)
  const profile = laneProfile(plan.ticketOrder[name], (id) => deps[id])
  const meta = Object.fromEntries(
    mod.tickets.map((t) => [t.id, { title: t.title, lane: t.lane, size: t.size, deps: deps[t.id] }]),
  )
  mods.push({
    name,
    position: i + 1,
    dependsOn: [...mod.dependsOn].sort(),
    order: plan.ticketOrder[name],
    tickets: meta,
    roundsByCap: profile.roundsByCap,
    minWaves: profile.minWaves,
    maxUsefulLanes: profile.maxUsefulLanes,
    peakLanes: profile.peakLanes,
  })
}

const recommended = mods.reduce((m, x) => Math.max(m, x.maxUsefulLanes), 1)
const totalTickets = mods.reduce((n, x) => n + x.order.length, 0)
const sliderMax = Math.min(32, Math.max(recommended + 2, ...mods.map((m) => m.order.length)))
const widest = mods.filter((m) => m.maxUsefulLanes === recommended).map((m) => m.name)
const serial = mods.filter((m) => m.maxUsefulLanes === 1 && m.order.length > 1).map((m) => m.name)

const data = { recommended, totalTickets, sliderMax, widest, serial, modules: mods }

// ---- page ------------------------------------------------------------------------
const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#f7f7f5; --panel:#fff; --ink:#1a1a18; --muted:#6b6b66; --line:#e2e2dd;
  --accent:#b4552d; --accent-soft:#f4e7e0; --ok:#3f7d58; --warn:#a8791f;
  --card:#fff; --card-line:#d9d9d3; --ghost:#ecece6; --edge:#a8a89e;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#16161a; --panel:#1e1e23; --ink:#ecece8; --muted:#9a9a94; --line:#2e2e35;
  --accent:#e08a5f; --accent-soft:#3a2820; --ok:#7fb894; --warn:#d6b06a;
  --card:#25252b; --card-line:#3a3a43; --ghost:#232329; --edge:#61616e;
}}
html{color-scheme:light dark}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:32px 20px 72px}
h1{font-size:1.5rem;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0 0 24px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

.hero{display:flex;flex-wrap:wrap;gap:20px;align-items:stretch;
  background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:20px}
.hero .big{min-width:150px;padding-right:20px;border-right:1px solid var(--line)}
.hero .big .n{font-size:3rem;line-height:1;font-weight:650;color:var(--accent)}
.hero .big .l{color:var(--muted);font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;margin-top:6px}
.hero .facts{flex:1;min-width:260px;display:flex;flex-direction:column;gap:8px;justify-content:center}
.hero .facts p{margin:0}
.cmd{display:inline-block;background:var(--accent-soft);color:var(--accent);
  border-radius:6px;padding:4px 9px;font-size:.9rem}

.controls{position:sticky;top:0;z-index:5;background:var(--panel);border:1px solid var(--line);
  border-radius:12px;padding:14px 18px;margin-bottom:24px;
  display:flex;flex-wrap:wrap;gap:16px;align-items:center}
.controls label{font-weight:600;white-space:nowrap}
.controls input[type=range]{flex:1;min-width:200px;accent-color:var(--accent)}
.pill{background:var(--accent);color:#fff;border-radius:999px;padding:3px 12px;font-weight:650;
  min-width:2.6em;text-align:center}
.readout{color:var(--muted);font-size:.9rem}
.readout b{color:var(--ink)}
.readout.warn b{color:var(--warn)}

.mod{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:18px;margin-bottom:16px}
.mod h2{font-size:1.05rem;margin:0;display:flex;flex-wrap:wrap;gap:10px;align-items:baseline}
.pos{color:var(--muted);font-variant-numeric:tabular-nums}
.badge{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;
  border-radius:5px;padding:2px 7px;font-weight:650}
.badge.widest{background:var(--accent-soft);color:var(--accent)}
.badge.serial{background:transparent;color:var(--warn);border:1px solid currentColor}
.deps{color:var(--muted);font-size:.85rem;margin:6px 0 0}
.stats{display:flex;flex-wrap:wrap;gap:22px;margin:12px 0 4px;
  padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.stat .v{font-size:1.25rem;font-weight:650;font-variant-numeric:tabular-nums}
.stat .k{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
.stat .v.idle{color:var(--warn)}

/* overflow-y must be pinned: with overflow-x:auto the browser promotes a visible
   overflow-y to auto, and the absolutely-positioned edge layer then feeds its own
   scrollbar (svg sized from scrollHeight -> overflow -> taller scrollHeight). */
.waves{position:relative;display:flex;gap:26px;overflow-x:auto;overflow-y:hidden;padding:18px 2px 4px}
.wave{position:relative;z-index:1;display:flex;flex-direction:column;gap:8px;min-width:172px}
.wave .wl{color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;
  padding-bottom:2px}
.tk{background:var(--card);border:1px solid var(--card-line);border-left:3px solid var(--accent);
  border-radius:7px;padding:8px 10px}
.tk .id{font-size:.86rem;font-weight:650}
.tk .ti{font-size:.83rem;color:var(--muted);margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tk .mt{margin-top:5px;display:flex;gap:6px;flex-wrap:wrap}
.tk .mt span{font-size:.7rem;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
.slot{border:1px dashed var(--card-line);border-radius:7px;min-height:38px;background:var(--ghost);
  display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:.72rem}
.edges{position:absolute;top:0;left:0;pointer-events:none;z-index:0;overflow:visible}
.edges path{fill:none;stroke:var(--edge);stroke-width:1.75;stroke-linecap:round}

.notes{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-top:24px}
.notes h3{margin:0 0 8px;font-size:.95rem}
.notes ul{margin:0;padding-left:20px;color:var(--muted)}
.notes li{margin:4px 0}
.notes b{color:var(--ink)}
`

const JS = `
var DATA = JSON.parse(document.getElementById('dag-data').textContent);
var slider = document.getElementById('cc');
var pill = document.getElementById('ccv');
var readout = document.getElementById('readout');

function el(tag, cls, txt){ var e = document.createElement(tag); if(cls) e.className = cls;
  if(txt !== undefined) e.textContent = txt; return e; }

// rounds at concurrency c; caps above the ticket count behave like the ticket count
function roundsAt(m, c){ return m.roundsByCap[Math.min(c, m.roundsByCap.length) - 1] || []; }

function renderModule(m){
  var host = document.getElementById('m-' + m.position);
  var c = +slider.value;
  var rounds = roundsAt(m, c);
  var busiest = 0, idle = 0;
  for (var i = 0; i < rounds.length; i++){
    busiest = Math.max(busiest, rounds[i].length);
    idle += Math.max(0, c - rounds[i].length);
  }
  host.querySelector('[data-k=waves]').textContent = rounds.length;
  host.querySelector('[data-k=busy]').textContent = busiest;
  var idleEl = host.querySelector('[data-k=idle]');
  idleEl.textContent = idle;
  idleEl.classList.toggle('idle', idle > 0);

  var waves = host.querySelector('.waves');
  var svg = waves.querySelector('.edges');
  waves.querySelectorAll('.wave').forEach(function(w){ w.remove(); });

  rounds.forEach(function(batch, wi){
    var col = el('div', 'wave');
    col.appendChild(el('div', 'wl', 'Wave ' + (wi + 1) + '  \\u00b7  ' + batch.length + '/' + c));
    batch.forEach(function(id){
      var t = m.tickets[id];
      var card = el('div', 'tk');
      card.id = 'tk-' + m.position + '-' + id;
      card.appendChild(el('div', 'id mono', id));
      if (t.title) card.appendChild(el('div', 'ti', t.title));
      var mt = el('div', 'mt');
      if (t.lane) mt.appendChild(el('span', null, 'lane ' + t.lane));
      if (t.size) mt.appendChild(el('span', null, t.size));
      if (t.deps.length) mt.appendChild(el('span', null, 'after ' + t.deps.join(', ')));
      if (mt.children.length) card.appendChild(mt);
      card.title = id + (t.title ? ' \\u2014 ' + t.title : '') +
        (t.deps.length ? '\\nblocked_by: ' + t.deps.join(', ') : '\\nno intra-module blockers');
      col.appendChild(card);
    });
    // ghost slots make "I set concurrency too high" visible instead of theoretical
    for (var k = batch.length; k < c; k++) col.appendChild(el('div', 'slot', 'idle lane'));
    waves.appendChild(col);
  });
  drawEdges(m, waves, svg);
}

function drawEdges(m, waves, svg){
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  var box = waves.getBoundingClientRect();
  var ox = waves.scrollLeft, oy = waves.scrollTop;
  // height from clientHeight, not scrollHeight: sizing the overlay from the scroll
  // extent it contributes to is a feedback loop that grows a phantom scrollbar
  var w = waves.scrollWidth, h = waves.clientHeight;
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  m.order.forEach(function(id){
    m.tickets[id].deps.forEach(function(dep){
      var a = document.getElementById('tk-' + m.position + '-' + dep);
      var b = document.getElementById('tk-' + m.position + '-' + id);
      if (!a || !b) return;
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var x1 = ra.right - box.left + ox, y1 = ra.top + ra.height / 2 - box.top + oy;
      var x2 = rb.left - box.left + ox, y2 = rb.top + rb.height / 2 - box.top + oy;
      var dx = Math.max(18, (x2 - x1) / 2);
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 +
        ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2);
      svg.appendChild(p);
    });
  });
}

function renderAll(){
  var c = +slider.value;
  pill.textContent = c;
  var total = 0, idle = 0;
  DATA.modules.forEach(function(m){
    var rounds = roundsAt(m, c);
    total += rounds.length;
    for (var i = 0; i < rounds.length; i++) idle += Math.max(0, c - rounds[i].length);
    renderModule(m);
  });
  var over = c > DATA.recommended;
  var under = c < DATA.recommended;
  readout.className = 'readout' + (over || under ? ' warn' : '');
  readout.innerHTML = '<b>' + total + '</b> ticket-rounds end to end \\u00b7 <b>' + idle +
    '</b> idle lane-slots' +
    (over ? ' \\u00b7 <b>above the useful maximum \\u2014 the extra lanes never fill</b>'
     : under ? ' \\u00b7 <b>below ' + DATA.recommended + ' \\u2014 independent tickets are being serialized</b>'
     : ' \\u00b7 <b>this is the recommended setting</b>');
}

slider.addEventListener('input', renderAll);
window.addEventListener('resize', renderAll);
renderAll();
`

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const moduleHtml = (m) => {
  const badges = []
  if (m.maxUsefulLanes === recommended && mods.length > 1) badges.push('<span class="badge widest">widest</span>')
  if (m.maxUsefulLanes === 1 && m.order.length > 1) badges.push('<span class="badge serial">fully serial</span>')
  return [
    `<section class="mod" id="m-${m.position}">`,
    '  <h2>',
    `    <span class="pos">${m.position}.</span> <span class="mono">${esc(m.name)}</span>`,
    `    ${badges.join(' ')}`,
    '  </h2>',
    `  <p class="deps">${m.dependsOn.length
      ? 'runs after: ' + m.dependsOn.map((d) => `<code>${esc(d)}</code>`).join(', ')
      : 'no cross-module blockers'}</p>`,
    '  <div class="stats">',
    `    <div class="stat"><div class="v">${m.order.length}</div><div class="k">tickets</div></div>`,
    '    <div class="stat"><div class="v" data-k="waves">-</div><div class="k">waves</div></div>',
    '    <div class="stat"><div class="v" data-k="busy">-</div><div class="k">peak lanes busy</div></div>',
    '    <div class="stat"><div class="v" data-k="idle">-</div><div class="k">idle lane-slots</div></div>',
    `    <div class="stat"><div class="v">${m.maxUsefulLanes}</div><div class="k">max useful lanes</div></div>`,
    '  </div>',
    '  <div class="waves"><svg class="edges"></svg></div>',
    '</section>',
  ].join('\n')
}

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
  `<p class="sub">Generated from ticket <code>blocked_by</code> frontmatter under <code>${esc(root)}</code>. Review this before Gate 1 sign-off.</p>`,
  '<div class="hero">',
  `  <div class="big"><div class="n">${recommended}</div><div class="l">recommended concurrency</div></div>`,
  '  <div class="facts">',
  `    <p><b>${mods.length}</b> module(s), <b>${totalTickets}</b> ticket(s). Modules run <b>sequentially</b>; lanes are intra-module only.</p>`,
  `    <p>Start the run with <code class="cmd">/start-all autonomous ${recommended}</code></p>`,
  `    <p>${widest.length ? 'Widest module(s): ' + widest.map((n) => `<code>${esc(n)}</code>`).join(', ') + '.' : ''}${serial.length ? ' Fully serial: ' + serial.map((n) => `<code>${esc(n)}</code>`).join(', ') + ' &mdash; a decomposition signal, not a scheduling one.' : ''}</p>`,
  '  </div>',
  '</div>',
  '<div class="controls">',
  '  <label for="cc">concurrency</label>',
  `  <input id="cc" type="range" min="1" max="${sliderMax}" value="${recommended}" step="1">`,
  `  <span class="pill" id="ccv">${recommended}</span>`,
  '  <span class="readout" id="readout"></span>',
  '</div>',
  mods.map(moduleHtml).join('\n'),
  '<div class="notes">',
  '  <h3>How to read this</h3>',
  '  <ul>',
  '    <li><b>Modules never overlap.</b> <code>start-all</code> awaits each <code>run-milestone</code> in DAG order, so cross-module <code>blocked_by</code> sets <em>order</em>, never parallelism. The recommendation is the <em>max</em> across modules, never the sum.</li>',
  '    <li><b>Max useful lanes</b> is the lowest concurrency that still reaches the module\'s minimum wave count. Above it, lanes sit idle; below it, independent tickets get serialized.</li>',
  '    <li><b>Uniform-duration model.</b> Every ticket counts as one round and a wave ends when all its lanes finish. Real lanes finish at different times and the scheduler refills a free lane immediately, so real wall-clock is <em>at most</em> the waves shown.</li>',
  '    <li><b>A fully serial module is a decomposition problem, not a scheduling one.</b> It means its tickets form one <code>blocked_by</code> chain &mdash; revisit the file-scope split before signing off.</li>',
  '    <li><b>Caps that still apply at run time:</b> <code>supervised</code> mode forces concurrency to 1, and the harness caps concurrent agents at <code>min(16, cores - 2)</code> on the machine that runs it. That machine is unknown here, so it is shown as a formula rather than a number.</li>',
  '    <li>Regenerate with <code>node .claude/scripts/dag-report.mjs</code> after any ticket <code>blocked_by</code> change. Output is deterministic &mdash; an unchanged DAG rewrites an identical file.</li>',
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
console.log(`execution plan: ${mods.length} module(s), ${totalTickets} ticket(s) — modules run sequentially`)
for (const m of mods) {
  const flags = []
  if (m.maxUsefulLanes === recommended && mods.length > 1) flags.push('widest')
  if (m.maxUsefulLanes === 1 && m.order.length > 1) flags.push('fully serial')
  const deps = m.dependsOn.length ? `  <- after: ${m.dependsOn.join(', ')}` : ''
  console.log(
    `  ${m.position}. ${m.name}  (${m.order.length} ticket(s))  ` +
    `${m.maxUsefulLanes} lane(s) / ${m.minWaves} wave(s)${flags.length ? '  [' + flags.join(', ') + ']' : ''}${deps}`,
  )
}
console.log(`recommended concurrency: ${recommended}   ->   /start-all autonomous ${recommended}`)
console.log(`wrote ${outShown}`)
console.log('DAG-REPORT-JSON: ' + JSON.stringify({
  out: outShown,
  recommendedConcurrency: recommended,
  totalTickets,
  modules: mods.map((m) => ({
    name: m.name,
    position: m.position,
    tickets: m.order.length,
    maxUsefulLanes: m.maxUsefulLanes,
    minWaves: m.minWaves,
    dependsOn: m.dependsOn,
  })),
}))
