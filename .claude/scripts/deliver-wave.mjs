#!/usr/bin/env node
// deliver-wave.mjs — deliver every CLEAR ticket of one wave, then clean the wave up.
//
// The orchestrator owns delivery now (catalog issue #206). What it does NOT own is the
// POLICY of delivery: which flags a mode implies, what counts as delivered, which branches
// may be deleted, what must be reported when something is skipped. Leaving that in a
// command's prose would have turned assertions this catalog can execute into instructions
// it can only hope are followed — so the policy lives here, and the orchestrator's job is
// to compose the PR bodies (a language task) and run this once per wave.
//
// It is a thin, SEQUENTIAL driver over deliver-ticket.mjs, which remains the only sanctioned
// path to a merge. Sequential by construction: merges land on the main working tree, and the
// mutex the old parallel scheduler needed exists here as the absence of concurrency.
//
// Usage:
//   node .claude/scripts/deliver-wave.mjs --wave <wave.json> [options]
//
//   --default-branch <name>     default 'main'
//   --platform gh|glab|none     'none' = local delivery: no tracker, no push, no PR/MR
//   --test-cmd "<command>"      forwarded to deliver-ticket.mjs for the DoD check
//   --integration-branch <name> autonomous only; used when a PROTECTED default refuses
//   --no-merge                  supervised: open the PR/MR and stop for a human
//   --no-cleanup                keep delivered ticket branches and run worktrees
//   --dry-run                   plan and validate only; run no delivery and delete nothing
//
// The wave file is the workflow's return value with one field added per ticket by the
// orchestrator:
//   { waveNumber: 1, results: [ { id, status, branch, issue, recordPath, bodyFile? } ] }
// Only `status: "reviewed-clear"` rows are delivered. Every other row is REPORTED and
// skipped — a wave report that silently omits an escalated ticket is indistinguishable
// from a wave in which everything passed.
//
// Last line of stdout:
//   WAVE-DELIVER-JSON: {"waveNumber","delivered":[...],"refused":[...],"skipped":[...],
//                       "cleanup":{...},"localHandoff":{...}|null,"escalations":[...]}
// Exit codes: 0 = a definitive report was printed (tickets may still have failed);
//             1 = bad invocation, unreadable wave file, or no report could be produced.

import { existsSync, readFileSync, statSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const flag = (n, d) => {
  const i = argv.indexOf(n)
  return i === -1 || i === argv.length - 1 ? d : argv[i + 1]
}

const die = (msg) => { console.error(msg); process.exit(1) }

const wavePath = flag('--wave', '')
if (!wavePath) die('--wave <wave.json> is required')
if (!existsSync(wavePath)) die(`wave file not found: ${wavePath}`)

let wave
try {
  wave = JSON.parse(readFileSync(wavePath, 'utf8'))
} catch (e) {
  die(`wave file is not valid JSON (${wavePath}): ${e && e.message ? e.message : e}`)
}
if (!wave || !Array.isArray(wave.results)) die(`wave file must contain a "results" array: ${wavePath}`)

const DEFAULT_BRANCH = flag('--default-branch', 'main')
const PLATFORM = flag('--platform', 'gh')
if (!['gh', 'glab', 'none'].includes(PLATFORM)) die("--platform must be 'gh', 'glab', or 'none'")
const LOCAL_ONLY = PLATFORM === 'none'
const TEST_CMD = flag('--test-cmd', '')
if (TEST_CMD.includes('"')) die('--test-cmd must not contain double quotes')
const INTEGRATION_BRANCH = flag('--integration-branch', '')
const NO_MERGE = has('--no-merge')
const NO_CLEANUP = has('--no-cleanup')
const DRY_RUN = has('--dry-run')

// Test-double override, same mechanism as GH_BIN/GLAB_BIN in deliver-ticket.mjs.
//
// The DEFAULT is built as an argv ARRAY rather than as a string that gets split back
// apart. On Windows process.execPath routinely contains a space (Program Files), and any
// split-on-whitespace scheme tears that path in half. Only the OVERRIDE is parsed, because
// a human or a test writes that one as a command line.
const deliverArgv = process.env.DELIVER_TICKET_BIN
  ? process.env.DELIVER_TICKET_BIN.trim().split(/\s+/)
  : [process.execPath, join(HERE, 'deliver-ticket.mjs')]

const escalations = []
const note = (m) => { escalations.push(m); console.log(`! ${m}`) }

const run = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}
const git = (a) => run('git', a)

// ---- classify the wave ----------------------------------------------------------------
const clear = []
const skipped = []
for (const r of wave.results) {
  if (!r || typeof r.id !== 'string' || !r.id) {
    note('wave file contains a result row with no id — ignored')
    continue
  }
  if (r.status === 'reviewed-clear') clear.push(r)
  else skipped.push({ id: r.id, status: r.status || '(no status)', stage: r.stage || '', detail: r.detail || '' })
}

