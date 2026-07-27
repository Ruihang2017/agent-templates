// E2E for dag-report.mjs: fixture PRD trees -> assert the derived lane profile
// (lanes, waves, recommended concurrency), BOTH schedules and the barrier cost between
// them, the self-contained deterministic HTML, and the same loud failure paths
// milestone-dag.mjs enforces.
//
// The numbers are the whole point of the feature — a human passes the recommended
// value straight to /start-all, and the runner-vs-global delta is the evidence for
// whether the module barrier is worth removing — so they are asserted against
// hand-computed fixtures, not against whatever the implementation happens to produce.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'dagreport'
const SCRIPT = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/dag-report.mjs', import.meta.url))

const ticket = (id, blockedBy = []) =>
  `---\nid: ${id}\ntitle: Ticket ${id}\nmodule: m\nlane: A\nsize: S\nagent: builder\nstatus: ready\ndate: 2026-07-27\nblocked_by: [${blockedBy.join(', ')}]\nblocks: []\n---\n\n# ${id}\n`

function makeTree(spec) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-dagrep-'))
  for (const [mod, tickets] of Object.entries(spec)) {
    const tdir = join(root, 'prd', mod, 'tickets')
    mkdirSync(tdir, { recursive: true })
    for (const [id, deps] of tickets) writeFileSync(join(tdir, `${id}.md`), ticket(id, deps))
  }
  return root
}

function runReport(prdPath, extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, prdPath, ...extra], { encoding: 'utf8' })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('DAG-REPORT-JSON: '))
  let json = null
  try { json = line ? JSON.parse(line.slice('DAG-REPORT-JSON: '.length)) : null } catch {}
  return { ...r, json }
}

const modOf = (json, name) => (json ? json.modules.find((m) => m.name === name) : null)
const embedded = (html) => {
  const m = html.match(/<script id="dag-data"[^>]*>([\s\S]*?)<\/script>/)
  return m ? JSON.parse(m[1].replace(/\\u003c/g, '<')) : null
}

