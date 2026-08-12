#!/usr/bin/env node
// build-site.mjs — generates the catalog's GitHub Pages site from the catalog's own
// data (patterns/*/README.md + package.json). Never hand-edit the output: the page
// must not be able to drift from the pattern metadata.
//
// Usage: node scripts/build-site.mjs [--out <dir>]     (default: site/)
// Output: <out>/index.html (self-contained) + <out>/.nojekyll
//
// Style: clay-morphism per the approved hi-fi mock on catalog issue #19 — layered
// clay shadows (outer drop + inset top highlight + inset bottom ink), Baloo 2 +
// Nunito, five build-time palettes with mint baked as default, pure-CSS clay icons
// (no emoji, no icon fonts). The mock is the source of truth for colors/shadows/
// spacing; the pattern catalog stays the source of truth for all copy.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The lane demo's wave breakdown is computed by the SAME scheduler model the runner and
// dag-report.mjs use — never hand-authored — so the site cannot advertise a schedule the
// pipeline would not actually produce.
import { simulate } from '../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/dag-core.mjs'
// The hub pane's brief anatomy and wave board are rendered from the REAL briefs committed
// at testbed/hub-rehearsal/, parsed with the pattern's own parser. The page therefore
// cannot advertise a brief shape the validator would reject, or a wave order the driver
// would not schedule (catalog issue #165).
import { parseBrief, readyBriefs } from '../patterns/hub-and-spoke-orchestrator-executors/scaffold/.claude/scripts/brief.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const outIx = argv.indexOf('--out')
const OUT = outIx !== -1 && argv[outIx + 1] ? argv[outIx + 1] : join(ROOT, 'site')

