// E2E for wave-plan.mjs — the deterministic scheduler.
//
// Delivery moved to the orchestrator (catalog issue #206), which took scheduling out of
// the workflow sandbox with it. "Which tickets may run now" is exactly the kind of control
// flow this catalog has already watched prose get wrong, so it became a script rather than
// an instruction — and these are the assertions that used to live in suite-startall.mjs
// and suite-parallel.mjs against the retired schedulers. They are ported, not dropped:
// removing a scheduler must not quietly remove the checks that made it trustworthy.
//
// Zero tokens, zero network.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'waveplan'
const SCRIPT = fileURLToPath(
  new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/wave-plan.mjs', import.meta.url)
)

// A ticket file is the REAL shipped format — frontmatter behind a leading HTML comment,
// which is how templates/ticket.template.md actually opens (catalog issue #185). Writing a
// simplified fixture here would test a parser nobody runs.
const ticket = (id, blockedBy = []) =>
  `<!-- a comment above the frontmatter, exactly as the shipped template has -->\n` +
  `---\nid: ${id}\ntitle: ticket ${id}\nmodule: m\nsize: S\nstatus: ready\n` +
  `blocked_by: [${blockedBy.join(', ')}]\nblocks: []\n---\n\n# ${id}\n`

function makePrd(spec) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-wave-'))
  for (const [mod, tickets] of Object.entries(spec)) {
    const dir = join(root, 'prd', mod, 'tickets')
    mkdirSync(dir, { recursive: true })
    for (const [id, deps] of Object.entries(tickets)) {
      writeFileSync(join(dir, `${id}.md`), ticket(id, deps))
    }
  }
  return root
}

function plan(root, args = [], opts = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, join(root, 'prd'), ...args], {
    encoding: 'utf8',
    cwd: opts.cwd || root,
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('WAVE-PLAN-JSON: '))
  let json = null
  try { json = line ? JSON.parse(line.slice('WAVE-PLAN-JSON: '.length)) : null } catch {}
  return { status: r.status, out, json }
}

const ids = (rows) => (rows || []).map((r) => (typeof r === 'string' ? r : r.id)).sort()