export async function run() {
  // R1: hand-computed five-module tree.
  //   01-core: 0101,0102 free; 0103<-0101; 0104<-0102; 0105<-0103,0104 => 2 lanes, 3 waves
  //   02-api:  0201..0204 <- 0105 (CROSS-module); 0205<-0201, 0206<-0202, 0207<-0203
  //                                                                    => 4 lanes, 2 waves
  //   05-jobs: 0501 -> 0502 -> 0503 -> 0504 (one chain)                => 1 lane,  4 waves
  //   06-extra: two free tickets                                       => 2 lanes, 1 wave
  //   07-more:  one free ticket                                        => 1 lane,  1 wave
  //   recommended = max(2,4,1,2,1) = 4
  //   runner rounds @4 = 3+2+4+1+1 = 11 ; global rounds @4 = 5
  const t1 = makeTree({
    '01-core': [['0101', []], ['0102', []], ['0103', ['0101']], ['0104', ['0102']], ['0105', ['0103', '0104']]],
    '02-api': [['0201', ['0105']], ['0202', ['0105']], ['0203', ['0105']], ['0204', ['0105']],
      ['0205', ['0201']], ['0206', ['0202']], ['0207', ['0203']]],
    '05-jobs': [['0501', []], ['0502', ['0501']], ['0503', ['0502']], ['0504', ['0503']]],
    '06-extra': [['0601', []], ['0602', []]],
    '07-more': [['0701', []]],
  })
  const r1 = runReport(join(t1, 'prd'))
  check(S, 'R1 exit 0', r1.status === 0, r1.stderr)
  check(S, 'R1 emits DAG-REPORT-JSON', r1.json !== null)
  eq(S, 'R1 recommended concurrency is the MAX across modules (not the sum)', r1.json && r1.json.recommendedConcurrency, 4)
  eq(S, 'R1 total tickets', r1.json && r1.json.totalTickets, 19)
  eq(S, 'R1 01-core lanes', modOf(r1.json, '01-core').maxUsefulLanes, 2)
  eq(S, 'R1 01-core waves', modOf(r1.json, '01-core').minWaves, 3)
  eq(S, 'R1 02-api lanes (cross-module blocked_by must NOT gate intra-module lanes)', modOf(r1.json, '02-api').maxUsefulLanes, 4)
  eq(S, 'R1 05-jobs is fully serial', modOf(r1.json, '05-jobs').maxUsefulLanes, 1)
  eq(S, 'R1 module order puts the cross-module dependency first', r1.json && r1.json.modules[0].name, '01-core')
  check(S, 'R1 stdout states the recommended /start-all command', /\/start-all autonomous 4/.test(r1.stdout))
  check(S, 'R1 stdout flags the serial module', /fully serial/.test(r1.stdout))
  eq(S, 'R1 reports a forward-slash path on every platform', r1.json && r1.json.out.includes('\\'), false)

  // R2: the two schedules and the barrier cost between them
  const sch = r1.json && r1.json.schedules
  eq(S, 'R2 runner rounds at the recommendation = sum of per-module waves', sch && sch.atRecommended.runnerRounds, 11)
  eq(S, 'R2 global rounds at the recommendation', sch && sch.atRecommended.globalRounds, 5)
  check(S, 'R2 a global schedule is never slower than the runner schedule',
    sch && sch.globalMinRounds <= sch.runnerMinRounds)
  check(S, 'R2 stdout prices the module barrier', /lost to the module barrier/.test(r1.stdout))
  check(S, 'R2 stdout says the global schedule is not executable today', /not executable today/.test(r1.stdout))

  const html1 = readFileSync(join(t1, 'prd', 'dag.html'), 'utf8')
  const data = embedded(html1)
  check(S, 'R2 page embeds both schedule tables', data && Array.isArray(data.runner) && Array.isArray(data.global))
  eq(S, 'R2 embedded runner schedule at cap 4 matches the JSON contract', data && data.runner[3].length, 11)
  eq(S, 'R2 embedded global schedule at cap 4 matches the JSON contract', data && data.global[3].length, 5)
  check(S, 'R2 every ticket appears exactly once per schedule',
    data && [data.runner[3], data.global[3]].every((rounds) => {
      const flat = rounds.flat()
      return flat.length === 19 && new Set(flat).size === 19
    }))
  check(S, 'R2 a schedule never places a ticket before one it is blocked_by',
    data && [data.runner[3], data.global[3]].every((rounds) => {
      const waveOf = {}
      rounds.forEach((b, i) => b.forEach((id) => { waveOf[id] = i }))
      return Object.entries(data.tickets).every(([id, t]) => t.deps.every((d) => waveOf[d] < waveOf[id]))
    }))

  // R3: ONE flowchart for the whole PRD — not one chart per module (issue #68)
  eq(S, 'R3 exactly one flowchart element', (html1.match(/class="flow"/g) || []).length, 1)
  check(S, 'R3 no per-module chart sections remain', !/class="mod"/.test(html1))
  check(S, 'R3 page offers both schedule modes', /data-mode="runner"/.test(html1) && /data-mode="global"/.test(html1))
  check(S, 'R3 page states the global schedule is not executable yet', /not executable/i.test(html1))
  check(S, 'R3 cross-module dependencies are carried into the graph',
    data && data.tickets['0201'].deps.includes('0105'))
  check(S, 'R3 legend has one entry per module',
    (html1.match(/class="legend"[\s\S]*?<\/div>/) || [''])[0].split('data-mod=').length - 1 === 5)

  // R4: categorical color — fixed order, never cycled; the 5th module takes the neutral
  // and stays identifiable by its chip, so identity is never carried by hue alone.
  eq(S, 'R4 module 1 takes categorical slot 0', data && data.modules[0].slot, 0)
  eq(S, 'R4 module 4 takes categorical slot 3', data && data.modules[3].slot, 3)
  eq(S, 'R4 module 5 takes the neutral rather than a generated hue', data && data.modules[4].slot, -1)
  check(S, 'R4 page defines the validated 4-hue palette in both modes',
    ['#2a78d6', '#eda100', '#e87ba4', '#008300', '#3987e5', '#c98500', '#d55181'].every((h) => html1.includes(h)))
  check(S, 'R4 every ticket carries its module name (secondary encoding, not hue alone)',
    data && Object.values(data.tickets).every((t) => typeof t.m === 'string' && t.m.length > 0))
  check(S, 'R4 a table view exists (relief rule for the low-contrast slots)', /<table>/.test(html1))

  // R5: self-contained + deterministic. Determinism is what lets the page be committed
  // and diffed in the breakdown PR instead of churning on every run.
  check(S, 'R5 page has no external resource references', !/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html1))
  check(S, 'R5 page issues no network calls', !/\bfetch\s*\(|XMLHttpRequest|importScripts/.test(html1))
  runReport(join(t1, 'prd'))
  const html2 = readFileSync(join(t1, 'prd', 'dag.html'), 'utf8')
  eq(S, 'R5 re-run is byte-identical (no timestamp / no machine-specific value)', html2 === html1, true)
  check(S, 'R5 page embeds no resolved core count', !/cores\s*[-=]\s*2\s*=/.test(html1))
  check(S, 'R5 page is LF-only', !/\r/.test(html1))

  // R6: --out redirects the page without changing the analysis
  const alt = join(t1, 'elsewhere', 'plan.html')
  const r6 = runReport(join(t1, 'prd'), ['--out', alt])
  check(S, 'R6 --out exit 0', r6.status === 0, r6.stderr)
  eq(S, 'R6 --out is honored in the JSON contract', r6.json && r6.json.out.replace(/\\/g, '/'), alt.replace(/\\/g, '/'))
  check(S, 'R6 --out creates missing parent directories', readFileSync(alt, 'utf8').length > 0)
  eq(S, 'R6 --out does not change the recommendation', r6.json && r6.json.recommendedConcurrency, 4)

  // R7: a single module means there is no barrier to price — the two schedules agree
  const t7 = makeTree({ '01-wide': [['W1', []], ['W2', []], ['W3', []], ['W4', []], ['W5', []]] })
  const r7 = runReport(join(t7, 'prd'))
  eq(S, 'R7 fully independent tickets => lanes == ticket count', r7.json && r7.json.recommendedConcurrency, 5)
  eq(S, 'R7 one module => the module barrier costs nothing',
    r7.json && r7.json.schedules.atRecommended.runnerRounds, r7.json && r7.json.schedules.atRecommended.globalRounds)
  check(S, 'R7 stdout says the barrier is free here', /barrier costs nothing/.test(r7.stdout))
  check(S, 'R7 a fully parallel module is NOT flagged serial', !/fully serial/.test(r7.stdout))

  // R8: single ticket — degenerate case must not crash or divide by zero
  const t8 = makeTree({ '01-solo': [['S1', []]] })
  const r8 = runReport(join(t8, 'prd'))
  check(S, 'R8 single-ticket module exit 0', r8.status === 0, r8.stderr)
  eq(S, 'R8 single ticket => 1 lane', r8.json && r8.json.recommendedConcurrency, 1)
  check(S, 'R8 a single-ticket module is not flagged serial', !/fully serial/.test(r8.stdout))

  // R9: recommendation follows the WIDEST wave, not an average
  const t9 = makeTree({
    '01-fan': [['F1', []], ['F2', []], ['F3', []], ['F4', []], ['F5', ['F1', 'F2', 'F3', 'F4']]],
  })
  const r9 = runReport(join(t9, 'prd'))
  eq(S, 'R9 recommendation follows the widest wave', r9.json && r9.json.recommendedConcurrency, 4)
  eq(S, 'R9 fan-in module waves', modOf(r9.json, '01-fan').minWaves, 2)

  // R10..R13: the same spec defects milestone-dag.mjs rejects must fail here too —
  // handing a broken DAG to Gate 1 as a pretty page would be worse than no page.
  const t10 = makeTree({ '01-a': [['A1', ['NOPE-9']]] })
  const r10 = runReport(join(t10, 'prd'))
  eq(S, 'R10 dangling blocked_by exits 1', r10.status, 1)
  check(S, 'R10 names the unknown ticket', /NOPE-9/.test(r10.stderr))

  const t11 = makeTree({ '01-a': [['A1', ['A2']], ['A2', ['A1']]] })
  const r11 = runReport(join(t11, 'prd'))
  eq(S, 'R11 intra-module cycle exits 1', r11.status, 1)
  check(S, 'R11 names the cycle members', /A1/.test(r11.stderr) && /A2/.test(r11.stderr))

  const r12 = runReport(join(tmpdir(), 'e2e-dagrep-does-not-exist'))
  eq(S, 'R12 missing prd root exits 1', r12.status, 1)
  check(S, 'R12 says which root was missing', /no such prd root/.test(r12.stderr))

  const t13 = makeTree({ '01-a': [['A1', ['B1']]], '02-b': [['B1', ['A1']]] })
  const r13 = runReport(join(t13, 'prd'))
  eq(S, 'R13 cross-module cycle exits 1', r13.status, 1)
  check(S, 'R13 names the cycling modules', /01-a/.test(r13.stderr) && /02-b/.test(r13.stderr))
}