const GITHUB = 'https://github.com/Ruihang2017/agent-templates'
const NPM = 'https://www.npmjs.com/package/agent-templates'
const QUICKSTART = 'npx agent-templates@latest adopt three-agent-architect-builder-reviewer .'
const UPDATE = QUICKSTART + ' --force'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const strip = (s) => String(s).replace(/\*\*/g, '').replace(/`/g, '').trim()

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

function parsePattern(dir) {
  const path = join(ROOT, 'patterns', dir, 'README.md')
  if (!existsSync(path)) return null
  const md = readFileSync(path, 'utf8')
  const pick = (re) => (md.match(re) || [])[1] || ''

  const title = strip(pick(/^# Pattern: (.+)$/m)) || dir
  const statusRaw = strip(pick(/\|\s*\*\*Status\*\*\s*\|\s*([^|]+)\|/))
  const status = (statusRaw.match(/[a-z]+/) || ['proposed'])[0]
  const asOf = strip(pick(/\|\s*\*\*As-of date\*\*\s*\|\s*([^|]+)\|/))

  // the one-line topology summary: first plain paragraph after the metadata table
  let summary = ''
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l || l.startsWith('#') || l.startsWith('|') || l.startsWith('<!--')) continue
    summary = strip(l)
    break
  }

  // model/effort rows from §3
  const roles = []
  const sec3 = md.split(/^## 3\. Model \+ effort[^\n]*$/m)[1]
  if (sec3) {
    for (const row of sec3.split(/^## /m)[0].split('\n')) {
      const m = row.match(/^\|\s*([A-Z][^|]*?)\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|/)
      if (m && !/^Role/.test(m[1])) roles.push({ role: strip(m[1]), model: strip(m[2]), effort: m[3] })
    }
  }

  return { dir, title, status, asOf, summary, roles, commands: parseCommands(dir) }
}

// Runtime commands/skills are the pattern's user-facing surface. Their frontmatter is
// the single source of truth. Rendering them here
// (and gating on them in E2E) is what keeps the site from silently omitting a shipped
// command the way /start-all was once missing (catalog issue #35).
function parseCommands(dir) {
  const fmField = (fm, name) => ((fm.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'm')) || [])[1] || '').trim()
  // Runtime-compatible integration commands (integrations/<name>/.claude/commands) are
  // installed for every Claude pattern by adopt.mjs, so they are part of that runtime's
  // surface and belong on the card. Omitting them is the issue #35 hole above, reopened
  // through a different directory (issue #124).
  const intRoot = join(ROOT, 'integrations')
  const patternCommandDir = join(ROOT, 'patterns', dir, 'scaffold', '.claude', 'commands')
  const sources = [
    { cdir: patternCommandDir, integration: '' },
    ...(existsSync(patternCommandDir) && existsSync(intRoot)
      ? readdirSync(intRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(intRoot, d.name, '.claude', 'commands')))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((d) => ({ cdir: join(intRoot, d.name, '.claude', 'commands'), integration: d.name }))
      : []),
  ]
  const out = []
  for (const { cdir, integration } of sources) {
    if (!existsSync(cdir)) continue
    for (const f of readdirSync(cdir).filter((n) => n.endsWith('.md')).sort()) {
      const md = readFileSync(join(cdir, f), 'utf8')
      const fm = (md.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
      out.push({
        name: '/' + f.replace(/\.md$/, ''),
        hint: fmField(fm, 'argument-hint'),
        description: fmField(fm, 'description'),
        integration,
      })
    }
  }
  const skillsRoot = join(ROOT, 'patterns', dir, 'scaffold', '.agents', 'skills')
  if (existsSync(skillsRoot)) {
    for (const skillDir of readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(skillsRoot, skillDir.name, 'SKILL.md')
      if (!existsSync(path)) continue
      const md = readFileSync(path, 'utf8')
      const fm = (md.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
      out.push({
        name: '$' + (fmField(fm, 'name') || skillDir.name),
        hint: '',
        description: fmField(fm, 'description'),
        integration: '',
      })
    }
  }
  return out
}

const patterns = readdirSync(join(ROOT, 'patterns'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, 'patterns', d.name, 'scaffold')))
  .map((d) => parsePattern(d.name))
  .filter(Boolean)

// ---------------------------------------------------------------------------
// Theme palettes, distilled from the approved mock (issue #19). The mock names
// them cream / mint / lavender / sakura / sky; mint is the approved default.
// Swapping the palette is a build-time constant change — no runtime switcher.
// amb/ins/flt are bare R,G,B triplets consumed via rgba(var(--amb), a).
// ---------------------------------------------------------------------------
const THEMES = {
  cream:    { page: '#ffeecb', heroA: '#fbd2b0', heroB: '#f5b98f', heroInk: 'rgba(190,110,60,0.18)', heroAmb: 'rgba(199,141,109,0.32)', heroTitle: '#5a3520', heroBody: '#8a5a3d', card: '#fdf4e6', pill: '#fff7e9', ink: '#4a3020', sub: '#7b5a42', mut: '#a3805f', code: '#7b4a2a', amb: '199,141,109', ins: '214,160,120', flt: '150,90,60' },
  mint:     { page: '#e0f3e0', heroA: '#c3e6bd', heroB: '#a3d49a', heroInk: 'rgba(40,110,50,0.18)', heroAmb: 'rgba(110,160,120,0.35)', heroTitle: '#2f5a30', heroBody: '#4f7a52', card: '#f0f9ec', pill: '#f8fdf5', ink: '#2f4a28', sub: '#567a50', mut: '#7fa077', code: '#4f6b3a', amb: '110,150,115', ins: '160,195,155', flt: '80,120,85' },
  lavender: { page: '#f0e7fa', heroA: '#ddcbf3', heroB: '#c4abe8', heroInk: 'rgba(90,50,140,0.16)', heroAmb: 'rgba(140,110,180,0.35)', heroTitle: '#46306b', heroBody: '#6b5490', card: '#f6f1fc', pill: '#fbf9fe', ink: '#3f2f5c', sub: '#6b5a86', mut: '#9284ab', code: '#5f4a8a', amb: '130,110,165', ins: '185,165,215', flt: '100,80,135' },
  sakura:   { page: '#fde7ee', heroA: '#f9c9d7', heroB: '#f3abc2', heroInk: 'rgba(180,60,100,0.15)', heroAmb: 'rgba(190,120,140,0.35)', heroTitle: '#6b2f45', heroBody: '#96556b', card: '#fcf1f5', pill: '#fef8fa', ink: '#5c2f40', sub: '#86566a', mut: '#ab8494', code: '#8a4a62', amb: '180,120,140', ins: '215,165,185', flt: '150,80,105' },
  sky:      { page: '#e3eefa', heroA: '#c8ddf4', heroB: '#a8c7ec', heroInk: 'rgba(50,90,150,0.15)', heroAmb: 'rgba(110,140,180,0.35)', heroTitle: '#2c4a6b', heroBody: '#4f6f96', card: '#eff5fc', pill: '#f7fafe', ink: '#2b3f5c', sub: '#52698a', mut: '#8095ad', code: '#3f5a80', amb: '100,130,170', ins: '155,180,215', flt: '70,100,140' },
}
const THEME = THEMES.mint

// Status chips: trialed/adopted/proposed use the mock's yellow/green("stable")/
// pink("experimental") recipes; deprecated (catalog-only status) is a neutral clay.
const STATUS_CHIP = {
  trialed:    { chip: 'background:linear-gradient(180deg,#f9d66e,#f0c14a);color:#6b4a15;box-shadow:inset 0 2px 2px rgba(255,255,255,0.6),inset 0 -3px 4px rgba(180,120,20,0.3),0 5px 10px rgba(180,130,60,0.3)', dot: 'inset -1px -1px 2px rgba(180,120,20,0.4)' },
  proposed:   { chip: 'background:linear-gradient(180deg,#f792ab,#ef6f92);color:#fff;text-shadow:0 1px 2px rgba(170,30,80,0.35);box-shadow:inset 0 2px 2px rgba(255,255,255,0.5),inset 0 -3px 4px rgba(170,30,80,0.3),0 5px 10px rgba(199,100,110,0.3)', dot: 'inset -1px -1px 2px rgba(170,30,80,0.35)' },
  adopted:    { chip: 'background:linear-gradient(180deg,#b3dcab,#98cb8e);color:#fff;text-shadow:0 1px 2px rgba(30,90,40,0.35);box-shadow:inset 0 2px 2px rgba(255,255,255,0.5),inset 0 -3px 4px rgba(30,100,40,0.28),0 5px 10px rgba(120,150,100,0.3)', dot: 'inset -1px -1px 2px rgba(30,90,40,0.35)' },
  deprecated: { chip: 'background:linear-gradient(180deg,#cfc4b4,#b8aa96);color:#fff;text-shadow:0 1px 2px rgba(110,90,60,0.35);box-shadow:inset 0 2px 2px rgba(255,255,255,0.5),inset 0 -3px 4px rgba(110,90,60,0.3),0 5px 10px rgba(150,130,100,0.3)', dot: 'inset -1px -1px 2px rgba(110,90,60,0.35)' },
}

const ROLE_DOT = {
  Architect: ['#a98fd6', 'rgba(80,40,140,0.3)'],
  Builder: ['#f28ba3', 'rgba(170,30,80,0.3)'],
  Reviewer: ['#8fb4e6', 'rgba(40,80,150,0.3)'],
}
const roleDot = (r) => ROLE_DOT[Object.keys(ROLE_DOT).find((k) => r.startsWith(k))] || ['#f2c44e', 'rgba(180,120,20,0.35)']

// --- lane demo -------------------------------------------------------------
// A miniature of docs/prd/dag.html so the page can SHOW what one lane vs many looks
// like. Same module colors as the real page (validated all-pairs in light and dark,
// which the site's decorative pastels are not: green/pink sit at CVD dE 4.5 and
// green/yellow at normal-vision 11.5 — fine as ornament, unusable as data). Every card
// still carries its module name, so identity never rests on hue alone.
const DEMO_MODULES = [
  { name: '01-core', color: '#2a78d6' },
  { name: '02-api', color: '#eda100' },
  { name: '03-jobs', color: '#e87ba4' },
  { name: '04-docs', color: '#008300' },
]
const DEMO_TICKETS = [
  ['0101', '01-core', []], ['0102', '01-core', []],
  ['0103', '01-core', ['0101']], ['0104', '01-core', ['0102']],
  ['0105', '01-core', ['0103', '0104']],
  ['0201', '02-api', ['0105']], ['0202', '02-api', ['0105']],
  ['0203', '02-api', ['0105']], ['0204', '02-api', ['0105']],
  ['0205', '02-api', ['0201']],
  ['0301', '03-jobs', []], ['0302', '03-jobs', ['0301']], ['0303', '03-jobs', ['0302']],
  ['0401', '04-docs', []], ['0402', '04-docs', []],
]
const DEMO_LANES = [1, 2, 4, 6]
const demoDeps = Object.fromEntries(DEMO_TICKETS.map(([id, , d]) => [id, d]))
const demoIds = DEMO_TICKETS.map(([id]) => id)
const demoModuleOf = Object.fromEntries(DEMO_TICKETS.map(([id, m]) => [id, m]))
const demoColorOf = (id) => (DEMO_MODULES.find((m) => m.name === demoModuleOf[id]) || {}).color || '#7c7c74'
// rounds[cap] computed at BUILD time by dag-core.simulate — the runner's own model
const DEMO_ROUNDS = Object.fromEntries(DEMO_LANES.map((c) => [c, simulate(demoIds, (id) => demoDeps[id], c)]))
const DEMO_MIN = DEMO_ROUNDS[DEMO_LANES[DEMO_LANES.length - 1]].length

const demoWaveHtml = (cap) => DEMO_ROUNDS[cap].map((batch, i) => `
        <div class="lw">
          <span class="lw-h">wave ${i + 1} &middot; ${batch.length}/${cap}</span>
          ${batch.map((id) => `<span class="lt" style="border-left-color:${demoColorOf(id)}"><b>${id}</b><span class="lt-m" style="background:${demoColorOf(id)}">${esc(demoModuleOf[id])}</span></span>`).join('\n          ')}
          ${Array.from({ length: Math.max(0, cap - batch.length) }, () => '<span class="lt idle">idle lane</span>').join('\n          ')}
        </div>`).join('')

const LANE_DEMO = `
    <div class="lane-ctl" role="group" aria-label="concurrency">
      <span class="lane-lbl">concurrency</span>
      ${DEMO_LANES.map((c) => `<button type="button" class="lane-b" data-lane="${c}"${c === 4 ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${c}</button>`).join('')}
      <span class="lane-read" id="lane-read"></span>
    </div>
    <div class="lane-legend">
      ${DEMO_MODULES.map((m) => `<span class="lane-lg"><span class="lane-sw" style="background:${m.color}"></span>${esc(m.name)}</span>`).join('')}
    </div>
    ${DEMO_LANES.map((c) => `<div class="lane-board" data-board="${c}"${c === 4 ? '' : ' hidden'}>${demoWaveHtml(c)}
    </div>`).join('\n    ')}`

const LANE_FACTS = DEMO_LANES.map((c) => `${c}:${DEMO_ROUNDS[c].length}`).join(',')

// --- phased-PRD demo (issue #115) --------------------------------------------
// A project does not end at Gate 2: the next phase gets its own PRD *document* and
// decomposes into the SAME docs/prd/ tree. The load-bearing fact this board exists to
// carry is the CROSS-PHASE edge — BIL-1 is blocked_by a delivered phase-1 ticket, and
// that only resolves because both phases live in one graph. Split the tree and it
// becomes a dangling reference, which the scanner treats as a hard error.
// Same discipline as the lane demo: waves come from dag-core.simulate at BUILD time,
// so the page cannot advertise a schedule the runner would not produce.
const PH_MODULES = [
  { name: '01-core', color: '#2a78d6', phase: 1 },
  { name: '02-api', color: '#eda100', phase: 1 },
  { name: '03-billing', color: '#e87ba4', phase: 2 },
]
const PH_TICKETS = [
  ['0101', '01-core', []], ['0102', '01-core', []],
  ['0103', '01-core', ['0101', '0102']],
  ['0201', '02-api', ['0103']], ['0202', '02-api', ['0103']],
  ['BIL-1', '03-billing', ['0201']],
  ['BIL-2', '03-billing', ['BIL-1']], ['BIL-3', '03-billing', ['BIL-1']],
  ['BIL-4', '03-billing', ['BIL-2', 'BIL-3']],
]
const PH_CAP = 2
const phDeps = Object.fromEntries(PH_TICKETS.map(([id, , d]) => [id, d]))
const phModuleOf = Object.fromEntries(PH_TICKETS.map(([id, m]) => [id, m]))
const phMod = (id) => PH_MODULES.find((m) => m.name === phModuleOf[id]) || {}
const phColorOf = (id) => phMod(id).color || '#7c7c74'
const phaseOf = (id) => phMod(id).phase || 1
const PH_IDS = { 1: [], 2: [] }
for (const [id] of PH_TICKETS) PH_IDS[phaseOf(id)].push(id)
// Phase 2 is scheduled with phase 1 ABSENT from the pending set — which is exactly
// what /start-all's closed-issue filter does on a re-run, so BIL-1's dependency on
// the delivered 0201 is already satisfied and the new work starts immediately.
const PH_ROUNDS = {
  1: simulate(PH_IDS[1], (id) => phDeps[id], PH_CAP),
  2: simulate(PH_IDS[2], (id) => phDeps[id], PH_CAP),
}

const phCrossDeps = (id) => (phDeps[id] || []).filter((d) => phaseOf(d) !== phaseOf(id))
const phCard = (id, done) => `<span class="lt${done ? ' done' : ''}" style="border-left-color:${phColorOf(id)}"><b>${id}</b>` +
  (done ? '<span class="lt-s">delivered &middot; skipped</span>' : '') +
  (phCrossDeps(id).length ? `<span class="lt-x">&larr; ${phCrossDeps(id).join(', ')} &middot; phase 1</span>` : '') +
  `<span class="lt-m" style="background:${phColorOf(id)}">${esc(phModuleOf[id])}</span></span>`

const phWaves = (which) => PH_ROUNDS[which].map((batch, i) => `
        <div class="lw">
          <span class="lw-h">wave ${i + 1} &middot; ${batch.length}/${PH_CAP}</span>
          ${batch.map((id) => phCard(id, false)).join('\n          ')}
          ${Array.from({ length: Math.max(0, PH_CAP - batch.length) }, () => '<span class="lt idle">idle lane</span>').join('\n          ')}
        </div>`).join('')

const PHASE_DEMO = `
    <div class="lane-ctl" role="group" aria-label="phase">
      <span class="lane-lbl">run</span>
      <button type="button" class="ph-b" data-phase="1" aria-pressed="false">phase 1</button>
      <button type="button" class="ph-b" data-phase="2" aria-pressed="true">+ phase 2</button>
      <span class="lane-read" id="ph-read"></span>
    </div>
    <div class="lane-legend">
      ${PH_MODULES.map((m) => `<span class="lane-lg"><span class="lane-sw" style="background:${m.color}"></span>${esc(m.name)} <span class="ph-tag">phase ${m.phase}</span></span>`).join('')}
    </div>
    <div class="ph-board" data-phase="1" hidden>${phWaves(1)}
    </div>
    <div class="ph-board" data-phase="2">
      <div class="lw ph-done">
        <span class="lw-h">already delivered</span>
        ${PH_IDS[1].map((id) => phCard(id, true)).join('\n        ')}
      </div>${phWaves(2)}
    </div>`

// --- pure-CSS clay icons, markup lifted from the approved mock -------------
const LOGO_ICON = `<span class="gx" style="width:26px;height:26px;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="position:absolute;left:1px;top:2px;width:15px;height:20px;border-radius:5px;background:#b7a0e2;transform:rotate(-9deg);box-shadow:inset 0 2px 2px rgba(255,255,255,0.5)"></span><span style="position:absolute;left:9px;top:3px;width:15px;height:20px;border-radius:5px;background:var(--pill);transform:rotate(7deg);box-shadow:inset 0 -2px 3px rgba(var(--ins),0.35);display:flex;flex-direction:column;gap:3px;padding:4px 3px;box-sizing:border-box"><span style="height:2.5px;border-radius:2px;background:#f4a0b5"></span><span style="height:2.5px;border-radius:2px;background:#d9c8f0"></span><span style="height:2.5px;border-radius:2px;background:#d9c8f0;width:70%"></span></span></span>`
const STAR_ICON = `<span style="width:14px;height:14px;background:#f9d66e;clip-path:polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%);display:inline-block"></span>`
const NPM_ICON = `<span class="gx" style="width:14px;height:14px"><span style="position:absolute;inset:0;border-radius:4px;background:#fff3df;box-shadow:inset 0 -2px 3px rgba(190,110,60,0.4)"></span><span style="position:absolute;left:0;right:0;top:5.5px;height:3px;background:#e8b48c"></span></span>`
const PATTERNS_ICON = `<span style="display:inline-grid;grid-template-columns:9px 9px;gap:2.5px;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="width:9px;height:9px;border-radius:3px;background:#9ed095"></span><span style="width:9px;height:9px;border-radius:3px;background:#f6a5bb"></span><span style="width:9px;height:9px;border-radius:3px;background:#f4cd6d"></span><span style="width:9px;height:9px;border-radius:3px;background:#c3abe9"></span></span>`
const PIPELINE_ICON = `<span class="gx" style="width:22px;height:18px;border-radius:5px;background:#a9c6ec;overflow:hidden;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="position:absolute;left:3px;top:3px;width:6px;height:6px;border-radius:50%;background:#f9d66e"></span><span style="position:absolute;left:-5px;bottom:-9px;width:17px;height:17px;border-radius:50%;background:#9ed095"></span><span style="position:absolute;right:-4px;bottom:-8px;width:15px;height:15px;border-radius:50%;background:#8fc98b"></span></span>`

// hero side facts: [icon-tile style, glyph markup, copy]
const FACTS = [
  ['background:#d9c8f0;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(90,50,140,0.18)',
    `<span class="gx" style="width:15px;height:18px"><span style="position:absolute;inset:0;border-radius:3px;background:#fffaf2;box-shadow:0 2px 4px rgba(90,50,140,0.25)"></span><span style="position:absolute;left:3px;right:3px;top:4px;height:2px;border-radius:2px;background:#c3abe9"></span><span style="position:absolute;left:3px;right:3px;top:8px;height:2px;border-radius:2px;background:#c3abe9"></span><span style="position:absolute;left:3px;right:6px;top:12px;height:2px;border-radius:2px;background:#c3abe9"></span></span>`,
    'Every model/effort claim carries a source label and an expiry date'],
  ['background:#b3cdf0;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(40,80,150,0.2)',
    `<span style="width:16px;height:18px;background:#fffaf2;border-radius:5px 5px 50% 50% / 5px 5px 75% 75%;box-shadow:inset 0 -3px 4px rgba(40,80,150,0.25),0 2px 4px rgba(40,80,150,0.3);display:inline-block"></span>`,
    // Kept CATALOG-true. This used to say "enforced by hooks", which is the three-agent
    // pattern's mechanism (a PreToolUse write guard); hub-and-spoke enforces its boundary
    // with permission deny rules instead. The hero sits outside the tabs, so anything
    // stated here must hold for every pattern (catalog issue #166).
    'Role boundaries enforced by config, not prose'],
  ['background:#f9d66e;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.6),inset -3px -4px 6px rgba(180,120,20,0.25)',
    `<span class="gx" style="width:17px;height:17px"><span style="position:absolute;inset:0;border-radius:50%;background:#fffaf2;box-shadow:0 2px 4px rgba(160,100,20,0.3)"></span><span style="position:absolute;left:6px;top:-2px;width:14px;height:14px;border-radius:50%;background:#f9d66e"></span></span>`,
    // Also catalog-true. The nightly sweep is three-agent only — it needs a tracker, and
    // hub-and-spoke has none — so that claim moved into its own pane and this states what
    // every pattern in the catalog actually ships.
    'Deterministic, zero-token E2E gates every scaffold change'],
]

// pipeline steps: [icon-tile style, glyph markup, title, description]
const STEPS = [
  ['background:#9ed095;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(30,90,40,0.2),0 6px 10px rgba(var(--amb),0.22)',
    `<span class="gx" style="width:20px;height:16px"><span style="position:absolute;inset:0;border-radius:4px;background:#fffaf2;box-shadow:inset 0 -2px 3px rgba(30,90,40,0.2),0 3px 5px rgba(30,90,40,0.3)"></span><span style="position:absolute;left:8.5px;top:0;width:3px;height:16px;background:#f4cd6d"></span></span>`,
    'Adopt', `<code>${esc(QUICKSTART)}</code> — scaffold, templates, docs skeleton, CLAUDE.md, in one idempotent command.`],
  ['background:#f4cd6d;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.6),inset -3px -4px 6px rgba(180,120,20,0.25),0 6px 10px rgba(var(--amb),0.22)',
    `<span class="gx" style="width:22px;height:16px"><span style="position:absolute;inset:0;border-radius:3px;background:#fffaf2;box-shadow:0 3px 5px rgba(160,100,20,0.3)"></span><span style="position:absolute;left:6.5px;top:0;width:1.5px;height:16px;background:rgba(var(--flt),0.25)"></span><span style="position:absolute;left:14px;top:0;width:1.5px;height:16px;background:rgba(var(--flt),0.25)"></span><span style="position:absolute;left:9px;top:5px;width:4px;height:4px;border-radius:50%;background:#f2789a"></span></span>`,
    'Break down', '<code>/breakdown-prd</code> — the Architect turns your PRD into sub-PRDs and cold-startable tickets, then stops.'],
  ['background:#f3e6d0;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.7),inset -3px -4px 6px rgba(170,120,70,0.2),0 6px 10px rgba(var(--amb),0.22)',
    `<span style="width:13px;height:28px;border-radius:6.5px;background:#7a6a58;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;box-shadow:inset 0 2px 2px rgba(255,255,255,0.25),0 3px 5px rgba(90,60,30,0.35)"><span style="width:6px;height:6px;border-radius:50%;background:#f28b8b"></span><span style="width:6px;height:6px;border-radius:50%;background:#f9d66e"></span><span style="width:6px;height:6px;border-radius:50%;background:#8fc98b"></span></span>`,
    'Gate 1 — you decide', 'Review the breakdown, then <code>/start-milestone</code>: tickets become tracker issues and the pipeline starts.'],
  ['background:#c3abe9;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(90,50,140,0.22),0 6px 10px rgba(var(--amb),0.22)',
    `<span class="gx" style="width:24px;height:24px"><span style="position:absolute;left:11px;top:0;width:2px;height:4px;background:#fffaf2"></span><span style="position:absolute;left:9.5px;top:-3px;width:5px;height:5px;border-radius:50%;background:#f2789a"></span><span style="position:absolute;left:0;top:5px;width:24px;height:18px;border-radius:7px;background:#fffaf2;box-shadow:inset 0 -3px 4px rgba(90,50,140,0.2),0 3px 5px rgba(70,30,120,0.3)"></span><span style="position:absolute;left:5px;top:11px;width:5px;height:5px;border-radius:50%;background:#8f74c4"></span><span style="position:absolute;left:14px;top:11px;width:5px;height:5px;border-radius:50%;background:#8f74c4"></span></span>`,
    'Autonomous middle', 'Plan → build → fresh-context review (bounce-capped in code) → merge on <code>CLEAR</code> → issue closed → delivery verified.'],
  ['background:#f6a5bb;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(170,30,80,0.2),0 6px 10px rgba(var(--amb),0.22)',
    `<span class="gx" style="width:22px;height:22px"><span style="position:absolute;left:0;top:0;width:13px;height:13px;border-radius:50%;border:4px solid #fffaf2;box-shadow:0 3px 5px rgba(150,60,90,0.3)"></span><span style="position:absolute;left:16px;top:15px;width:4.5px;height:9px;border-radius:2.5px;background:#fffaf2;transform:rotate(-45deg)"></span></span>`,
    'Gate 2 — smoke test', 'Agents own unit/integration/E2E all along; you test once per phase, when that PRD is done. A nightly sweep fixes issues while you sleep.'],
]

// ---------------------------------------------------------------------------
// Tab order is deliberate, not alphabetical. A reader landing here should see the
// pattern that is signed off and has run, not whichever directory name sorts first —
// `proposed` means "drafted, not signed off", and putting it in front would recommend it
// by placement. Within a rank, name order keeps the output stable.
// ---------------------------------------------------------------------------
const STATUS_RANK = { adopted: 0, trialed: 1, proposed: 2, deprecated: 3 }
const ordered = [...patterns].sort((a, b) =>
  (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.dir.localeCompare(b.dir))

const TILE_GREEN = 'background:#9ed095;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(30,90,40,0.2),0 6px 10px rgba(var(--amb),0.22)'
const TILE_YELLOW = 'background:#f4cd6d;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.6),inset -3px -4px 6px rgba(180,120,20,0.25),0 6px 10px rgba(var(--amb),0.22)'
const TILE_BLUE = 'background:#b3cdf0;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(40,80,150,0.22),0 6px 10px rgba(var(--amb),0.22)'
const TILE_PURPLE = 'background:#c9b6ee;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(80,50,150,0.22),0 6px 10px rgba(var(--amb),0.22)'
const TILE_PINK = 'background:#f6a5bb;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(170,30,80,0.2),0 6px 10px rgba(var(--amb),0.22)'
const dotGlyph = (n) => `<span style="display:flex;gap:2.5px;align-items:center">${Array.from({ length: n }, () => '<span style="width:5px;height:5px;border-radius:50%;background:#fffaf2"></span>').join('')}</span>`

// The hub-and-spoke flow. Deliberately NOT reusing the three-agent step copy: the two
// pipelines produce different artifacts and carry different guarantees, and matching prose
// would be the thing hiding that.
const HUB_STEPS = [
  [TILE_GREEN, dotGlyph(1), 'Adopt',
    `<code>npx agent-templates@latest adopt hub-and-spoke-orchestrator-executors .</code> — scaffold, CLAUDE.md, permission rules. Needs the <b>Codex CLI</b> on PATH; it is a hard dependency, not an accelerator.`],
  [TILE_YELLOW, dotGlyph(2), 'Brief',
    `<code>/hub-brief</code> — the hub turns your PRD into <b>contract-first briefs</b>. Every interface, type and error shape is fixed here, because the executors are told not to design.`],
  [TILE_PINK, dotGlyph(3), 'Gate 1 — you decide',
    `Review the briefs. This gate carries more weight than its three-agent counterpart: there is <b>no independent reviewer downstream</b> to catch a wrong contract.`],
  [TILE_PURPLE, dotGlyph(4), 'Dispatch',
    `<code>/hub-dispatch</code> — one invalid brief dispatches <b>nothing</b>. The rest fan out to headless <code>codex exec</code>, one isolated worktree each, self-repairing under a capped loop.`],
  [TILE_BLUE, dotGlyph(5), 'Collect &amp; Gate 2',
    `<code>/hub-collect</code> — re-audit, re-test, review, merge. <b>quarantined</b> outranks green tests; <b>unverified</b> never merges. Then your smoke test.`],
]

// ---------------------------------------------------------------------------
// Hub-and-spoke: what a brief IS, and how the briefs schedule.
//
// Read from the committed rehearsal briefs rather than written by hand, so the page shows
// an artifact that really passed the dispatch gate and really ran. The wave order is
// recomputed here with the pattern's own readyBriefs(), which is what the driver calls —
// the page cannot show a schedule the driver would not produce.
// ---------------------------------------------------------------------------
const REHEARSAL_BRIEFS = (() => {
  const dir = join(ROOT, 'testbed', 'hub-rehearsal', 'docs', 'briefs')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => {
      const raw = readFileSync(join(dir, f), 'utf8')
      const b = parseBrief(raw, f)
      b.lines = raw.replace(/\r\n/g, '\n').split('\n').length
      return b
    })
})()

const hubWaves = (() => {
  const out = []
  const done = []
  for (let guard = 0; guard < 10; guard++) {
    const wave = readyBriefs(REHEARSAL_BRIEFS, done)
    if (!wave.length) break
    out.push(wave)
    for (const b of wave) done.push(b.data.id)
  }
  return out
})()

const BRIEF_FIELDS = [
  ['id', 'Stable and never reused. Names the branch (<code>spoke/&lt;id&gt;</code>) and the worktree.'],
  ['blocked_by', 'The machine-readable DAG. Dangling ids and cycles fail the whole set before any worktree exists.'],
  ['file_scope', 'The write-set this brief <b>owns</b>. Audited against the committed diff, so straying is detected, not trusted. A repo-wide or firewall-denied scope is rejected at decomposition time.'],
  ['test_cmd', 'Scoped to <b>this brief’s module</b>, never the whole suite — the full suite cannot pass until the last brief lands, so a whole-suite command fails every brief but that one.'],
]
const BRIEF_SECTIONS = [
  ['## Contract', 'The interfaces, types, signatures and <b>exact error messages</b> the executor transcribes. This is the section that makes low effort safe: nothing is left to decide.'],
  ['## Deliverables', 'Code-level precision — exact exports, call sites, ordering constraints.'],
  ['## Done when', 'The observable outcome, so completion is checkable independently of the tests passing.'],
  ['## Out of scope', 'Each exclusion <b>names its owner</b>: &ldquo;no schema changes — that is FND-01&rdquo;. Unowned exclusions read as oversights and get helpfully implemented.'],
]

const briefAnatomy = REHEARSAL_BRIEFS.length ? `
    <div class="fact" style="display:block;margin-bottom:15px">
      <p style="margin:0 0 8px"><b>One brief = one disjoint write-set.</b> Not a feature, not an effort estimate. Two briefs may run at once exactly when the files they own do not overlap, so the decomposition is a partition of the filesystem — and the audit checks it against what the executor actually wrote.</p>
      <p style="margin:0 0 10px">In the committed rehearsal a <b>${esc(String(readFileSync(join(ROOT, 'testbed', 'hub-rehearsal', 'docs', 'PRD.md'), 'utf8').replace(/\r\n/g, '\n').split('\n').length))}-line PRD</b> with ${REHEARSAL_BRIEFS.length} requirements became <b>${REHEARSAL_BRIEFS.length} briefs of ${Math.min(...REHEARSAL_BRIEFS.map((b) => b.lines))}&ndash;${Math.max(...REHEARSAL_BRIEFS.map((b) => b.lines))} lines</b>, each owning exactly one file. A brief is <em>longer</em> than the PRD section it implements, on purpose: the executor starts cold and is forbidden to design, so the contract has to be in the brief.</p>
      <div class="cmds">
        <div class="cmds-label">Frontmatter — the machine-readable half</div>
        ${BRIEF_FIELDS.map(([k, d]) => `<div class="cmd"><code class="cmd-name">${esc(k)}</code><span class="cmd-desc">${d}</span></div>`).join('\n        ')}
      </div>
      <div class="cmds" style="margin-top:10px">
        <div class="cmds-label">Body — every section required, empty ones rejected</div>
        ${BRIEF_SECTIONS.map(([k, d]) => `<div class="cmd"><code class="cmd-name">${esc(k)}</code><span class="cmd-desc">${d}</span></div>`).join('\n        ')}
      </div>
    </div>` : ''

const hubBoard = hubWaves.length ? `
    <div class="fact" style="display:block;margin-bottom:15px">
      <p style="margin:0 0 4px"><b>${REHEARSAL_BRIEFS.length} briefs, ${hubWaves.length} waves</b> — the real schedule from the committed rehearsal, recomputed here by the driver's own scheduler. Wave 2 cannot start until wave 1 is merged, because its worktrees fork from the default branch.</p>
      <!-- deliberately NOT data-board=: the lane demo's wave-count check splits the page on
           that attribute, and a fifth board would silently break its arithmetic -->
      <div class="lane-board" data-hub-board="1">
        ${hubWaves.map((wave, i) => `<div class="lw"><span class="lw-n">wave ${i + 1}</span>${wave.map((b) => `<span class="lt"><span class="lt-m">${esc(String(b.data.file_scope[0] || ''))}</span>${esc(b.data.id)}</span>`).join('')}</div>`).join('\n        ')}
      </div>
    </div>` : ''

// Use-when bullets are intentionally gone (parse + render): the approved mock's
// pattern card is title + status chip + summary + role chips + links only.
const cardFor = (p) => {
    const c = STATUS_CHIP[p.status] || STATUS_CHIP.proposed
    const summary = esc(p.summary).replace(/→/g, '<span class="arr">→</span>')
    return `
      <article class="panel pattern">
        <div class="pattern-head">
          <h3>${esc(p.title)}</h3>
          <span class="chip" style="${c.chip}"><span class="chip-dot" style="box-shadow:${c.dot}"></span>${esc(p.status)} · as of ${esc(p.asOf)}</span>
        </div>
        <p class="summary">${summary}</p>
        <div class="pattern-cols">
          ${p.commands.length ? `<div class="cmds">
            <div class="cmds-label">Commands</div>
            ${p.commands.map((cmd) => `<div class="cmd"><div class="cmd-sig"><code class="cmd-name">${esc(cmd.name)}</code>${cmd.hint ? ` <code class="cmd-hint">${esc(cmd.hint)}</code>` : ''}${cmd.integration ? `<span class="cmd-opt">${esc(cmd.integration)} · optional</span>` : ''}</div><div class="cmd-desc">${esc(cmd.description)}</div></div>`).join('\n            ')}
          </div>` : ''}
          <div class="pattern-side">
            <div class="cmds-label" style="padding-left:2px">Roles · model · effort</div>
            <div class="roles">
              ${p.roles.map((r) => { const [dot, dotInk] = roleDot(r.role); return `<span class="role"><span class="dot" style="background:${dot};box-shadow:inset 1px 1.5px 1.5px rgba(255,255,255,0.6),inset -1px -1.5px 2px ${dotInk}"></span><b>${esc(r.role)}</b><code>${esc(r.model)} <span class="eff">@${esc(r.effort)}</span></code></span>` }).join('\n              ')}
            </div>
            <div class="install-mini">
              <div class="cmds-label">Install this pattern</div>
              <code>npx agent-templates@latest adopt ${esc(p.dir)} .</code>
            </div>
            <div class="links">
              <a class="btn btn-green" href="${GITHUB}/tree/main/patterns/${esc(p.dir)}">Pattern write-up</a>
              <a class="btn btn-purple" href="${GITHUB}/tree/main/patterns/${esc(p.dir)}/scaffold">Scaffold</a>
            </div>
          </div>
        </div>
      </article>`
}

// One line of POSITIONING per pattern, so the rail answers "which one do I want" without
// opening all three. Keyed by directory: a new pattern falls back to its own summary
// rather than silently getting someone else's pitch.
const RAIL_TAG = {
  'three-agent-architect-builder-reviewer':
    'Highest assurance — a fresh-context Reviewer on a different model tier clears every ticket.',
  'codex-three-agent-architect-builder-reviewer':
    'The same independent-reviewer topology, for teams on the Codex CLI rather than Claude Code.',
  'hub-and-spoke-orchestrator-executors':
    'Cheapest and fastest — one expensive context for the whole run, and no independent reviewer.',
}

const tabButtons = ordered.map((p, i) =>
  `<button class="tab" type="button" role="tab" id="tab-${esc(p.dir)}" aria-controls="pane-${esc(p.dir)}" aria-selected="${i === 0 ? 'true' : 'false'}" data-tab="${esc(p.dir)}">` +
  `<span class="tab-name">${esc(p.title)}</span>` +
  `<span class="tab-sub">${esc(p.status)} · as of ${esc(p.asOf)}</span>` +
  `<span class="tab-tag">${esc(RAIL_TAG[p.dir] || p.summary)}</span>` +
  `</button>`).join('\n        ')

const paneOpen = (dir, first) => `<div class="pane" role="tabpanel" id="pane-${esc(dir)}" aria-labelledby="tab-${esc(dir)}" data-pane="${esc(dir)}"${first ? '' : ' hidden'}>`
const byDir = (dir) => ordered.find((p) => p.dir === dir)
const THREE = 'three-agent-architect-builder-reviewer'
const CODEX_THREE = 'codex-three-agent-architect-builder-reviewer'
const HUB = 'hub-and-spoke-orchestrator-executors'
const isFirst = (dir) => ordered.length > 0 && ordered[0].dir === dir

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-templates — multi-agent patterns, ready to drop in</title>
<meta name="description" content="A catalog of multi-agent development architecture patterns: design write-ups plus drop-in scaffolding, E2E-tested, published on npm.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Nunito:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root{
    --page:${THEME.page}; --hero-a:${THEME.heroA}; --hero-b:${THEME.heroB};
    --hero-ink:${THEME.heroInk}; --hero-amb:${THEME.heroAmb};
    --hero-title:${THEME.heroTitle}; --hero-body:${THEME.heroBody};
    --card:${THEME.card}; --pill:${THEME.pill};
    --ink:${THEME.ink}; --sub:${THEME.sub}; --mut:${THEME.mut}; --code:${THEME.code};
    --amb:${THEME.amb}; --ins:${THEME.ins}; --flt:${THEME.flt};
    --mono:ui-monospace,'Cascadia Code',Consolas,Menlo,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--page);font-family:'Nunito',sans-serif}
  a{color:#e7548c;text-decoration:none}
  a:hover{color:#c13a63}
  /* Landscape-first (catalog issue #185). The page was built at max-width 880px, which
     reads as a phone layout stretched down a desktop monitor — and this catalog is read on
     a laptop, in a browser, next to an editor. The container is now the design's
     min(1560px,94vw) and every section below lays out ACROSS rather than down. */
  .wrap{width:min(1560px,94vw);margin:0 auto;padding:0 0 34px}
  .page-body{padding-top:26px}
  .gx{position:relative;display:inline-block}
  .arr{color:#e7548c}

  /* Sticky bar: on a wide screen the section links and the install command must stay
     reachable without scrolling back to the top. */
  .navbar{position:sticky;top:0;z-index:30;background:rgba(var(--pill-rgb),0.84);backdrop-filter:blur(14px);
    box-shadow:0 1px 0 rgba(var(--flt),0.12),0 10px 24px rgba(var(--amb),0.13)}
  .nav{display:flex;align-items:center;gap:26px;padding:12px 0;margin:0}
  .nav-sec{display:flex;align-items:center;gap:2px;margin-left:6px}
  .nav-sec a{padding:7px 13px;border-radius:12px;font-size:13px;font-weight:800;color:var(--sub)}
  .nav-sec a:hover{background:rgba(var(--flt),0.09);color:var(--ink)}
  .nav-note{font-size:12px;font-weight:800;color:var(--mut);margin-right:4px}
  .logo{display:flex;align-items:center;gap:10px;padding:8px 18px 8px 13px;border-radius:19px;background:var(--pill);
    box-shadow:inset 0 2px 2px #fff,inset 0 -3px 5px rgba(var(--ins),0.2),0 8px 16px rgba(var(--amb),0.25)}
  .logo b{font-family:'Baloo 2',cursive;font-weight:800;font-size:19px;color:var(--ink)}
  .nav-links{margin-left:auto;display:flex;gap:10px}

  .btn{display:inline-flex;align-items:center;gap:8px;padding:9px 18px;border-radius:18px;color:#fff;
    font-size:12.5px;font-weight:900;transition:transform .15s ease;cursor:pointer}
  .btn:hover{transform:translateY(-2px);color:#fff}
  .btn:active{transform:translateY(1px)}
  .btn-lg{padding:10px 20px;font-size:13px}
  .btn-green{background:linear-gradient(180deg,#b3dcab,#98cb8e);text-shadow:0 1px 2px rgba(30,90,40,0.35);
    box-shadow:inset 0 2px 3px rgba(255,255,255,0.5),inset 0 -3px 5px rgba(30,100,40,0.25),0 8px 14px rgba(120,150,100,0.35)}
  .btn-orange{background:linear-gradient(180deg,#f6c9a2,#efb185);text-shadow:0 1px 2px rgba(160,80,30,0.35);
    box-shadow:inset 0 2px 3px rgba(255,255,255,0.5),inset 0 -3px 5px rgba(170,90,30,0.25),0 8px 14px rgba(190,130,90,0.35)}
  .btn-blue{background:linear-gradient(180deg,#b3cdf0,#96b8e5);text-shadow:0 1px 2px rgba(40,80,150,0.4);
    box-shadow:inset 0 2px 3px rgba(255,255,255,0.55),inset 0 -3px 5px rgba(40,80,150,0.28),0 8px 14px rgba(var(--amb),0.3)}
  .btn-purple{background:linear-gradient(180deg,#c3abe9,#a78cd8);text-shadow:0 1px 2px rgba(90,50,130,0.4);
    box-shadow:inset 0 2px 3px rgba(255,255,255,0.55),inset 0 -4px 6px rgba(94,58,140,0.28),0 8px 14px rgba(var(--amb),0.3)}

  /* ONE hero panel holding three columns, rather than a panel plus a sidebar. The title
     column, the install card and the facts sit side by side and the stats run as a single
     row underneath — the design's shape, and the one that uses a 1560px canvas. */
  .hero{border-radius:32px;padding:36px 38px 30px;background:linear-gradient(150deg,var(--hero-a),var(--hero-b));
    box-shadow:inset 0 3px 4px rgba(255,255,255,0.6),inset 0 -7px 12px var(--hero-ink),0 18px 34px var(--hero-amb)}
  .hero-cols{display:grid;grid-template-columns:minmax(420px,1.25fr) minmax(340px,0.85fr) minmax(300px,0.8fr);
    gap:34px;align-items:start}
  .hero-main h1{margin:14px 0 0;font-family:'Baloo 2',cursive;font-weight:800;font-size:52px;line-height:1.02;
    color:var(--hero-title);text-shadow:0 2px 0 rgba(255,255,255,0.45)}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:13px;
    background:rgba(255,255,255,0.62);font-size:11px;font-weight:900;letter-spacing:0.05em;text-transform:uppercase;
    color:var(--hero-body);box-shadow:inset 0 1px 2px #fff,0 4px 8px rgba(var(--flt),0.12)}
  .eyebrow i{width:7px;height:7px;border-radius:50%;background:#f2789a;display:inline-block}
  .lede{margin:16px 0 0;max-width:520px;font-size:15px;line-height:1.65;font-weight:700;color:var(--hero-body)}
  .install-card{border-radius:22px;background:rgba(255,255,255,0.74);padding:18px 18px 16px;
    box-shadow:inset 0 2px 3px #fff,inset 0 -3px 6px rgba(var(--flt),0.14),0 10px 18px rgba(var(--flt),0.14)}
  .install-head{display:flex;align-items:center;gap:9px;font-size:10.5px;font-weight:900;letter-spacing:0.06em;
    text-transform:uppercase;color:var(--mut)}
  .install-head span{flex:1;height:1px;background:rgba(var(--flt),0.16)}
  .hero-stats{display:flex;align-items:center;gap:34px;flex-wrap:wrap;margin-top:28px;padding-top:22px;
    border-top:1px solid rgba(255,255,255,0.45)}
  .hero-stats .sep{width:1px;height:22px;background:rgba(255,255,255,0.5)}
  .cta{display:flex;gap:12px;margin-top:20px}
  .quick{margin-top:20px;border-radius:16px;background:var(--pill);padding:14px 16px 12px;
    box-shadow:inset 0 3px 6px rgba(var(--flt),0.2),inset 0 -2px 2px rgba(255,255,255,0.8)}
  .quick code{display:block;font-family:var(--mono);font-size:12px;font-weight:700;color:var(--code);line-height:1.55;word-break:break-all}
  .update-note{margin:12px 0 0;font-size:11.5px;font-weight:700;line-height:1.5;color:var(--hero-body)}
  .update-note code{font-family:var(--mono);font-size:11px;color:var(--hero-title);word-break:break-all}
  .copy{display:inline-flex;margin-top:10px;padding:6px 16px;border-radius:13px;border:0;
    background:linear-gradient(180deg,#f9d66e,#f0c14a);cursor:pointer;font-family:'Nunito',sans-serif;
    font-size:12px;font-weight:900;color:#6b4a15;transition:transform .15s ease;
    box-shadow:inset 0 2px 2px rgba(255,255,255,0.6),inset 0 -3px 4px rgba(180,120,20,0.3),0 5px 10px rgba(180,130,60,0.3)}
  .copy:hover{transform:translateY(-1.5px)}
  .copy:active{transform:translateY(1px)}
  .hero-side{display:flex;flex-direction:column;gap:14px;justify-content:center}
  .fact{display:flex;align-items:center;gap:12px;padding:13px 16px;border-radius:20px;background:var(--card);
    box-shadow:inset 0 2px 2px #fff,inset 0 -3px 6px rgba(var(--ins),0.16),0 10px 20px rgba(var(--amb),0.22)}
  .fact-ico{flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center}
  .fact p{margin:0;font-size:12.5px;font-weight:800;color:var(--sub);line-height:1.5}

  /* Inside the hero now, as a single horizontal band — four coloured tiles stacked down
     the page was the most obviously portrait-shaped part of the old layout. */
  .stats{display:flex;align-items:baseline;gap:9px}
  .stat{border-radius:0;padding:0;background:none!important;box-shadow:none!important;display:flex;align-items:baseline;gap:9px}
  .stat .big{font-family:'Baloo 2',cursive;font-weight:800;font-size:25px;color:var(--hero-title)}
  .stat p{margin:0;font-size:12px;font-weight:800;line-height:1.4;color:var(--hero-body)}
  .stat-green{background:linear-gradient(180deg,#b9dfb1,#9bce92);
    box-shadow:inset 0 3px 4px rgba(255,255,255,0.55),inset 0 -5px 8px rgba(30,90,40,0.2),0 10px 20px rgba(var(--amb),0.25)}
  .stat-green .big{color:#2f6b35} .stat-green p{color:#3f7a45}
  .stat-orange{background:linear-gradient(180deg,#f9cba6,#f1af85);
    box-shadow:inset 0 3px 4px rgba(255,255,255,0.55),inset 0 -5px 8px rgba(170,90,30,0.2),0 10px 20px rgba(var(--amb),0.25)}
  .stat-orange .big{color:#94481c} .stat-orange p{color:#9c5426}
  .stat-yellow{background:linear-gradient(180deg,#fae09c,#f3cb6a);
    box-shadow:inset 0 3px 4px rgba(255,255,255,0.6),inset 0 -5px 8px rgba(180,120,20,0.22),0 10px 20px rgba(var(--amb),0.25)}
  .stat-yellow .big{color:#7e5a12} .stat-yellow p{color:#8a6218}
  .stat-blue{background:linear-gradient(180deg,#b7d2f4,#9abfe9);
    box-shadow:inset 0 3px 4px rgba(255,255,255,0.55),inset 0 -5px 8px rgba(40,80,150,0.22),0 10px 20px rgba(var(--amb),0.25)}
  .stat-blue .big{color:#2c548c} .stat-blue p{color:#315e9c}

  /* --- lane demo: a miniature of docs/prd/dag.html, in the site's clay language --- */
  .lane-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .lane-lbl{font-weight:700;color:var(--sub);font-size:13px;margin-right:2px}
  .lane-b,.ph-b{font-family:inherit;font-size:14px;font-weight:800;color:var(--sub);cursor:pointer;
    min-width:34px;padding:5px 11px;border:0;border-radius:11px;background:var(--pill);
    box-shadow:inset 0 2px 2px rgba(255,255,255,0.7),inset 0 -3px 4px rgba(var(--ins),0.4),0 3px 7px rgba(var(--flt),0.16)}
  .lane-b[aria-pressed=true],.ph-b[aria-pressed=true]{background:linear-gradient(180deg,#b3dcab,#98cb8e);color:#2f4a28;
    box-shadow:inset 0 2px 2px rgba(255,255,255,0.6),inset 0 -3px 4px rgba(30,100,40,0.28),0 4px 9px rgba(120,150,100,0.3)}
  .lane-read{font-size:13px;color:var(--mut);flex-basis:100%}
  .lane-read b{color:var(--ink)}
  .lane-legend{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:14px;font-family:var(--mono);font-size:11.5px;color:var(--sub)}
  .lane-lg{display:inline-flex;align-items:center;gap:6px}
  .lane-sw{width:10px;height:10px;border-radius:3px;box-shadow:inset -1px -1px 2px rgba(0,0,0,0.18)}
  .lane-board,.ph-board{display:flex;gap:14px;overflow-x:auto;padding:2px 2px 8px}
  /* an author display rule beats the UA [hidden]{display:none}, so restate it or every
     board renders stacked on top of the others */
  .lane-board[hidden],.ph-board[hidden]{display:none}
  /* phase demo (issue #115). Deliberately NOT reusing .lane-board/.lane-b as hooks:
     the lane demo's script hides every .lane-board it finds, so a shared class would
     make the two demos fight. Shared styling, separate selectors. */
  .lt.done{opacity:.55;background:transparent;box-shadow:none;
    border:1px dashed rgba(var(--ins),0.75);border-left-width:3px;border-left-style:solid}
  .lt-s{font-size:9.5px;color:var(--mut)}
  .lt-x{font-size:9.5px;color:var(--code);font-weight:700}
  .ph-done{border-right:1px dashed rgba(var(--ins),0.9);padding-right:14px}
  .ph-tag{font-size:9.5px;color:var(--mut)}
  .ph-seq{margin:0;padding:11px 13px;border-radius:12px;background:rgba(var(--flt),0.1);overflow-x:auto}
  .ph-seq code{font-family:var(--mono);font-size:11.5px;font-weight:700;color:var(--code);line-height:1.75;white-space:pre}
  .ph-c{color:var(--mut);font-weight:400}
  .lw{display:flex;flex-direction:column;gap:6px;min-width:132px}
  .lw-h{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--mut);font-weight:700}
  .lt{display:flex;flex-direction:column;gap:4px;padding:7px 9px;border-radius:9px;background:var(--pill);
    border-left:3px solid var(--mut);font-family:var(--mono);font-size:11.5px;color:var(--ink);
    box-shadow:inset 0 2px 2px rgba(255,255,255,0.7),inset 0 -2px 3px rgba(var(--ins),0.3),0 2px 6px rgba(var(--flt),0.13)}
  .lt-m{align-self:flex-start;font-size:9.5px;padding:1px 5px;border-radius:4px;color:#fff;font-weight:700}
  .lt.idle{background:transparent;border:1px dashed rgba(var(--ins),0.75);border-left:1px dashed rgba(var(--ins),0.75);
    box-shadow:none;color:var(--mut);align-items:center;justify-content:center;min-height:34px;font-size:10.5px}
  .sec-head{display:flex;align-items:center;gap:11px;margin:32px 0 14px}
  .sec-head h2{margin:0;font-family:'Baloo 2',cursive;font-weight:800;font-size:25px;color:var(--ink)}

  .panel{border-radius:24px;background:var(--card);padding:20px 24px 22px;
    box-shadow:inset 0 2px 2px #fff,inset 0 -4px 8px rgba(var(--ins),0.15),0 14px 26px rgba(var(--amb),0.25)}
  .pattern + .pattern{margin-top:16px}
  .pattern-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .pattern-head h3{margin:0;font-family:'Baloo 2',cursive;font-weight:700;font-size:20px;color:var(--ink);flex:1}
  .chip{display:inline-flex;align-items:center;gap:7px;padding:7px 15px;border-radius:15px;font-size:11.5px;font-weight:900}
  .chip-dot{width:8px;height:8px;border-radius:50%;background:#fffaf2}
  .summary{margin:12px 0 0;font-size:13px;line-height:1.6;font-weight:700;color:var(--sub);max-width:760px}
  /* Two columns inside the panel: the command reference reads as a table, the roles and
     install sit beside it. On a wide screen this is the difference between a reference and
     a scroll. */
  .pattern-cols{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(260px,0.85fr);gap:24px;margin-top:22px;align-items:start}
  .pattern-side{display:flex;flex-direction:column}
  .install-mini{margin-top:16px;border-radius:16px;background:var(--pill);padding:12px 14px;
    box-shadow:inset 0 3px 6px rgba(var(--ins),0.25),inset 0 -2px 2px rgba(255,255,255,0.8)}
  .install-mini code{display:block;margin-top:7px;font-family:var(--mono);font-size:11px;font-weight:700;
    color:var(--code);line-height:1.55;word-break:break-all}
  .roles{display:flex;flex-direction:column;gap:9px;margin-top:10px}
  .role{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:16px;background:var(--pill);
    box-shadow:inset 0 2px 2px #fff,inset 0 -3px 5px rgba(var(--ins),0.25),0 5px 10px rgba(var(--amb),0.2)}
  .role .dot{width:9px;height:9px;border-radius:50%}
  .role b{font-size:12px;font-weight:900;color:var(--ink)}
  .role .sep{font-size:11px;font-weight:700;color:var(--mut)}
  .role code{font-family:var(--mono);font-size:11px;font-weight:700;color:#8a5fd0}
  .role .eff{color:#e7548c}
  .links{display:flex;flex-direction:column;gap:10px;margin-top:16px}

  .cmds{margin-top:16px;border-radius:16px;background:var(--pill);padding:14px 16px 12px;
    box-shadow:inset 0 3px 6px rgba(var(--flt),0.14),inset 0 -2px 2px rgba(255,255,255,0.7)}
  .cmds-label{font-family:'Baloo 2',cursive;font-weight:700;font-size:13px;color:var(--ink);margin-bottom:9px}
  .cmd{display:grid;grid-template-columns:minmax(230px,0.85fr) minmax(0,1.4fr);gap:22px;padding:11px 0;
    border-top:1px solid rgba(var(--flt),0.1)}
  .cmd-sig{font-family:var(--mono);font-size:11.5px;line-height:1.55;word-break:break-word}
  .cmd:first-of-type{border-top:0}
  .cmd-name{font-family:var(--mono);font-size:12px;font-weight:700;color:#8a5fd0;white-space:nowrap}
  .cmd-hint{font-family:var(--mono);font-size:10.5px;font-weight:700;color:var(--mut);white-space:nowrap}
  .cmd-desc{font-size:11.5px;font-weight:700;color:var(--sub);line-height:1.55}
  .cmd-opt{font-size:9.5px;font-weight:800;letter-spacing:0.03em;text-transform:uppercase;color:var(--mut);background:rgba(var(--flt),0.09);border-radius:5px;padding:2px 6px;white-space:nowrap}

  .steps{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}
  .step{border-radius:20px;background:var(--card);padding:15px 14px 17px;
    box-shadow:inset 0 2px 2px #fff,inset 0 -3px 6px rgba(var(--ins),0.15),0 10px 20px rgba(var(--amb),0.22)}
  .step-ico{width:42px;height:42px;border-radius:13px;display:grid;place-items:center}
  .step h3{margin:11px 0 0;font-size:13px;font-weight:900;color:var(--ink);font-family:'Nunito',sans-serif}
  .step p{margin:6px 0 0;font-size:11.5px;font-weight:700;color:var(--sub);line-height:1.55}
  .step code{font-family:var(--mono);font-size:10px;background:rgba(var(--flt),0.12);border-radius:5px;padding:1px 4px;color:var(--code);word-break:break-all}

  footer{margin-top:30px;text-align:center;font-size:12.5px;font-weight:700;color:var(--mut)}
  footer code{font-family:var(--mono);font-size:11.5px;color:#8a5fd0}

  /* Pattern tabs (catalog issue #163). The catalog now ships more than one pattern, and
     they are NOT variants of each other — one has an independent reviewer, one deliberately
     does not. Rendering both flows on one scroll invited a reader to mix commands and
     guarantees between them. Each pattern gets its own pane; only one is ever visible. */
  /* A vertical RAIL rather than a row of pills. Each entry carries the pattern's name,
     status and one-line positioning, so choosing between them is a reading task rather
     than a guessing one — and the rail stays visible (sticky) while the detail scrolls. */
  .pattern-layout{display:grid;grid-template-columns:minmax(300px,0.9fr) minmax(0,3fr);gap:20px;align-items:start}
  .rail{display:flex;flex-direction:column;gap:11px;position:sticky;top:78px}
  .tabs{display:flex;flex-direction:column;gap:11px;margin:0}
  .tab{text-align:left;width:100%;padding:16px 18px 17px;border-radius:22px;
    background:rgba(var(--flt),0.05);box-shadow:inset 0 3px 6px rgba(var(--flt),0.13)}
  .tab-name{font-family:var(--head);font-weight:700;font-size:17px;line-height:1.2;color:var(--mut)}
  .tab-sub{display:block;font-family:var(--body);font-weight:800;font-size:11.5px;margin-top:7px;color:var(--mut)}
  .tab-tag{display:block;font-weight:700;font-size:11.5px;line-height:1.55;margin-top:9px;color:var(--mut)}
  .tab[aria-selected=true]{background:linear-gradient(180deg,#fff,var(--card));transform:translateY(-1px);
    box-shadow:inset 0 2px 2px #fff,inset 0 -3px 6px rgba(var(--ins),0.2),0 12px 22px rgba(var(--amb),0.3)}
  .tab[aria-selected=true] .tab-name{color:var(--ink)}
  .tab[aria-selected=true] .tab-sub,.tab[aria-selected=true] .tab-tag{color:var(--sub)}
  .tab-old{font-family:var(--head);font-weight:700;font-size:14px;cursor:pointer;border:0;
       padding:9px 16px;border-radius:14px;color:var(--ink);background:var(--card);
       box-shadow:0 3px 0 rgba(var(--amb),0.18),0 6px 12px rgba(var(--amb),0.14);
       transition:transform .12s ease,box-shadow .12s ease}
  .tab:hover{transform:translateY(-2px)}
  .tab:active{transform:translateY(1px)}
  .tab[aria-selected=true]{background:#9ed095;color:#1f4526;
       box-shadow:inset 2px 3px 5px rgba(255,255,255,0.45),inset -3px -4px 7px rgba(30,90,40,0.22),0 5px 11px rgba(var(--amb),0.2)}
  .tab .tab-sub{display:block;font-family:var(--body);font-weight:700;font-size:11px;opacity:.72;margin-top:1px}
  /* Restated because an author display rule must beat the UA [hidden] rule; without it
     every pane renders at once and the tabs do nothing. */
  .pane[hidden]{display:none}
  /* Landscape is the design target, but the page must degrade rather than break. Each
     step collapses the widest grid first: hero 3->2->1, patterns rail beside -> above,
     steps 5->3->2->1. */
  @media (max-width:1360px){
    .hero-cols{grid-template-columns:minmax(360px,1.15fr) minmax(300px,0.85fr)}
    .hero-side{grid-column:1/-1;flex-direction:row;flex-wrap:wrap}
    .hero-side .fact{flex:1 1 260px}
    .steps{grid-template-columns:repeat(3,1fr)}
  }
  @media (max-width:1100px){
    .pattern-layout{grid-template-columns:1fr}
    .rail{position:static}
    .tabs{flex-direction:row;flex-wrap:wrap}
    .tab{flex:1 1 260px}
    .pattern-cols{grid-template-columns:1fr}
  }
  @media (max-width:912px){.wrap{padding-left:16px;padding-right:16px}}
  @media (max-width:860px){.hero-cols{grid-template-columns:1fr}.hero-stats{gap:18px}.steps{grid-template-columns:repeat(2,1fr)}}
  @media (max-width:540px){.steps{grid-template-columns:1fr}.pattern-head h3{flex-basis:100%}.hero-main h1{font-size:38px}}
</style>
</head>
<body>
<div class="navbar"><div class="wrap">
  <header class="nav">
    <span class="logo">${LOGO_ICON}<b>agent-templates</b></span>
    <span class="nav-sec">
      <a href="#patterns">Patterns</a>
      <a href="#pipeline">Pipeline</a>
      <a href="${GITHUB}/blob/main/ADOPTING.md">Adopting</a>
      <a href="${GITHUB}/blob/main/CHANGELOG.md">Changelog</a>
    </span>
    <span class="nav-links" style="margin-left:auto">
      <span class="nav-note">Deterministic E2E gates · MIT</span>
      <a class="btn btn-green" href="${GITHUB}">${STAR_ICON} GitHub</a>
      <a class="btn btn-orange" href="${NPM}">${NPM_ICON} npm&nbsp;&nbsp;<span data-npm-version>v${esc(pkg.version)}</span></a>
    </span>
  </header>
</div></div>

<div class="wrap page-body">
  <div class="hero">
    <div class="hero-cols">
      <div class="hero-main">
        <span class="eyebrow"><i></i>Open source · MIT · ${patterns.length} pattern${patterns.length === 1 ? '' : 's'}</span>
        <h1>Multi-agent patterns,<br>ready to drop in.</h1>
        <p class="lede">Field-proven architectures for AI-agent development — each one a design write-up <em>plus</em> working scaffolding, E2E-tested before it ships. Humans decide at two gates; the agents do the rest.</p>
        <div class="cta">
          <a class="btn btn-lg btn-blue" href="${GITHUB}/blob/main/ADOPTING.md">Adoption guide</a>
          <a class="btn btn-lg btn-purple" href="${GITHUB}/blob/main/CLAUDE.md">Operating manual</a>
        </div>
      </div>

      <div class="install-card">
        <div class="install-head">Install<span></span><code id="qs-name" style="font-family:var(--mono);font-size:10.5px;text-transform:none;letter-spacing:0">${esc(ordered[0] ? ordered[0].dir : '')}</code></div>
        <div class="quick">
          <code id="qs">${esc(QUICKSTART)}</code>
          <button class="copy" id="copy-btn" type="button">Copy</button>
        </div>
        <p class="update-note">Already installed? Update with <code>${esc(UPDATE)}</code> — commit first, <code>--force</code> overwrites changed files.</p>
      </div>

      <div class="hero-side">
        ${FACTS.map(([tile, glyph, copy]) => `<div class="fact"><span class="fact-ico" style="${tile}">${glyph}</span><p>${copy}</p></div>`).join('\n        ')}
      </div>
    </div>

    <div class="hero-stats">
      <div class="stats">
        <div class="stat stat-green"><span class="big">${patterns.length}</span><p>pattern${patterns.length === 1 ? '' : 's'} in the catalog</p></div>
      </div>
      <span class="sep"></span>
      <div class="stats"><div class="stat stat-orange"><span class="big" data-npm-version>v${esc(pkg.version)}</span><p>on npm · MIT</p></div></div>
      <span class="sep"></span>
      <div class="stats"><div class="stat stat-yellow"><span class="big">0</span><p>tokens spent in the E2E gate</p></div></div>
      <span class="sep"></span>
      <div class="stats"><div class="stat stat-blue"><span class="big">2</span><p>human gates per phase: sign-off &amp; smoke test</p></div></div>
    </div>
  </div>

  <section>
    <div class="sec-head">${PATTERNS_ICON}<h2>Patterns</h2></div>
    <div class="fact" style="margin-bottom:16px">
      <div class="fact-ico" style="${TILE_PINK}"><span class="gx" style="width:16px;height:16px"><span style="position:absolute;left:1px;top:1px;width:6px;height:14px;border-radius:3px;background:#fffaf2"></span><span style="position:absolute;right:1px;top:4px;width:6px;height:11px;border-radius:3px;background:#fffaf2"></span></span></div>
      <p><b>Choose by runtime and assurance boundary.</b> The two three-agent entries preserve the same independent-review topology on different runtimes; hub-and-spoke trades that independence for parallel throughput. Commands and guarantees do <em>not</em> carry across — <code>adopt</code> installs exactly one pattern.</p>
    </div>
  </section>

  <div class="pattern-layout">
    <div class="rail">
      <div class="tabs" role="tablist" aria-label="Patterns">
        ${tabButtons}
      </div>
      <div class="fact" style="padding:14px 16px">
        <div class="fact-ico" style="${TILE_PINK};width:22px;height:22px;border-radius:8px"><span style="width:7px;height:7px;border-radius:50%;background:#fff;display:block"></span></div>
        <p style="font-size:11.5px">These are not versions of each other. Commands, artifacts and guarantees do <em>not</em> carry across — <code>adopt</code> installs exactly one pattern.</p>
      </div>
    </div>

    <div class="panes">

  ${paneOpen(THREE, isFirst(THREE))}
  <section>
    ${byDir(THREE) ? cardFor(byDir(THREE)) : ''}
  </section>

  <section>
    <div class="sec-head">${PIPELINE_ICON}<h2>From a bare PRD.md to shipped</h2></div>
    <div class="steps">
      ${STEPS.map(([tile, glyph, t, d], i) => `<div class="step"><span class="step-ico" style="${tile}">${glyph}</span><h3>${i + 1}. ${t}</h3><p>${d}</p></div>`).join('\n      ')}
    </div>
  </section>

  <section>
    <div class="sec-head"><span style="display:inline-flex;gap:3px;align-items:flex-end;height:18px;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="width:5px;height:11px;border-radius:2.5px;background:#9ed095"></span><span style="width:5px;height:18px;border-radius:2.5px;background:#f6a5bb"></span><span style="width:5px;height:8px;border-radius:2.5px;background:#b3cdf0"></span></span><h2>Parallel delivery — opt in with one number</h2></div>
    <div class="fact" style="margin-bottom:15px">
      <div class="fact-ico" style="background:#f4cd6d;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.6),inset -3px -4px 6px rgba(180,120,20,0.25)"><span style="display:flex;gap:2px;align-items:flex-end"><span style="width:3px;height:8px;border-radius:1.5px;background:#7a5a15"></span><span style="width:3px;height:14px;border-radius:1.5px;background:#7a5a15"></span><span style="width:3px;height:11px;border-radius:1.5px;background:#7a5a15"></span></span></div>
      <p><b>concurrency</b> — one number decides the shape. <b>1 (default)</b> is the original sequential runner, one ticket at a time, unchanged. <b>N</b> (autonomous only) runs independent tickets — the ones the dependency DAG says don't block each other — as parallel lanes, scheduled by the deterministic workflow.<br>
      <code style="font-family:var(--mono);font-size:12px;color:var(--code)">/start-milestone docs/prd/01-foundation autonomous 4</code> &nbsp; <code style="font-family:var(--mono);font-size:12px;color:var(--code)">/start-all autonomous 4</code></p>
    </div>
    <div class="steps">
      <div class="step"><span class="step-ico" style="background:#9ed095;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(30,90,40,0.2)"><span style="display:flex;gap:2.5px;align-items:flex-end"><span style="width:3.5px;height:9px;border-radius:2px;background:#fffaf2"></span><span style="width:3.5px;height:15px;border-radius:2px;background:#fffaf2"></span><span style="width:3.5px;height:11px;border-radius:2px;background:#fffaf2"></span></span></span><h3>Isolated worktrees</h3><p>Each independent ticket runs in its own git worktree — builder and reviewer work there, so concurrent lanes never clash on the working tree.</p></div>
      <div class="step"><span class="step-ico" style="background:#f6a5bb;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(170,30,80,0.2)"><span class="gx" style="width:16px;height:16px"><span style="position:absolute;left:3.5px;top:1px;width:9px;height:9px;border:2.5px solid #fffaf2;border-bottom:0;border-radius:5px 5px 0 0;box-sizing:border-box"></span><span style="position:absolute;left:1px;bottom:1px;width:14px;height:9px;border-radius:3px;background:#fffaf2"></span></span></span><h3>Serialized merge</h3><p>Delivery to the default branch never overlaps; a hidden file-scope overlap surfaces as a merge conflict → abort → escalate, so nothing lands broken.</p></div>
      <div class="step"><span class="step-ico" style="background:#b3cdf0;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(40,80,150,0.22)"><span class="gx" style="width:18px;height:16px"><span style="position:absolute;left:6px;top:0;width:6px;height:6px;border-radius:50%;background:#fffaf2"></span><span style="position:absolute;left:0;bottom:1px;width:6px;height:6px;border-radius:50%;background:#fffaf2"></span><span style="position:absolute;right:0;bottom:1px;width:6px;height:6px;border-radius:50%;background:#fffaf2"></span></span></span><h3>DAG-bounded, opt-in</h3><p>A failed ticket skips its dependents; real parallelism is bounded by the dependency graph and the runtime's agent cap. <code>&gt;1</code> multiplies token spend — opt in per run.</p></div>
    </div>
  </section>

  <section>
    <div class="sec-head"><span class="gx" style="width:22px;height:18px;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="position:absolute;left:0;top:1px;width:6px;height:16px;border-radius:3px;background:#b3cdf0"></span><span style="position:absolute;left:8px;top:4px;width:6px;height:10px;border-radius:3px;background:#f6a5bb"></span><span style="position:absolute;left:16px;top:0;width:6px;height:18px;border-radius:3px;background:#f4cd6d"></span></span><h2>See the plan before you run it</h2></div>
    <div class="fact" style="margin-bottom:15px">
      <div class="fact-ico" style="background:#b3cdf0;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.6),inset -3px -4px 6px rgba(40,80,150,0.22)"><span class="gx" style="width:16px;height:14px"><span style="position:absolute;left:0;top:0;width:5px;height:5px;border-radius:50%;background:#fffaf2"></span><span style="position:absolute;left:0;bottom:0;width:5px;height:5px;border-radius:50%;background:#fffaf2"></span><span style="position:absolute;right:0;top:4.5px;width:5px;height:5px;border-radius:50%;background:#fffaf2"></span></span></div>
      <p><b><code style="font-family:var(--mono);font-size:12px;color:var(--code)">/breakdown-prd</code> writes <code style="font-family:var(--mono);font-size:12px;color:var(--code)">docs/prd/dag.html</code></b> — every ticket in one dependency graph, colored by module. A self-contained file: double-click it, no server, no build step. It tells you the <b>concurrency worth passing</b> instead of making you guess, and flags a module that can only ever use one lane — that is a file-scope decomposition problem, and Gate 1 is the cheapest moment to fix it.</p>
    </div>
    <div class="fact" style="display:block;margin-bottom:15px">
      <p style="margin:0 0 4px"><b>15 tickets, 4 modules</b> — pick a lane count and watch the same graph re-shape. This board is computed at build time by the pipeline's own scheduler, so it is the schedule you would actually get.</p>
      ${LANE_DEMO}
    </div>
    <div class="steps">
      <div class="step"><span class="step-ico" style="background:#c3abe9;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(90,50,140,0.2)"><span style="width:15px;height:15px;border:2.5px solid #fffaf2;border-radius:50%;box-sizing:border-box;border-top-color:transparent"></span></span><h3>1 lane — the shape of the DAG</h3><p>Every ticket waits for the one before it, so the board is a single column per wave and the run is as long as the ticket count. Useful as the baseline: it is what <code>concurrency</code> defaults to.</p></div>
      <div class="step"><span class="step-ico" style="background:#9ed095;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(30,90,40,0.2)"><span style="display:flex;gap:2.5px;align-items:flex-end"><span style="width:3.5px;height:15px;border-radius:2px;background:#fffaf2"></span><span style="width:3.5px;height:15px;border-radius:2px;background:#fffaf2"></span><span style="width:3.5px;height:9px;border-radius:2px;background:#fffaf2"></span></span></span><h3>More lanes — until they stop filling</h3><p>Independent tickets pack into the same wave and the run gets shorter — up to a point. Past the widest wave the extra lanes render as <b>idle</b>, which is exactly the number the page tells you not to exceed.</p></div>
      <div class="step"><span class="step-ico" style="background:#f4cd6d;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.6),inset -3px -4px 6px rgba(180,120,20,0.25)"><span class="gx" style="width:16px;height:16px"><span style="position:absolute;left:2px;top:7px;width:12px;height:2.5px;border-radius:2px;background:#7a5a15"></span><span style="position:absolute;left:6.5px;top:2.5px;width:2.5px;height:11px;border-radius:2px;background:#7a5a15"></span></span></span><h3>Where you are, mid-run</h3><p><code>/start-all</code> reloads the DAG every few finished tickets, so a ticket added while it runs is published, scheduled, and re-rendered into the same page. Re-open it during a run — or regenerate any time with <code style="font-family:var(--mono);font-size:11.5px;color:var(--code)">node .claude/scripts/dag-report.mjs docs/prd</code>.</p></div>
    </div>
  </section>

  <section>
    <div class="sec-head"><span class="gx" style="width:24px;height:18px;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="position:absolute;left:0;top:3px;width:11px;height:13px;border-radius:3px;background:#b3cdf0"></span><span style="position:absolute;left:8px;top:0;width:11px;height:13px;border-radius:3px;background:#f6a5bb"></span><span style="position:absolute;right:0;bottom:0;width:8px;height:8px;border-radius:50%;background:#9ed095"></span></span><h2>The project doesn't end at Gate 2</h2></div>
    <div class="fact" style="margin-bottom:15px">
      <div class="fact-ico" style="background:#c3abe9;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.6),inset -3px -4px 6px rgba(90,50,140,0.2)"><span class="gx" style="width:16px;height:16px"><span style="position:absolute;left:0;top:2px;width:7px;height:12px;border-radius:2px;background:#fffaf2"></span><span style="position:absolute;right:0;top:0;width:7px;height:12px;border-radius:2px;background:#fffaf2"></span></span></div>
      <p><b>The PRD document splits by phase. The ticket tree never does.</b> Write the next phase as its own PRD and point <code style="font-family:var(--mono);font-size:12px;color:var(--code)">/breakdown-prd</code> at it — it decomposes into the same <code style="font-family:var(--mono);font-size:12px;color:var(--code)">docs/prd/</code>, because <code style="font-family:var(--mono);font-size:12px;color:var(--code)">/start-all</code> schedules one global DAG and a dependency that crosses phases only resolves inside it. Then run the same command again: everything already delivered has a closed issue and filters itself out.</p>
    </div>
    <div class="fact" style="display:block;margin-bottom:15px">
      <p style="margin:0 0 8px"><b>Three commands, no migration:</b></p>
      <pre class="ph-seq"><code>docs/PRD-02-billing.md                    <span class="ph-c"># write the next phase</span>
/breakdown-prd docs/PRD-02-billing.md     <span class="ph-c"># appends modules; delivered work is frozen</span>
/start-all autonomous 2                   <span class="ph-c"># only the new tickets run</span></code></pre>
    </div>
    <div class="fact" style="display:block;margin-bottom:15px">
      <p style="margin:0 0 4px"><b>One tree, two phases</b> — toggle to see what the second run actually schedules. Both boards are computed at build time by the pipeline's own scheduler. Watch <b>BIL-1</b>: it is <code style="font-family:var(--mono);font-size:11.5px;color:var(--code)">blocked_by</code> a phase-1 ticket that already shipped — the edge every argument for splitting the tree would break.</p>
      ${PHASE_DEMO}
    </div>
    <div class="steps">
      <div class="step"><span class="step-ico" style="background:#b3cdf0;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(40,80,150,0.22)"><span class="gx" style="width:17px;height:15px"><span style="position:absolute;left:5.5px;top:0;width:6px;height:6px;border-radius:50%;background:#fffaf2"></span><span style="position:absolute;left:0;bottom:0;width:6px;height:6px;border-radius:50%;background:#fffaf2"></span><span style="position:absolute;right:0;bottom:0;width:6px;height:6px;border-radius:50%;background:#fffaf2"></span></span></span><h3>One tree, one DAG</h3><p>A parallel <code>docs/prd2/</code> would make every cross-phase dependency a dangling reference — a hard error by design. Keeping one root is what lets new work depend on shipped work.</p></div>
      <div class="step"><span class="step-ico" style="background:#9ed095;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(30,90,40,0.2)"><span class="gx" style="width:16px;height:16px"><span style="position:absolute;left:3px;top:0;width:10px;height:8px;border:2.5px solid #fffaf2;border-bottom:0;border-radius:5px 5px 0 0;box-sizing:border-box"></span><span style="position:absolute;left:0.5px;bottom:0;width:15px;height:9px;border-radius:3px;background:#fffaf2"></span></span></span><h3>Delivered work is frozen</h3><p>Existing files under <code>docs/prd/</code> may only be <b>added to</b> — never modified or deleted — and that is checked against git, not asked for politely. A shipped ticket is the record of what was built.</p></div>
      <div class="step"><span class="step-ico" style="background:#f4cd6d;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.6),inset -3px -4px 6px rgba(180,120,20,0.25)"><span class="gx" style="width:16px;height:16px"><span style="position:absolute;left:6.5px;top:1px;width:3px;height:9px;border-radius:2px;background:#7a5a15"></span><span style="position:absolute;left:6.5px;bottom:1px;width:3px;height:3px;border-radius:50%;background:#7a5a15"></span></span></span><h3>Nothing is skipped silently</h3><p>The run reports every ticket it dropped as already delivered. Edit a ticket <i>after</i> it shipped and it comes back as <b>drift</b> for a human to judge — the scheduler never re-runs it, and never hides it either.</p></div>
    </div>
  </section>
  <section>
    <div class="sec-head"><span class="gx" style="width:22px;height:18px;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="position:absolute;left:0;top:1px;width:9px;height:16px;border-radius:3px;background:#9ed095"></span><span style="position:absolute;right:0;top:5px;width:9px;height:12px;border-radius:3px;background:#c3abe9"></span></span><h2>Finish first, publish later</h2></div>
    <div class="fact" style="display:block;margin-bottom:15px">
      <p style="margin:0 0 8px"><b>The tracker is not on the critical path unless you put it there.</b> Pass <code>none</code> and every ticket merges to your <b>local</b> default branch — no push, no PR/MR, no tracker.</p>
      <p style="margin:0 0 10px"><code style="font-family:var(--mono);font-size:12px;color:var(--code)">/start-all autonomous 1 none</code></p>
      <p style="margin:0">Every delivery defect this catalog has recorded lives at the forge boundary — a pipeline gate, a protected branch, a 403 MR API, squash-merge ancestry, an expired token — and each one stopped a whole run. <b>Review is unchanged:</b> a ticket still only merges on CLEAR. What is deferred is publication, not judgement.</p>
    </div>
    <div class="steps" style="grid-template-columns:repeat(3,1fr)">
      <div class="step"><span class="step-ico" style="${TILE_GREEN}">${dotGlyph(1)}</span><h3>A committed ledger, not a scratch file</h3><p><code>docs/delivered.json</code> records each delivered ticket and the commit it landed as. That is the resume signal — a re-run executes only the new work — and what you or an agent read afterwards to know what still needs pushing. A gitignored file would vanish on the first clean checkout, exactly when it is needed.</p></div>
      <div class="step"><span class="step-ico" style="${TILE_YELLOW}">${dotGlyph(2)}</span><h3>It hands the work over</h3><p>The run ends by stating that nothing was pushed and giving the exact command — <code>git push origin main</code>. A mode that quietly accumulates work on one machine and says nothing is indistinguishable from work nobody can see.</p></div>
      <div class="step"><span class="step-ico" style="${TILE_BLUE}">${dotGlyph(3)}</span><h3>Same filter, different signal</h3><p>With no tracker there is no closed issue to resume from, so the ledger carries that role — at launch <em>and</em> at every mid-run rescan. One rule, two sources; a delivered ticket is never re-planned and re-built against work it already contains.</p></div>
    </div>
  </section>

  </div><!-- /pane three-agent -->

  ${paneOpen(CODEX_THREE, isFirst(CODEX_THREE))}
  <section>
    ${byDir(CODEX_THREE) ? cardFor(byDir(CODEX_THREE)) : ''}
  </section>
  <section>
    <div class="sec-head">${PIPELINE_ICON}<h2>Same assurance topology, Codex-native surface</h2></div>
    <div class="steps">
      <div class="step"><span class="step-ico" style="${TILE_GREEN}">${dotGlyph(1)}</span><h3>Project custom agents</h3><p><code>.codex/agents/*.toml</code> pins each role's model, reasoning effort, sandbox, and developer instructions. The Reviewer is read-only and always starts fresh.</p></div>
      <div class="step"><span class="step-ico" style="${TILE_YELLOW}">${dotGlyph(2)}</span><h3>Repository skills</h3><p><code>$breakdown-prd</code>, <code>$run-ticket</code>, and the stage skills replace Claude slash commands. <code>AGENTS.md</code> keeps the orchestration rules with the repository.</p></div>
      <div class="step"><span class="step-ico" style="${TILE_BLUE}">${dotGlyph(3)}</span><h3>Sequential by design</h3><p>The global dependency DAG is preserved, but v1 rejects parallel Builders because they share a checkout. That is a stated safety boundary, not hidden missing isolation.</p></div>
    </div>
  </section>
  <section>
    <div class="sec-head"><span class="gx" style="width:24px;height:18px;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="position:absolute;left:0;top:2px;width:10px;height:14px;border-radius:3px;background:#9ed095"></span><span style="position:absolute;right:0;top:2px;width:10px;height:14px;border-radius:3px;background:#b3cdf0"></span><span style="position:absolute;left:9px;top:7px;width:6px;height:4px;border-radius:2px;background:#f6a5bb"></span></span><h2>Both runtimes, one project</h2></div>
    <div class="fact" style="display:block;margin-bottom:15px">
      <p style="margin:0 0 8px"><b>Install this pattern <em>and</em> the Claude one in the same repo.</b> They do not collide — <code>.claude/</code> + <code>CLAUDE.md</code> sit beside <code>.codex/</code> + <code>.agents/</code> + <code>AGENTS.md</code>.</p>
      <p style="margin:0 0 10px"><code style="font-family:var(--mono);font-size:11.5px;color:var(--code)">npx agent-templates@latest adopt three-agent-architect-builder-reviewer .<br>npx agent-templates@latest adopt codex-three-agent-architect-builder-reviewer .</code></p>
      <p style="margin:0">So teammates with different tools work the same project, and one person can switch runtimes on a token budget without development stalling. <b>No hybrid pattern is offered</b> — it would add a third scaffold to maintain and a model table pinning two vendors at once, for no capability these two installs lack.</p>
    </div>
    <div class="steps" style="grid-template-columns:repeat(2,1fr)">
      <div class="step"><span class="step-ico" style="${TILE_GREEN}">${dotGlyph(1)}</span><h3>Shared: the project</h3><p>The <code>docs/prd/</code> ticket tree, the <code>[&lt;id&gt;]</code> tracker title prefix, <code>ticket/&lt;ID&gt;</code> branch names, <code>docs/plans/</code>, and the delivery ledger. A ticket planned in one runtime and built in the other works, because none of these belong to a runtime.</p></div>
      <div class="step"><span class="step-ico" style="${TILE_BLUE}">${dotGlyph(2)}</span><h3>Separate: the machinery</h3><p>Roles, entry points and guidance are runtime-native and never overlap. The E2E suite asserts that shared state is <em>not</em> runtime-scoped — a ledger under one runtime's directory would let the other re-run delivered tickets.</p></div>
    </div>
  </section>

  </div><!-- /pane codex three-agent -->

  ${paneOpen(HUB, isFirst(HUB))}
  <section>
    ${byDir(HUB) ? cardFor(byDir(HUB)) : ''}
  </section>

  <section>
    <div class="sec-head">${PIPELINE_ICON}<h2>From a bare PRD.md to shipped</h2></div>
    <div class="fact" style="margin-bottom:15px">
      <div class="fact-ico" style="${TILE_PINK}"><span class="gx" style="width:16px;height:16px"><span style="position:absolute;left:6.5px;top:1px;width:3px;height:9px;border-radius:2px;background:#fffaf2"></span><span style="position:absolute;left:6.5px;bottom:1px;width:3px;height:3px;border-radius:50%;background:#fffaf2"></span></span></div>
      <p><b>Read this before adopting.</b> The hub reviews diffs written against a contract <em>it wrote itself</em>, in the same session. That review is <b>not independent</b> — it is what this pattern trades away for cost and throughput, and it will not catch a wrong brief that was faithfully implemented. If a bad merge is expensive, use the three-agent pattern instead.</p>
    </div>
    <div class="steps">
      ${HUB_STEPS.map(([tile, glyph, t, d], i) => `<div class="step"><span class="step-ico" style="${tile}">${glyph}</span><h3>${i + 1}. ${t}</h3><p>${d}</p></div>`).join('\n      ')}
    </div>
  </section>

  <section>
    <div class="sec-head"><span class="gx" style="width:20px;height:18px;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="position:absolute;left:0;top:0;width:14px;height:18px;border-radius:3px;background:#fffaf2;box-shadow:0 1px 3px rgba(var(--amb),0.3)"></span><span style="position:absolute;left:3px;top:4px;width:8px;height:2px;border-radius:1px;background:#9ed095"></span><span style="position:absolute;left:3px;top:8px;width:8px;height:2px;border-radius:1px;background:#f6a5bb"></span><span style="position:absolute;left:3px;top:12px;width:5px;height:2px;border-radius:1px;background:#b3cdf0"></span></span><h2>What a brief is, and how big</h2></div>
    ${briefAnatomy}
    ${hubBoard}
    <div class="steps">
      <div class="step"><span class="step-ico" style="${TILE_GREEN}">${dotGlyph(1)}</span><h3>Cut on file ownership</h3><p>Not on features. Two briefs run at once exactly when their write-sets are disjoint, so the question at every boundary is <b>who writes these files</b> — never &ldquo;do these belong together&rdquo;.</p></div>
      <div class="step"><span class="step-ico" style="${TILE_YELLOW}">${dotGlyph(2)}</span><h3>Shared things go first</h3><p>Schemas, types, contracts and config land in <b>one foundation brief</b> everything else is <code>blocked_by</code>. Duplicating a shared contract to dodge a dependency produces two incompatible versions of it.</p></div>
      <div class="step"><span class="step-ico" style="${TILE_BLUE}">${dotGlyph(3)}</span><h3>A serial module is a bug now</h3><p>If a module's briefs form one straight chain it can never use more than one lane. That is a decomposition problem to fix while briefs are still cheap — not a scheduling detail to discover mid-run.</p></div>
    </div>
  </section>

  <section>
    <div class="sec-head"><span class="gx" style="width:22px;height:18px;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="position:absolute;left:0;top:1px;width:6px;height:16px;border-radius:3px;background:#9ed095"></span><span style="position:absolute;left:8px;top:4px;width:6px;height:10px;border-radius:3px;background:#f6a5bb"></span><span style="position:absolute;left:16px;top:0;width:6px;height:18px;border-radius:3px;background:#b3cdf0"></span></span><h2>Coming from the three-agent pattern?</h2></div>
    <div class="fact" style="display:block;margin-bottom:15px">
      <p style="margin:0 0 8px">The commands do <b>not</b> carry across — <code>adopt</code> installs one pattern's commands, and the scripts the other pattern's commands call are not present. The names differ on purpose: a reader who knows <code>/breakdown-prd</code> expects an independent reviewer downstream, and reusing the name would import that expectation into a pipeline that deliberately has none.</p>
      <div class="cmds">
        <div class="cmd"><code class="cmd-name">/breakdown-prd</code><code class="cmd-hint">→ /hub-brief</code><span class="cmd-desc">Same purpose, different artifact: a <b>brief</b> carries the full interface contract, its file-scope, and a per-module test command, because its implementer is forbidden to design.</span></div>
        <div class="cmd"><code class="cmd-name">/start-milestone · /start-all</code><code class="cmd-hint">→ /hub-dispatch + /hub-collect</code><span class="cmd-desc">Split in two, because the hub must come back into the loop between fanning out and merging.</span></div>
        <div class="cmd"><code class="cmd-name">/plan-ticket</code><code class="cmd-hint">→ no equivalent</code><span class="cmd-desc">The contract is already fixed in the brief; the executor does not plan.</span></div>
        <div class="cmd"><code class="cmd-name">/review-ticket</code><code class="cmd-hint">→ no equivalent</code><span class="cmd-desc">There is no independent reviewer. This is the trade, stated plainly.</span></div>
        <div class="cmd"><code class="cmd-name">/verify-delivery</code><code class="cmd-hint">→ collect.mjs gate</code><span class="cmd-desc">Runs <b>before</b> the merge rather than after it.</span></div>
        <div class="cmd"><code class="cmd-name">/publish-tickets · /nightly-issues</code><code class="cmd-hint">→ no equivalent</code><span class="cmd-desc">No tracker integration: the briefs and the branches are the record.</span></div>
      </div>
    </div>
    <div class="steps">
      <div class="step"><span class="step-ico" style="${TILE_GREEN}">${dotGlyph(1)}</span><h3>All-or-nothing dispatch</h3><p>One invalid brief dispatches <b>nothing</b>. A bad decomposition is a hub problem, and low-effort executors will not notice it — so the gate runs before any worktree exists.</p></div>
      <div class="step"><span class="step-ico" style="${TILE_YELLOW}">${dotGlyph(2)}</span><h3>A global file firewall</h3><p>No spoke writes dependency, lock, build, CI, secret or agent-config files — whatever its brief says. Deny is checked <b>before</b> scope, so a wide scope cannot launder a lockfile edit.</p></div>
      <div class="step"><span class="step-ico" style="${TILE_BLUE}">${dotGlyph(3)}</span><h3>Two verdicts that outrank success</h3><p><b>quarantined</b> beats a green test run — passing tests is exactly what would otherwise wave an out-of-scope write through. <b>unverified</b> never merges: "could not check" is not "it is fine".</p></div>
    </div>
  </section>
  </div><!-- /pane hub-and-spoke -->

    </div><!-- /panes -->
  </div><!-- /pattern-layout -->

  <footer>
    Generated from the pattern catalog by <a href="${GITHUB}/blob/main/scripts/build-site.mjs"><code>scripts/build-site.mjs</code></a>
    · ${new Date().toISOString().slice(0, 10)} · <a href="${GITHUB}/blob/main/LICENSE">MIT</a>
    · <a href="${GITHUB}/issues/new/choose">Feedback → issues</a>
  </footer>
</div>
<script>
(function(){
  // Pattern tabs. The quickstart in the hero follows the selected tab: leaving it pinned
  // to one pattern while a different pane is open is how someone copies the wrong adopt
  // command, which installs the wrong commands and the wrong guarantees.
  var QS={${ordered.map((p) => `${JSON.stringify(p.dir)}:${JSON.stringify('npx agent-templates@latest adopt ' + p.dir + ' .')}`).join(',')}}
  var qs=document.getElementById('qs'),note=document.querySelector('.update-note code')
  function pick(dir){
    document.querySelectorAll('.pane').forEach(function(p){p.hidden=p.dataset.pane!==dir})
    document.querySelectorAll('.tab').forEach(function(t){t.setAttribute('aria-selected',String(t.dataset.tab===dir))})
    if(qs&&QS[dir])qs.textContent=QS[dir]
    var qsName=document.getElementById('qs-name')
    if(qsName)qsName.textContent=dir
    if(note&&QS[dir])note.textContent=QS[dir]+' --force'
  }
  document.querySelectorAll('.tab').forEach(function(t){
    t.addEventListener('click',function(){pick(t.dataset.tab)})
  })
})();
(function(){
  // lane demo: every board is pre-rendered at build time, so switching is a
  // show/hide -- no client-side scheduling, nothing that can disagree with the runner
  var ROUNDS={${LANE_FACTS.split(',').map((p) => p.split(':')[0] + ':' + p.split(':')[1]).join(',')}},MIN=${DEMO_MIN}
  var read=document.getElementById('lane-read')
  function show(c){
    document.querySelectorAll('.lane-board').forEach(function(b){b.hidden=String(b.dataset.board)!==String(c)})
    document.querySelectorAll('.lane-b').forEach(function(b){b.setAttribute('aria-pressed',String(String(b.dataset.lane)===String(c)))})
    if(!read)return
    var r=ROUNDS[c],base=ROUNDS[1]
    read.innerHTML='<b>'+r+'</b> waves at '+c+' lane'+(c==1?'':'s')+
      (c==1?' \\u2014 the sequential baseline':' \\u2014 '+Math.round((1-r/base)*100)+'% shorter than 1 lane')+
      (r===MIN&&c>1?' \\u00b7 <b>the widest wave is already full; more lanes just idle</b>':'')
  }
  document.querySelectorAll('.lane-b').forEach(function(b){
    b.addEventListener('click',function(){show(b.dataset.lane)})
  })
  show(4)
})()
;(function(){
  // phase demo (issue #115): same pre-rendered show/hide contract as the lane demo.
  // Both wave counts came from dag-core.simulate at build time.
  var W={1:${PH_ROUNDS[1].length},2:${PH_ROUNDS[2].length}},N={1:${PH_IDS[1].length},2:${PH_IDS[2].length}}
  var read=document.getElementById('ph-read')
  function show(p){
    document.querySelectorAll('.ph-board').forEach(function(b){b.hidden=String(b.dataset.phase)!==String(p)})
    document.querySelectorAll('.ph-b').forEach(function(b){b.setAttribute('aria-pressed',String(String(b.dataset.phase)===String(p)))})
    if(!read)return
    read.innerHTML = String(p)==='1'
      ? '<b>'+N[1]+'</b> tickets \\u00b7 '+W[1]+' waves at '+${PH_CAP}+' lanes \\u2014 the first delivery, through Gate 2'
      : '<b>'+N[2]+'</b> new tickets \\u00b7 '+W[2]+' waves \\u00b7 <b>'+N[1]+' skipped</b> because their issues are closed \\u2014 same tree, same command'
  }
  document.querySelectorAll('.ph-b').forEach(function(b){b.addEventListener('click',function(){show(b.dataset.phase)})})
  show(2)
})()
;(function(){
  var b=document.getElementById('copy-btn'),q=document.getElementById('qs'),t
  if(!b||!q)return
  b.addEventListener('click',function(){
    try{navigator.clipboard.writeText(q.textContent).catch(function(){})}catch(e){}
    b.textContent='Copied!'
    clearTimeout(t)
    t=setTimeout(function(){b.textContent='Copy'},1400)
  })
})()
fetch('https://registry.npmjs.org/agent-templates').then(function(r){return r.json()}).then(function(d){
  var v=d['dist-tags']&&d['dist-tags'].latest
  if(v){document.querySelectorAll('[data-npm-version]').forEach(function(e){e.textContent='v'+v})}
}).catch(function(){})
</script>
</body>
</html>
`

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'index.html'), html)
writeFileSync(join(OUT, '.nojekyll'), '')
console.log(`site: ${join(OUT, 'index.html')} (${patterns.length} pattern(s), pkg v${pkg.version})`)
