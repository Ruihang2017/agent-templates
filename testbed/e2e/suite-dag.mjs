// E2E for milestone-dag.mjs: fixture PRD trees -> assert topo order, cross-module
// dependency derivation from ticket blocked_by frontmatter, and the error paths
// (dangling reference, cycle) that must fail loudly (zero-silence).

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'dag'
const SCAN = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/dag-scan.mjs', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/milestone-dag.mjs', import.meta.url))

const ticket = (id, blockedBy = []) =>
  `---\nid: ${id}\ntitle: t\nmodule: m\nlane: m\nsize: S\nagent: builder\nstatus: ready\ndate: 2026-07-18\nblocked_by: [${blockedBy.join(', ')}]\nblocks: []\n---\n\n# ${id}\n`

function makeTree(spec) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-dag-'))
  for (const [mod, tickets] of Object.entries(spec)) {
    const tdir = join(root, 'prd', mod, 'tickets')
    mkdirSync(tdir, { recursive: true })
    for (const [id, deps] of tickets) writeFileSync(join(tdir, `${id}.md`), ticket(id, deps))
  }
  return root
}

function runDag(prdPath) {
  const r = spawnSync(process.execPath, [SCRIPT, prdPath], { encoding: 'utf8' })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('DAG-JSON: '))
  let dag = null
  try { dag = line ? JSON.parse(line.slice('DAG-JSON: '.length)) : null } catch {}
  return { ...r, dag }
}