console.log(
  `wave ${wave.waveNumber ?? '?'}: ${clear.length} ticket(s) to deliver, ${skipped.length} not eligible` +
    (DRY_RUN ? ' (dry run)' : '')
)
for (const s of skipped) console.log(`  skip  ${s.id} — ${s.status}${s.stage ? ` (${s.stage})` : ''}`)

// ---- deliver ---------------------------------------------------------------------------
const delivered = []
const refused = []

const nonEmptyFile = (p) => {
  try { return Boolean(p) && existsSync(p) && statSync(p).isFile() && statSync(p).size > 0 } catch { return false }
}

for (const t of clear) {
  const branch = t.branch || `ticket/${t.id}`

  // The Reviewer's own record is a PRECONDITION, not a nicety. It is the durable review
  // trail, it is written by the agent that reached the verdict, and nobody downstream may
  // substitute for it (catalog issues #201, #206). Missing or empty means the review is
  // unevidenced — refuse rather than deliver an unauditable merge.
  if (!nonEmptyFile(t.recordPath)) {
    refused.push({ id: t.id, reason: `reviewer record missing or empty: ${t.recordPath || '(no path returned)'}` })
    note(`${t.id} REFUSED — the Reviewer's record at ${t.recordPath || '(no path)'} is missing or empty; the verdict is unevidenced`)
    continue
  }

  const a = ['--id', t.id, '--branch', branch, '--default-branch', DEFAULT_BRANCH, '--verdict-file', t.recordPath]
  if (LOCAL_ONLY) a.push('--delivery', 'local')
  else {
    a.push('--platform', PLATFORM)
    if (t.issue) a.push('--issue', String(t.issue))
  }
  if (t.bodyFile && nonEmptyFile(t.bodyFile)) a.push('--body-file', t.bodyFile)
  else if (t.bodyFile) note(`${t.id}: composed body ${t.bodyFile} is missing or empty — delivering with the repo template instead`)
  if (TEST_CMD) a.push('--test-cmd', TEST_CMD)
  // supervised already stops for a human, so the protected-branch fallback is autonomous-only
  if (!NO_MERGE && INTEGRATION_BRANCH) a.push('--integration-branch', INTEGRATION_BRANCH)
  if (NO_MERGE) a.push('--no-merge')

  if (DRY_RUN) {
    delivered.push({ id: t.id, branch, outcome: 'dry-run', command: [...deliverArgv, ...a].join(' ') })
    console.log(`  plan  ${t.id} — ${[...deliverArgv.slice(1), ...a].join(' ')}`)
    continue
  }

  console.log(`  deliver ${t.id}`)
  const res = run(deliverArgv[0], [...deliverArgv.slice(1), ...a])
  const line = res.out.split(/\r?\n/).reverse().find((l) => l.startsWith('DELIVER-SUMMARY-JSON:'))
  if (!line) {
    refused.push({ id: t.id, reason: 'deliver-ticket.mjs printed no DELIVER-SUMMARY-JSON', tail: res.out.split(/\r?\n/).slice(-12).join('\n') })
    note(`${t.id} delivery produced no summary — treating as NOT delivered; output tail:\n${res.out.split(/\r?\n/).slice(-12).join('\n')}`)
    continue
  }
  let sum
  try {
    sum = JSON.parse(line.slice('DELIVER-SUMMARY-JSON:'.length).trim())
  } catch (e) {
    refused.push({ id: t.id, reason: `unparseable DELIVER-SUMMARY-JSON: ${e && e.message ? e.message : e}` })
    note(`${t.id} delivery summary was unparseable — treating as NOT delivered`)
    continue
  }

  // Truthfulness rule: `outcome` and `dodPassed` are deliver-ticket's own verdict on
  // itself, and they already encode the mode (local delivery swaps the tracker term for a
  // ledger write; supervised sets awaitingMerge and never claims a merge). Re-deriving
  // "delivered" from raw flags here is how the old scheduler reported every LOCAL delivery
  // as incomplete: it required issueClosed in a mode that has no tracker to close.
  const row = {
    id: t.id,
    branch,
    outcome: sum.outcome,
    merged: sum.merged === true,
    dodPassed: sum.dodPassed === true,
    awaitingMerge: sum.awaitingMerge === true,
    prUrl: sum.prUrl || '',
    deliveredTo: sum.deliveredTo || '',
    notes: sum.notes || '',
  }
  delivered.push(row)

  if (NO_MERGE) {
    if (row.awaitingMerge) console.log(`  open    ${t.id} — PR/MR awaiting a human merge: ${row.prUrl || '(no url reported)'}`)
    else note(`${t.id}: supervised delivery did not leave an open PR/MR${row.notes ? ` — ${row.notes}` : ''}`)
  } else if (row.outcome === 'delivered' && row.dodPassed) {
    console.log(`  done    ${t.id}${row.prUrl ? ` — ${row.prUrl}` : ''}`)
  } else if (row.outcome === 'delivered-to-integration') {
    note(`${t.id} landed on the integration branch ${row.deliveredTo}, NOT on ${DEFAULT_BRANCH} — it is not done; a human must land it`)
  } else {
    note(`${t.id} did NOT deliver (outcome: ${row.outcome}, dodPassed: ${row.dodPassed})${row.notes ? ` — ${row.notes}` : ''}`)
  }
}