export async function run() {
  // A diamond spanning two modules: the cross-module edge is the one a module barrier
  // used to approximate, and got wrong.
  //   A-1  A-2      (no deps)
  //     \  /
  //      A-3        (needs A-1, A-2)
  //   B-1           (needs A-1 — CROSS-MODULE)
  const diamond = { '01-a': { 'A-1': [], 'A-2': [], 'A-3': ['A-1', 'A-2'] }, '02-b': { 'B-1': ['A-1'] } }

  // ---- P1: the first wave is everything with no blockers -------------------------------
  {
    const root = makePrd(diamond)
    const { status, json } = plan(root)
    eq(S, 'P1 exit 0 on a healthy graph', status, 0)
    eq(S, 'P1 the first wave is exactly the unblocked tickets', ids(json.ready), ['A-1', 'A-2'])
    eq(S, 'P1 the rest are reported as blocked, not omitted', ids(json.blocked), ['A-3', 'B-1'])
    eq(S, 'P1 and each says what it waits on', json.blocked.find((b) => b.id === 'B-1').waitingOn, ['A-1'])
    eq(S, 'P1 not done while work remains', json.done, false)
    eq(S, 'P1 the ticket count is the whole graph', json.ticketCount, 4)
    check(S, 'P1 ready rows carry the path the workflow needs', json.ready.every((r) => r.path.endsWith('.md')))
    rmSync(root, { recursive: true, force: true })
  }

  // ---- P2: a wave is never allowed to contain an edge ------------------------------------
  // This is THE invariant run-wave.js depends on: a dependent built in the same run as its
  // blocker is built against a tree that does not contain the work it depends on.
  {
    const root = makePrd(diamond)
    for (const delivered of [[], ['A-1'], ['A-1', 'A-2'], ['A-1', 'A-2', 'A-3']]) {
      const { json } = plan(root, delivered.length ? ['--delivered', delivered.join(',')] : [])
      const inWave = new Set(json.ready.map((r) => r.id))
      const edge = json.ready.find((r) => r.blockedBy.some((d) => inWave.has(d)))
      check(S, `P2 no wave contains an internal edge (delivered: ${delivered.join(',') || 'none'})`, !edge,
        edge ? `${edge.id} depends on a wave-mate` : '')
    }
    rmSync(root, { recursive: true, force: true })
  }

  // ---- P3: delivering a wave unlocks the next one -----------------------------------------
  {
    const root = makePrd(diamond)
    const w2 = plan(root, ['--delivered', 'A-1,A-2'])
    eq(S, 'P3 wave 2 opens once its blockers are delivered', ids(w2.json.ready), ['A-3', 'B-1'])
    const w3 = plan(root, ['--delivered', 'A-1,A-2,A-3,B-1'])
    eq(S, 'P3 nothing is ready when everything is delivered', ids(w3.json.ready), [])
    eq(S, 'P3 and the loop is told it is DONE', w3.json.done, true)
    eq(S, 'P3 exit stays 0 when done', w3.status, 0)
    rmSync(root, { recursive: true, force: true })
  }

  // ---- P4: a failed blocker makes its dependents UNREACHABLE, never silently dropped -------
  {
    const root = makePrd(diamond)
    const { json } = plan(root, ['--delivered', 'A-2', '--failed', 'A-1'])
    eq(S, 'P4 dependents of a failed blocker are unreachable', ids(json.unreachable), ['A-3', 'B-1'])
    check(S, 'P4 and each names the blocker that did not deliver',
      json.unreachable.every((u) => /A-1/.test(u.reason)))
    eq(S, 'P4 they are not reported as ready', ids(json.ready), [])
    eq(S, 'P4 nor quietly as blocked (which would read as "waiting", not "never")', ids(json.blocked), [])
    eq(S, 'P4 the loop is done — there is nothing left it can dispatch', json.done, true)
    rmSync(root, { recursive: true, force: true })
  }
  {
    // Transitive: C depends on B depends on A(failed). C must be unreachable too, or the
    // loop would spin forever waiting on a B that is never coming.
    const root = makePrd({ m: { A: [], B: ['A'], C: ['B'] } })
    const { json } = plan(root, ['--failed', 'A'])
    eq(S, 'P4b unreachability is transitive', ids(json.unreachable), ['B', 'C'])
    rmSync(root, { recursive: true, force: true })
  }

  // ---- P5: an empty wave that is NOT done must not read as completion -----------------------
  // The failure this prevents: a loop exits on an empty `ready`, and a run that executed
  // nothing reports itself complete.
  {
    const root = makePrd({ m: { A: [], B: ['A'] } })
    const { json } = plan(root, ['--delivered', 'A'])
    eq(S, 'P5 a wave with work left is not done', json.done, false)
    const stuck = plan(root, ['--failed', 'A'])
    eq(S, 'P5 ready is empty', ids(stuck.json.ready), [])
    eq(S, 'P5 done is true ONLY because the remainder is unreachable, and it says so',
      [stuck.json.done, stuck.json.unreachable.length > 0], [true, true])
    rmSync(root, { recursive: true, force: true })
  }

  // ---- P6: cycles ---------------------------------------------------------------------------
  {
    const root = makePrd({ m: { X: ['Y'], Y: ['X'], Z: [] } })
    const { status, json, out } = plan(root)
    eq(S, 'P6 a cycle exits non-zero', status, 1)
    eq(S, 'P6 the cycle members are named', json && ids(json.cycle), ['X', 'Y'])
    check(S, 'P6 and printed for a human', /dependency cycle among/.test(out))
    eq(S, 'P6 the independent ticket is still offered (the report is not all-or-nothing)', json && ids(json.ready), ['Z'])
    rmSync(root, { recursive: true, force: true })
  }

  // ---- P7: a broken graph is refused outright ------------------------------------------------
  {
    const root = makePrd({ m: { A: ['NOPE'] } })
    const { status, out } = plan(root)
    eq(S, 'P7 a dangling blocked_by exits non-zero', status, 1)
    check(S, 'P7 and names the missing id', /unknown ticket 'NOPE'/.test(out))
    check(S, 'P7 and refuses rather than planning a partial wave', /refusing to plan a wave/.test(out))
    rmSync(root, { recursive: true, force: true })
  }

  // ---- P8: module scope --------------------------------------------------------------------
  {
    const root = makePrd(diamond)
    const { json } = plan(root, ['--module', '02-b'])
    eq(S, 'P8 the wave is confined to the module', ids(json.ready), [])
    eq(S, 'P8 a CROSS-MODULE blocker still gates it', ids(json.blocked), ['B-1'])
    eq(S, 'P8 and the blocker is named even though it lives elsewhere',
      json.blocked[0].waitingOn, ['A-1'])
    const after = plan(root, ['--module', '02-b', '--delivered', 'A-1'])
    eq(S, 'P8 delivering the cross-module blocker releases it', ids(after.json.ready), ['B-1'])
    rmSync(root, { recursive: true, force: true })
  }
  {
    const root = makePrd(diamond)
    const { status, out } = plan(root, ['--module', 'typo-here'])
    eq(S, 'P8b a module name matching nothing EXITS 1', status, 1)
    check(S, 'P8b rather than reporting "nothing left to run"', !/nothing left to run/.test(out))
    check(S, 'P8b and it lists the modules that do exist', /modules present: 01-a, 02-b/.test(out))
    rmSync(root, { recursive: true, force: true })
  }

  // ---- P9: the local delivery ledger is the resume signal without a tracker ------------------
  // The path is load-bearing: deliver-ticket.mjs writes docs/delivered.json, and the retired
  // scheduler still told its reload agent to read .claude/delivered.json — so in local mode
  // every delivered ticket read as open and was re-planned and re-built (issues #136, #180).
  {
    const root = makePrd(diamond)
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'delivered.json'), JSON.stringify({ delivered: [{ id: 'A-1', branch: 'ticket/A-1', sha: 'abc', at: 'x' }] }))
    const { json, out } = plan(root, [], { cwd: root })
    check(S, 'P9 the ledger is read from docs/delivered.json', /local delivery ledger read/.test(out))
    eq(S, 'P9 a ledgered ticket counts as delivered', json.delivered, ['A-1'])
    // A-1 is excluded (ledgered) and B-1, which only waited on A-1, is released by it.
    eq(S, 'P9 so it is not re-planned, and what it blocked is released', ids(json.ready), ['A-2', 'B-1'])
    rmSync(root, { recursive: true, force: true })
  }
  {
    const root = makePrd(diamond)
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'delivered.json'), '{ this is not json')
    const { status, json, out } = plan(root, [], { cwd: root })
    eq(S, 'P9b an unparseable ledger does not crash the planner', status, 0)
    check(S, 'P9b but it is reported LOUDLY (unknown must not silently mean "nothing delivered")',
      /unparseable/.test(out))
    eq(S, 'P9b and the tracker-supplied set still applies', json.delivered, [])
    rmSync(root, { recursive: true, force: true })
  }
  {
    const root = makePrd(diamond)
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'delivered.json'), JSON.stringify({ delivered: [{ id: 'A-1' }] }))
    const { json } = plan(root, ['--ledger', 'none'], { cwd: root })
    eq(S, 'P9c --ledger none ignores it', json.delivered, [])
    rmSync(root, { recursive: true, force: true })
  }

  // ---- P10: an id the caller passed that does not exist is reported --------------------------
  {
    const root = makePrd(diamond)
    const { json, out } = plan(root, ['--delivered', 'A-1,TYPO-9'])
    eq(S, 'P10 an unknown id is surfaced', json.unknownIds, ['TYPO-9'])
    check(S, 'P10 and flagged as a possible typo, because a typo re-runs delivered work',
      /typo/.test(out))
    eq(S, 'P10 the known id still applies', json.delivered, ['A-1'])
    rmSync(root, { recursive: true, force: true })
  }

  // ---- P11: the runaway guard ----------------------------------------------------------------
  {
    const wide = {}
    wide.m = {}
    for (let i = 0; i < 8; i++) wide.m[`W-${i}`] = []
    const root = makePrd(wide)
    const { json, out } = plan(root, ['--max', '3'])
    eq(S, 'P11 the wave is capped', json.ready.length, 3)
    eq(S, 'P11 but the true ready count is still reported', json.readyTotal, 8)
    check(S, 'P11 and the truncation is stated, never silent', /wave truncated/.test(out))
    eq(S, 'P11 a capped wave is not done', json.done, false)
    rmSync(root, { recursive: true, force: true })
  }
  {
    const root = makePrd(diamond)
    eq(S, 'P11b a non-integer --max is rejected', plan(root, ['--max', 'x']).status, 1)
    eq(S, 'P11b a zero --max is rejected', plan(root, ['--max', '0']).status, 1)
    rmSync(root, { recursive: true, force: true })
  }

  // ---- P12: a missing root fails loudly --------------------------------------------------------
  {
    const r = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'definitely-not-here-e2e')], { encoding: 'utf8' })
    eq(S, 'P12 a missing prd root exits 1', r.status, 1)
    check(S, 'P12 and says so', /prd root not found/.test(`${r.stdout}${r.stderr}`))
  }
}