export async function run() {
  // The shipped template must survive the shipped parser (catalog issue #185).
  //
  // `templates/ticket.template.md` opens with an HTML comment, and every frontmatter
  // regex was anchored at position 0 — so a ticket written LITERALLY from the file the
  // Architect is told to follow extracted no frontmatter, was reported as "missing
  // frontmatter id", never entered the DAG, and the run still reported clean. It worked
  // only because authors happened to know to delete the comment; the template was
  // documentation that must not be followed literally.
  //
  // This drives the real template through the real scan, so the two cannot drift apart
  // again — the parser could be tightened, or the template regrown a preamble, and either
  // one fails here.
  {
    const root = mkdtempSync(join(tmpdir(), 'e2e-dag-tpl-'))
    try {
      const tdir = join(root, 'docs', 'prd', '00-x', 'tickets')
      mkdirSync(tdir, { recursive: true })
      const template = readFileSync(fileURLToPath(new URL('../../templates/ticket.template.md', import.meta.url)), 'utf8')
      check(S, 'the shipped ticket template still opens with a comment', /^\s*<!--/.test(template))
      writeFileSync(join(tdir, 'MOD-NN.md'), template)
      const r = spawnSync(process.execPath, [SCAN, join(root, 'docs', 'prd')], { encoding: 'utf8' })
      const line = (r.stdout || '').split('\n').find((l) => l.startsWith('SCAN-JSON: '))
      const scan = line ? JSON.parse(line.slice('SCAN-JSON: '.length)) : null
      check(S, 'a ticket written literally from the template is VISIBLE to the DAG',
        scan && scan.count === 1, (r.stdout || '') + (r.stderr || ''))
      check(S, 'and it is not reported as missing its frontmatter id',
        !/missing frontmatter id/.test((r.stdout || '') + (r.stderr || '')))
      eq(S, 'its id is read from the template frontmatter',
        scan && scan.tickets && scan.tickets[0] && scan.tickets[0].id, 'MOD-NN')
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  // D1: chain + diamond — 00-f <- (01-a, 02-b) <- 03-c
  const t1 = makeTree({
    '00-f': [['FND-1', []]],
    '01-a': [['A-1', ['FND-1']]],
    '02-b': [['B-1', ['FND-1']]],
    '03-c': [['C-1', ['A-1', 'B-1']]],
  })
  try {
    const r = runDag(join(t1, 'prd'))
    eq(S, 'D1 exit 0', r.status, 0)
    eq(S, 'D1 topo order', r.dag && r.dag.order, ['00-f', '01-a', '02-b', '03-c'])
    eq(S, 'D1 diamond deps derived from blocked_by', r.dag && r.dag.modules['03-c'].dependsOn, ['01-a', '02-b'])
    eq(S, 'D1 foundation has no deps', r.dag && r.dag.modules['00-f'].dependsOn, [])
  } finally {
    rmSync(t1, { recursive: true, force: true })
  }

  // D2: dangling blocked_by reference is a hard error
  const t2 = makeTree({ '00-f': [['FND-1', ['NOPE-9']]] })
  try {
    const r = runDag(join(t2, 'prd'))
    eq(S, 'D2 dangling ref exits 1', r.status, 1)
    check(S, 'D2 names the unknown ticket', /unknown ticket 'NOPE-9'/.test(r.stderr))
  } finally {
    rmSync(t2, { recursive: true, force: true })
  }

  // D3: cross-module cycle is a hard error
  const t3 = makeTree({
    '01-a': [['A-1', ['B-1']]],
    '02-b': [['B-1', ['A-1']]],
  })
  try {
    const r = runDag(join(t3, 'prd'))
    eq(S, 'D3 cycle exits 1', r.status, 1)
    check(S, 'D3 names the cycle members', /cycle/.test(r.stderr) && r.stderr.includes('01-a') && r.stderr.includes('02-b'))
  } finally {
    rmSync(t3, { recursive: true, force: true })
  }

  // D4: missing root
  const r4 = runDag(join(tmpdir(), 'definitely-no-such-prd-root'))
  eq(S, 'D4 missing root exits 1', r4.status, 1)

  // D5: intra-module blocked_by creates no module edge
  const t5 = makeTree({ '00-solo': [['S-1', []], ['S-2', ['S-1']]] })
  try {
    const r = runDag(join(t5, 'prd'))
    eq(S, 'D5 exit 0', r.status, 0)
    eq(S, 'D5 single module, no self-dependency', r.dag && r.dag.modules['00-solo'].dependsOn, [])
    eq(S, 'D5 both tickets listed', r.dag && r.dag.modules['00-solo'].tickets.length, 2)
  } finally {
    rmSync(t5, { recursive: true, force: true })
  }

  // D6: tickets are topologically ordered by intra-module blocked_by, NOT ID order
  // (catalog issue #31 — Groundwork2 05-jobs-fit: 0502 blocked_by 0503, ID order inverts it).
  // Cross-module deps (GW2-0304) must be ignored for intra-module ordering.
  const t6 = makeTree({
    '04-x': [['GW2-0304', []]],
    '05-jobs-fit': [
      ['GW2-0501', []],
      ['GW2-0502', ['GW2-0304', 'GW2-0501', 'GW2-0503']],
      ['GW2-0503', ['GW2-0501']],
      ['GW2-0504', ['GW2-0502']],
    ],
  })
  try {
    const r = runDag(join(t6, 'prd'))
    eq(S, 'D6 exit 0', r.status, 0)
    eq(S, 'D6 tickets topo-ordered by intra-module blocked_by', r.dag && r.dag.modules['05-jobs-fit'].tickets, ['GW2-0501', 'GW2-0503', 'GW2-0502', 'GW2-0504'])
    eq(S, 'D6 cross-module dep derived as a module edge', r.dag && r.dag.modules['05-jobs-fit'].dependsOn, ['04-x'])
    eq(S, 'D6 module order puts the dependency first', r.dag && r.dag.order, ['04-x', '05-jobs-fit'])
  } finally {
    rmSync(t6, { recursive: true, force: true })
  }

  // D7: intra-module dependency cycle fails loudly (zero-silence), names the members
  const t7 = makeTree({ '00-loop': [['L-1', ['L-2']], ['L-2', ['L-1']]] })
  try {
    const r = runDag(join(t7, 'prd'))
    eq(S, 'D7 intra-module cycle exits 1', r.status, 1)
    check(S, 'D7 names the module and members', /intra-module dependency cycle in 00-loop/.test(r.stderr) && r.stderr.includes('L-1') && r.stderr.includes('L-2'))
  } finally {
    rmSync(t7, { recursive: true, force: true })
  }

  // D8: ID order is the tiebreak when tickets are independent
  const t8 = makeTree({ '00-indep': [['Z-9', []], ['A-1', []], ['M-5', []]] })
  try {
    const r = runDag(join(t8, 'prd'))
    eq(S, 'D8 independent tickets fall back to ID order', r.dag && r.dag.modules['00-indep'].tickets, ['A-1', 'M-5', 'Z-9'])
  } finally {
    rmSync(t8, { recursive: true, force: true })
  }
}
