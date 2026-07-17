// E2E for milestone-dag.mjs: fixture PRD trees -> assert topo order, cross-module
// dependency derivation from ticket blocked_by frontmatter, and the error paths
// (dangling reference, cycle) that must fail loudly (zero-silence).

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'dag'
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
}