// ---- cleanup ----------------------------------------------------------------------------
// Only fully DELIVERED tickets are cleaned. A failed, refused or supervised-open ticket's
// branch is evidence and stays. What could NOT be cleaned is reported rather than dropped:
// a stale ticket branch is what later opens a merge request that REVERTS the default
// branch (catalog issue #151), so silence here is the whole failure mode.
const cleanup = { branchesDeleted: [], branchesKept: [], worktreesPruned: false, ran: false }
if (!NO_CLEANUP && !DRY_RUN) {
  cleanup.ran = true
  const prune = git(['worktree', 'prune'])
  cleanup.worktreesPruned = prune.ok
  if (!prune.ok) note(`git worktree prune failed: ${prune.out.split(/\r?\n/)[0]}`)

  const list = git(['worktree', 'list', '--porcelain'])
  if (list.ok) {
    for (const l of list.out.split(/\r?\n/)) {
      if (!l.startsWith('worktree ')) continue
      const p = l.slice('worktree '.length).trim()
      if (!/[/\\]\.claude[/\\]worktrees[/\\]/.test(p)) continue
      const rm = git(['worktree', 'remove', '--force', p])
      if (!rm.ok) {
        note(`could not remove run worktree ${p}: ${rm.out.split(/\r?\n/)[0]}`)
        try { rmSync(p, { recursive: true, force: true }) } catch {}
      }
    }
  }

  for (const row of delivered) {
    const landed = row.outcome === 'delivered' && row.dodPassed && !row.awaitingMerge
    if (!landed) {
      cleanup.branchesKept.push(row.branch)
      continue
    }
    const del = git(['branch', '-D', row.branch])
    if (del.ok) cleanup.branchesDeleted.push(row.branch)
    else {
      cleanup.branchesKept.push(row.branch)
      note(`could not delete ${row.branch}: ${del.out.split(/\r?\n/)[0]} — delete it by hand; a stale ticket branch can later open a merge request that reverts ${DEFAULT_BRANCH}`)
    }
  }
  console.log(`  cleanup deleted ${cleanup.branchesDeleted.length} branch(es), kept ${cleanup.branchesKept.length}`)
}

// ---- local handoff ----------------------------------------------------------------------
// Local delivery leaves work on the LOCAL default branch and nowhere else, so the run has to
// hand it over explicitly (catalog issue #180). Without this the mode is indistinguishable
// from silent hoarding: everything reads delivered, and nothing is anywhere a colleague can
// see. The ledger path is deliver-ticket.mjs's own — docs/delivered.json, committed, so it
// survives a machine and travels with the branch.
const localHandoff = LOCAL_ONLY
  ? {
      branch: DEFAULT_BRANCH,
      ledger: 'docs/delivered.json',
      pushed: false,
      next: [
        'Nothing was pushed and no PR/MR was opened — this wave touched no forge.',
        `Review the local history: git log --oneline ${DEFAULT_BRANCH}`,
        `When you want it published: git push origin ${DEFAULT_BRANCH}`,
        'Or hand this report to an agent and ask it to push and open the PR/MR.',
      ],
    }
  : null
if (localHandoff) {
  console.log('LOCAL DELIVERY — nothing was pushed and no PR/MR was opened.')
  for (const l of localHandoff.next) console.log(`  ${l}`)
}

const landedCount = delivered.filter((r) => r.outcome === 'delivered' && r.dodPassed && !r.awaitingMerge).length
console.log(
  `wave ${wave.waveNumber ?? '?'} delivery: ${landedCount} landed, ` +
    `${delivered.filter((r) => r.awaitingMerge).length} awaiting a human, ${refused.length} refused, ${skipped.length} skipped`
)
console.log(
  'WAVE-DELIVER-JSON: ' +
    JSON.stringify({
      waveNumber: wave.waveNumber ?? null,
      platform: PLATFORM,
      supervised: NO_MERGE,
      dryRun: DRY_RUN,
      landed: landedCount,
      delivered,
      refused,
      skipped,
      cleanup,
      localHandoff,
      escalations,
    })
)
process.exit(0)
