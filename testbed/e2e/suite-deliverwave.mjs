// E2E for deliver-wave.mjs — the orchestrator's delivery driver.
//
// Delivery is the orchestrator's now (catalog issue #206), but the POLICY of delivery is
// not: which flags a mode implies, what counts as delivered, which branches may be deleted,
// what must be reported when something is skipped. Left in a command's prose, every one of
// those would have degraded from an assertion this catalog can execute into an instruction
// it can only hope is followed. So the policy is a script, and these are its tests — the
// direct descendants of suite-runner's S1/S6/S13 and suite-startall's SA5c–SA5g, which
// tested the same rules while they still lived inside the retired schedulers.
//
// deliver-ticket.mjs itself is stubbed via DELIVER_TICKET_BIN (the same mechanism as
// GH_BIN/GLAB_BIN): its own behaviour is suite-deliver.mjs's subject, and a double that
// re-implemented it would only test the double.
//
// Zero tokens, zero network.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'deliverwave'
const SCRIPT = fileURLToPath(
  new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/deliver-wave.mjs', import.meta.url)
)

// A stand-in for deliver-ticket.mjs. It ECHOES the argv it was given into its summary so
// the tests can assert on the composed command, and it can be told to misbehave — the
// failure paths matter more than the happy one here.
const FAKE = `
const a = process.argv.slice(2)
const g = (n) => { const i = a.indexOf(n); return i === -1 ? '' : a[i + 1] }
const id = g('--id')
require('fs').appendFileSync(process.env.ARGV_LOG, JSON.stringify({ id, argv: a }) + '\\n')
if (id === 'T-NOSUM') process.exit(0)
if (id === 'T-GARBAGE') { console.log('DELIVER-SUMMARY-JSON: {not json'); process.exit(0) }
const local = g('--delivery') === 'local'
const noMerge = a.includes('--no-merge')
const s = id === 'T-INTEG'
  ? { id, branch: g('--branch'), outcome: 'delivered-to-integration', merged: false, dodPassed: false, awaitingMerge: false, deliveredTo: 'integration', prUrl: '', notes: 'default branch is protected' }
  : id === 'T-DODFAIL'
  ? { id, branch: g('--branch'), outcome: 'delivered', merged: true, dodPassed: false, awaitingMerge: false, prUrl: 'u', notes: 'tests failed on the merged default branch' }
  : noMerge
  ? { id, branch: g('--branch'), outcome: 'not-delivered', merged: false, dodPassed: false, awaitingMerge: true, prUrl: 'https://forge/pr/1', notes: '' }
  : { id, branch: g('--branch'), outcome: 'delivered', merged: true, dodPassed: true, awaitingMerge: false, prUrl: local ? '' : 'https://forge/pr/9', deliveredTo: 'main', notes: '' }
console.log('DELIVER-SUMMARY-JSON: ' + JSON.stringify(s))
`

function makeRepo(rows, { records = {}, bodies = {}, branches = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-dw-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'e2e@example.com'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'e2e'])
  execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'init'])
  mkdirSync(join(dir, '.claude', 'tmp'), { recursive: true })
  writeFileSync(join(dir, 'fake-deliver.cjs'), FAKE)
  for (const [id, text] of Object.entries(records)) writeFileSync(join(dir, '.claude', 'tmp', `${id}-verdict.md`), text)
  for (const [id, text] of Object.entries(bodies)) writeFileSync(join(dir, '.claude', 'tmp', `${id}-body.md`), text)
  for (const b of branches) execFileSync('git', ['-C', dir, 'branch', b])
  writeFileSync(join(dir, 'wave.json'), JSON.stringify({ waveNumber: 1, results: rows }, null, 2))
  return dir
}

