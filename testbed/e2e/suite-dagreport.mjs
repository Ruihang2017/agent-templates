// E2E for dag-report.mjs: fixture PRD trees -> assert the derived lane profile
// (lanes, waves, recommended concurrency), the self-contained deterministic HTML, and
// the same loud failure paths milestone-dag.mjs enforces.
//
// The lane numbers are the whole point of the feature — a human passes the recommended
// value straight to /start-all — so they are asserted against hand-computed fixtures,
// not against whatever the implementation happens to produce.

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

export async function run() {
  // R1: hand-computed three-module tree.
  //   01-core: 0101,0102 free; 0103<-0101; 0104<-0102; 0105<-0103,0104  => 2 lanes, 3 waves
  //   02-api:  0201..0204 <- 0105 (CROSS-module, must not gate lanes);
  //            0205<-0201, 0206<-0202, 0207<-0203                       => 4 lanes, 2 waves
  //   05-jobs: 0501 -> 0502 -> 0503 -> 0504 (one chain)                 => 1 lane,  4 waves
  //   recommended = max(2,4,1) = 4
  const t1 = makeTree({
    '01-core': [['0101', []], ['0102', []], ['0103', ['0101']], ['0104', ['0102']], ['0105', ['0103', '0104']]],
    '02-api': [['0201', ['0105']], ['0202', ['0105']], ['0203', ['0105']], ['0204', ['0105']],
      ['0205', ['0201']], ['0206', ['0202']], ['0207', ['0203']]],
    '05-jobs': [['0501', []], ['0502', ['0501']], ['0503', ['0502']], ['0504', ['0503']]],
  })
  const r1 = runReport(join(t1, 'prd'))
  check(S, 'R1 exit 0', r1.status === 0, r1.stderr)
  check(S, 'R1 emits DAG-REPORT-JSON', r1.json !== null)
  eq(S, 'R1 recommended concurrency is the MAX across modules (not the sum)', r1.json && r1.json.recommendedConcurrency, 4)
  eq(S, 'R1 total tickets', r1.json && r1.json.totalTickets, 16)
  eq(S, 'R1 01-core lanes', modOf(r1.json, '01-core').maxUsefulLanes, 2)
  eq(S, 'R1 01-core waves', modOf(r1.json, '01-core').minWaves, 3)
  eq(S, 'R1 02-api lanes (cross-module blocked_by must NOT gate intra-module lanes)', modOf(r1.json, '02-api').maxUsefulLanes, 4)
  eq(S, 'R1 02-api waves', modOf(r1.json, '02-api').minWaves, 2)
  eq(S, 'R1 05-jobs is fully serial', modOf(r1.json, '05-jobs').maxUsefulLanes, 1)
  eq(S, 'R1 05-jobs waves = chain length', modOf(r1.json, '05-jobs').minWaves, 4)
  eq(S, 'R1 module order puts the cross-module dependency first', r1.json && r1.json.modules[0].name, '01-core')
  eq(S, 'R1 02-api records its cross-module dependency', modOf(r1.json, '02-api').dependsOn.join(','), '01-core')
  check(S, 'R1 stdout states the recommended /start-all command', /\/start-all autonomous 4/.test(r1.stdout))
  check(S, 'R1 stdout flags the serial module', /fully serial/.test(r1.stdout))
  eq(S, 'R1 reports a forward-slash path on every platform', r1.json && r1.json.out.includes('\\'), false)

  // R2: the page itself — self-contained, deterministic, LF, and carrying the numbers.
  const html1 = readFileSync(join(t1, 'prd', 'dag.html'), 'utf8')
  check(S, 'R2 page written to <prd-root>/dag.html', html1.length > 0)
  check(S, 'R2 page has no external resource references', !/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html1))
  check(S, 'R2 page issues no network calls', !/\bfetch\s*\(|XMLHttpRequest|importScripts/.test(html1))
  check(S, 'R2 page states the recommended concurrency', /recommended concurrency/i.test(html1) && /\/start-all autonomous 4/.test(html1))
  check(S, 'R2 page names every module', ['01-core', '02-api', '05-jobs'].every((m) => html1.includes(m)))
  check(S, 'R2 page marks the serial module', /fully serial/i.test(html1))
  check(S, 'R2 page embeds the lane data as JSON', /id="dag-data"/.test(html1))
  check(S, 'R2 page escapes < inside the embedded JSON (no premature </script>)', !/<script id="dag-data"[^>]*>[^]*?<\/[a-z]/i.test(html1.slice(html1.indexOf('id="dag-data"'))) || html1.includes('\\u003c'))
  // Deterministic output is what lets the page be committed and diffed in the
  // breakdown PR: a timestamp or a machine core count would churn it every run.
  runReport(join(t1, 'prd'))
  const html2 = readFileSync(join(t1, 'prd', 'dag.html'), 'utf8')
  eq(S, 'R2 re-run is byte-identical (no timestamp / no machine-specific value)', html2 === html1, true)
  check(S, 'R2 page embeds no resolved core count', !/cores\s*[-=]\s*2\s*=/.test(html1))
  check(S, 'R2 page is LF-only', !/\r/.test(html1))

  // R3: --out redirects the page without changing the analysis
  const alt = join(t1, 'elsewhere', 'plan.html')
  const r3 = runReport(join(t1, 'prd'), ['--out', alt])
  check(S, 'R3 --out exit 0', r3.status === 0, r3.stderr)
  eq(S, 'R3 --out is honored in the JSON contract', r3.json && r3.json.out.replace(/\\/g, '/'), alt.replace(/\\/g, '/'))
  check(S, 'R3 --out creates missing parent directories', readFileSync(alt, 'utf8').length > 0)
  eq(S, 'R3 --out does not change the recommendation', r3.json && r3.json.recommendedConcurrency, 4)

  // R4: fully parallel module — every ticket independent
  const t4 = makeTree({ '01-wide': [['W1', []], ['W2', []], ['W3', []], ['W4', []], ['W5', []]] })
  const r4 = runReport(join(t4, 'prd'))
  eq(S, 'R4 fully independent tickets => lanes == ticket count', r4.json && r4.json.recommendedConcurrency, 5)
  eq(S, 'R4 fully independent tickets => one wave', modOf(r4.json, '01-wide').minWaves, 1)
  check(S, 'R4 a fully parallel module is NOT flagged serial', !/fully serial/.test(r4.stdout))

  // R5: single ticket — degenerate case must not crash or divide by zero
  const t5 = makeTree({ '01-solo': [['S1', []]] })
  const r5 = runReport(join(t5, 'prd'))
  check(S, 'R5 single-ticket module exit 0', r5.status === 0, r5.stderr)
  eq(S, 'R5 single ticket => 1 lane', r5.json && r5.json.recommendedConcurrency, 1)
  eq(S, 'R5 single ticket => 1 wave', modOf(r5.json, '01-solo').minWaves, 1)
  check(S, 'R5 a single-ticket module is not flagged serial', !/fully serial/.test(r5.stdout))

  // R6: a wide-then-narrow module — the recommendation must come from the WIDEST wave,
  // not from an average, or the runner would serialize the wide wave.
  const t6 = makeTree({
    '01-fan': [['F1', []], ['F2', []], ['F3', []], ['F4', []], ['F5', ['F1', 'F2', 'F3', 'F4']]],
  })
  const r6 = runReport(join(t6, 'prd'))
  eq(S, 'R6 recommendation follows the widest wave', r6.json && r6.json.recommendedConcurrency, 4)
  eq(S, 'R6 fan-in module waves', modOf(r6.json, '01-fan').minWaves, 2)

  // R7..R9: the same spec defects milestone-dag.mjs rejects must fail here too —
  // handing a broken DAG to Gate 1 as a pretty page would be worse than no page.
  const t7 = makeTree({ '01-a': [['A1', ['NOPE-9']]] })
  const r7 = runReport(join(t7, 'prd'))
  eq(S, 'R7 dangling blocked_by exits 1', r7.status, 1)
  check(S, 'R7 names the unknown ticket', /NOPE-9/.test(r7.stderr))

  const t8 = makeTree({ '01-a': [['A1', ['A2']], ['A2', ['A1']]] })
  const r8 = runReport(join(t8, 'prd'))
  eq(S, 'R8 intra-module cycle exits 1', r8.status, 1)
  check(S, 'R8 names the cycle members', /A1/.test(r8.stderr) && /A2/.test(r8.stderr))

  const r9 = runReport(join(tmpdir(), 'e2e-dagrep-does-not-exist'))
  eq(S, 'R9 missing prd root exits 1', r9.status, 1)
  check(S, 'R9 says which root was missing', /no such prd root/.test(r9.stderr))

  // R10: cross-module cycle (module-level, not ticket-level)
  const t10 = makeTree({ '01-a': [['A1', ['B1']]], '02-b': [['B1', ['A1']]] })
  const r10 = runReport(join(t10, 'prd'))
  eq(S, 'R10 cross-module cycle exits 1', r10.status, 1)
  check(S, 'R10 names the cycling modules', /01-a/.test(r10.stderr) && /02-b/.test(r10.stderr))
}