function deliver(dir, args = []) {
  const argvLog = join(dir, 'argv.log')
  writeFileSync(argvLog, '')
  const r = spawnSync(process.execPath, [SCRIPT, '--wave', 'wave.json', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ARGV_LOG: argvLog, DELIVER_TICKET_BIN: `${process.execPath} ${join(dir, 'fake-deliver.cjs')}` },
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('WAVE-DELIVER-JSON: '))
  let json = null
  try { json = line ? JSON.parse(line.slice('WAVE-DELIVER-JSON: '.length)) : null } catch {}
  const invocations = readFileSync(argvLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  const branches = execFileSync('git', ['-C', dir, 'branch', '--list'], { encoding: 'utf8' })
    .split(/\r?\n/).map((l) => l.replace('*', '').trim()).filter(Boolean)
  return { status: r.status, out, json, invocations, branches }
}

const clearRow = (id, extra = {}) => ({
  id, status: 'reviewed-clear', branch: `ticket/${id}`, issue: Number(id.replace(/\D/g, '')) || 7,
  recordPath: `.claude/tmp/${id}-verdict.md`, ...extra,
})
const argvOf = (inv, id) => (inv.find((i) => i.id === id) || { argv: [] }).argv
const hasPair = (argv, flag, value) => { const i = argv.indexOf(flag); return i !== -1 && argv[i + 1] === value }

export async function run() {
  // ---- D1: autonomous, tracker mode ---------------------------------------------------
  {
    const dir = makeRepo([clearRow('T-01', { bodyFile: '.claude/tmp/T-01-body.md' }), clearRow('T-02')], {
      records: { 'T-01': 'reviewer record 1\n', 'T-02': 'reviewer record 2\n' },
      bodies: { 'T-01': 'composed body\n' },
      branches: ['ticket/T-01', 'ticket/T-02'],
    })
    const { status, json, invocations, branches } = deliver(dir, ['--platform', 'gh', '--test-cmd', 'npm test'])
    eq(S, 'D1 exit 0', status, 0)
    eq(S, 'D1 both tickets landed', json.landed, 2)
    const a1 = argvOf(invocations, 'T-01')
    check(S, 'D1 the tracker platform is passed', hasPair(a1, '--platform', 'gh'))
    check(S, 'D1 the issue number is passed', hasPair(a1, '--issue', '1'))
    check(S, 'D1 the reviewer record is passed as the verdict file', hasPair(a1, '--verdict-file', '.claude/tmp/T-01-verdict.md'))
    check(S, 'D1 the composed body is passed', hasPair(a1, '--body-file', '.claude/tmp/T-01-body.md'))
    check(S, 'D1 the test command is forwarded for the DoD check', hasPair(a1, '--test-cmd', 'npm test'))
    check(S, 'D1 autonomous does NOT pass --no-merge', !a1.includes('--no-merge'))
    check(S, 'D1 a ticket with no composed body still delivers', !argvOf(invocations, 'T-02').includes('--body-file'))
    eq(S, 'D1 delivered branches are deleted', branches.filter((b) => b.startsWith('ticket/')), [])
    eq(S, 'D1 and the deletions are reported', json.cleanup.branchesDeleted.sort(), ['ticket/T-01', 'ticket/T-02'])
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- D2: supervised ------------------------------------------------------------------
  {
    const dir = makeRepo([clearRow('T-01')], { records: { 'T-01': 'r\n' }, branches: ['ticket/T-01'] })
    const { json, invocations, branches, out } = deliver(dir, ['--platform', 'gh', '--no-merge', '--integration-branch', 'integ'])
    const a1 = argvOf(invocations, 'T-01')
    check(S, 'D2 supervised passes --no-merge', a1.includes('--no-merge'))
    check(S, 'D2 supervised does NOT use the integration fallback (it already stops for a human)',
      !a1.includes('--integration-branch'))
    eq(S, 'D2 nothing landed', json.landed, 0)
    eq(S, 'D2 the PR is reported as awaiting a human', json.delivered[0].awaitingMerge, true)
    check(S, 'D2 with its url', /https:\/\/forge\/pr\/1/.test(out))
    check(S, 'D2 the branch is KEPT — nothing merged, so it is still the only copy',
      branches.includes('ticket/T-01'))
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- D3: local delivery (no forge at all) -----------------------------------------------
  {
    const dir = makeRepo([clearRow('T-01')], { records: { 'T-01': 'r\n' }, branches: ['ticket/T-01'] })
    const { json, invocations, out } = deliver(dir, ['--platform', 'none'])
    const a1 = argvOf(invocations, 'T-01')
    check(S, 'D3 local mode passes --delivery local', hasPair(a1, '--delivery', 'local'))
    check(S, 'D3 and no --platform', !a1.includes('--platform'))
    check(S, 'D3 and no --issue (there is no tracker to close)', !a1.includes('--issue'))
    eq(S, 'D3 it still counts as landed (the DoD swaps the tracker term for the ledger)', json.landed, 1)
    check(S, 'D3 a local handoff is reported', !!json.localHandoff)
    check(S, 'D3 it says nothing was pushed', /nothing was pushed/i.test(out))
    check(S, 'D3 it gives the exact publish command', json.localHandoff.next.some((l) => /git push origin main/.test(l)))
    // The path deliver-ticket.mjs actually writes. The retired scheduler told its reload
    // agent to read .claude/delivered.json, so every locally-delivered ticket read as open.
    eq(S, 'D3 the ledger path is the one deliver-ticket.mjs writes', json.localHandoff.ledger, 'docs/delivered.json')
    rmSync(dir, { recursive: true, force: true })
  }
  {
    const dir = makeRepo([clearRow('T-01')], { records: { 'T-01': 'r\n' } })
    const { json } = deliver(dir, ['--platform', 'gh'])
    eq(S, 'D3b a tracker run reports no local handoff', json.localHandoff, null)
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- D4: an unevidenced review is REFUSED, not delivered ----------------------------------
  // The Reviewer authors its own record (issues #201, #206). A missing or empty one means
  // the verdict cannot be audited, and nobody downstream may substitute for it.
  {
    const dir = makeRepo([clearRow('T-MISSING'), clearRow('T-EMPTY'), clearRow('T-OK')], {
      records: { 'T-EMPTY': '', 'T-OK': 'real record\n' },
      branches: ['ticket/T-OK'],
    })
    const { json, invocations, out } = deliver(dir, ['--platform', 'gh'])
    eq(S, 'D4 a missing record is refused', json.refused.some((r) => r.id === 'T-MISSING'), true)
    eq(S, 'D4 an EMPTY record is refused too (a created-but-unwritten file is not evidence)',
      json.refused.some((r) => r.id === 'T-EMPTY'), true)
    check(S, 'D4 the refused tickets are never handed to the delivery script',
      !invocations.some((i) => i.id === 'T-MISSING' || i.id === 'T-EMPTY'))
    check(S, 'D4 the reason says the verdict is unevidenced', /unevidenced/.test(out))
    eq(S, 'D4 the evidenced ticket still delivers', json.landed, 1)
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- D5: rows that are not CLEAR are reported, never silently dropped -----------------------
  {
    const dir = makeRepo([
      clearRow('T-01'),
      { id: 'T-ESC', status: 'escalated', stage: 'acceptance-unmet', detail: 'row not met' },
      { id: 'T-FAIL', status: 'failed', stage: 'builder', detail: 'tests red' },
    ], { records: { 'T-01': 'r\n' }, branches: ['ticket/T-01'] })
    const { json, invocations, out } = deliver(dir, ['--platform', 'gh'])
    eq(S, 'D5 non-cleared rows are reported as skipped', json.skipped.map((s) => s.id).sort(), ['T-ESC', 'T-FAIL'])
    check(S, 'D5 with the stage that stopped them', json.skipped.every((s) => s.stage))
    check(S, 'D5 and they are never delivered', !invocations.some((i) => i.id === 'T-ESC' || i.id === 'T-FAIL'))
    check(S, 'D5 the skip is visible to a human, not only in the JSON', /skip {2}T-ESC/.test(out))
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- D6: a delivery that did not land is NEVER counted or cleaned up ------------------------
  {
    const dir = makeRepo([clearRow('T-INTEG'), clearRow('T-DODFAIL'), clearRow('T-NOSUM'), clearRow('T-GARBAGE')], {
      records: { 'T-INTEG': 'r\n', 'T-DODFAIL': 'r\n', 'T-NOSUM': 'r\n', 'T-GARBAGE': 'r\n' },
      branches: ['ticket/T-INTEG', 'ticket/T-DODFAIL', 'ticket/T-NOSUM', 'ticket/T-GARBAGE'],
    })
    const { json, branches, out } = deliver(dir, ['--platform', 'gh'])
    eq(S, 'D6 nothing landed', json.landed, 0)
    check(S, 'D6 integration-branch delivery is NOT reported as done', /NOT on main/.test(out) || /integration branch/.test(out))
    check(S, 'D6 a merge whose DoD failed is not counted', /did NOT deliver/.test(out))
    check(S, 'D6 a missing summary is treated as NOT delivered', json.refused.some((r) => r.id === 'T-NOSUM'))
    check(S, 'D6 and its output tail is carried, so the failure is diagnosable',
      json.refused.find((r) => r.id === 'T-NOSUM').tail !== undefined)
    check(S, 'D6 an unparseable summary is treated as NOT delivered', json.refused.some((r) => r.id === 'T-GARBAGE'))
    eq(S, 'D6 NO branch is deleted', branches.filter((b) => b.startsWith('ticket/')).length, 4)
    eq(S, 'D6 and every kept branch is reported', json.cleanup.branchesKept.length, 2)
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- D7: cleanup can be declined, and a failed deletion escalates ----------------------------
  {
    const dir = makeRepo([clearRow('T-01')], { records: { 'T-01': 'r\n' }, branches: ['ticket/T-01'] })
    const { json, branches } = deliver(dir, ['--platform', 'gh', '--no-cleanup'])
    eq(S, 'D7 --no-cleanup keeps the branch', branches.includes('ticket/T-01'), true)
    eq(S, 'D7 and says cleanup did not run', json.cleanup.ran, false)
    rmSync(dir, { recursive: true, force: true })
  }
  {
    // No branch to delete: the script must escalate rather than report a clean cleanup.
    const dir = makeRepo([clearRow('T-01')], { records: { 'T-01': 'r\n' } })
    const { json } = deliver(dir, ['--platform', 'gh'])
    check(S, 'D7b a deletion that failed is escalated',
      json.escalations.some((e) => /could not delete ticket\/T-01/.test(e)))
    check(S, 'D7b and the escalation says WHY it matters',
      json.escalations.some((e) => /reverts main/.test(e)))
    eq(S, 'D7b the branch is listed as kept, not deleted', json.cleanup.branchesKept, ['ticket/T-01'])
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- D8: dry run ------------------------------------------------------------------------------
  {
    const dir = makeRepo([clearRow('T-01')], { records: { 'T-01': 'r\n' }, branches: ['ticket/T-01'] })
    const { json, invocations, branches } = deliver(dir, ['--platform', 'gh', '--dry-run'])
    eq(S, 'D8 a dry run delivers nothing', invocations.length, 0)
    eq(S, 'D8 and deletes nothing', branches.includes('ticket/T-01'), true)
    eq(S, 'D8 and says so', json.dryRun, true)
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- D9: bad invocation fails closed ------------------------------------------------------------
  {
    const dir = makeRepo([clearRow('T-01')], { records: { 'T-01': 'r\n' } })
    const bad = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' }).status
    eq(S, 'D9 no --wave exits 1', bad(['--platform', 'gh']), 1)
    eq(S, 'D9 a missing wave file exits 1', bad(['--wave', 'nope.json']), 1)
    writeFileSync(join(dir, 'bad.json'), '{ nope')
    eq(S, 'D9 an unparseable wave file exits 1', bad(['--wave', 'bad.json']), 1)
    writeFileSync(join(dir, 'noresults.json'), '{"waveNumber":1}')
    eq(S, 'D9 a wave file with no results array exits 1', bad(['--wave', 'noresults.json']), 1)
    eq(S, 'D9 an unknown platform exits 1', bad(['--wave', 'wave.json', '--platform', 'bogus']), 1)
    eq(S, 'D9 a --test-cmd with a double quote exits 1', bad(['--wave', 'wave.json', '--test-cmd', 'a"b']), 1)
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- D9b: the DEFAULT delivery binary, with no override --------------------------------------------
  // Every test above sets DELIVER_TICKET_BIN, so none of them ever executed the default
  // path — and the default was broken: the argv was built by splitting a string on
  // whitespace, which a stray character (or a real `C:\Program Files\nodejs\node.exe`)
  // silently destroys. A double more forgiving than the real invocation cannot find that.
  // This case runs with NO override and asserts the script reaches the real script.
  {
    const dir = makeRepo([clearRow('T-01')], { records: { 'T-01': 'r\n' } })
    const r = spawnSync(process.execPath, [SCRIPT, '--wave', 'wave.json', '--platform', 'gh', '--dry-run'], {
      cwd: dir, encoding: 'utf8',
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'DELIVER_TICKET_BIN')),
    })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    eq(S, 'D9b the default path runs', r.status, 0)
    check(S, 'D9b it targets the real deliver-ticket.mjs', /deliver-ticket\.mjs/.test(out))
    check(S, 'D9b the node executable is one argv element, not split on its own path',
      !/\bProgram\b(?!\s+Files)/.test(out))
    check(S, 'D9b and no NUL or control character leaked into the command',
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(out))
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- D10: delivery is SEQUENTIAL ------------------------------------------------------------------
  // Merges land on the main working tree. The retired parallel scheduler needed a mutex for
  // this; here it is the absence of concurrency, and that must not quietly regress.
  {
    const src = readFileSync(SCRIPT, 'utf8').replace(/^\s*\/\/.*$/gm, '')
    check(S, 'D10 no concurrency primitive is used', !/Promise\.all|parallel\(|makeLock/.test(src))
    check(S, 'D10 deliveries run in a plain sequential loop', /for \(const t of clear\)/.test(src))

    // Structural, because the runtime check above cannot see this failure on every machine:
    // building the default command as a STRING and splitting it back apart only breaks
    // where process.execPath contains a space, so a CI runner with node on a clean path
    // would pass while a developer on "C:\Program Files\nodejs" fails. Assert the shape.
    check(S, 'D10 the default delivery command is built as an argv array, never split from a string',
      /: \[process\.execPath, join\(HERE, 'deliver-ticket\.mjs'\)\]/.test(src))
    check(S, 'D10 and only the explicit override is parsed as a command line',
      /process\.env\.DELIVER_TICKET_BIN\.trim\(\)\.split/.test(src))
    check(S, 'D10 the script contains no control characters (a stray NUL made the default unrunnable once)',
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(readFileSync(SCRIPT, 'utf8')))
  }
}
