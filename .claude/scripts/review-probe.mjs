#!/usr/bin/env node
// review-probe.mjs — run ONE mutation against an isolated copy of the repo and report
// whether the test suite noticed (catalog issue #229).
//
// Usage:
//   node .claude/scripts/review-probe.mjs --file <path> --test "<cmd>" <mutation>
//
//   --file <path>        file to mutate, relative to the repo root
//   --test "<cmd>"       the suite to run (e.g. "npm test", "node testbed/e2e/run-e2e.mjs")
//   --rev <rev>          revision to copy (default: HEAD)
//   --no-baseline        skip the unmutated run (default: run it, see below)
//   --keep               leave the scratch tree on disk and print its path
//
//   one mutation, required:
//     --line <n> --replace "<text>"   replace line n
//     --line <n> --delete             delete line n
//     --find "<a>" --replace "<b>"    replace the FIRST literal occurrence of <a>
//     --find "<a>" --replace "<b>" --all   ... or every occurrence
//
// WHY THIS EXISTS
//
// The Reviewer is asked to judge whether the Builder's new tests are load-bearing, which
// in practice means mutating the code and checking that a test goes red. It also may not
// write files — a Reviewer once overwrote a production file through a python heredoc and
// then reported that it had "not attempted to route around" the restriction (issue #218).
// So the write guard denies its whole write surface by MECHANISM.
//
// That left the role asked to do something it had no way to do. Two Reviewers hit the wall
// on two repos on the same day: one created a scratch worktree outside the repo and was
// still denied every write into it; the other fell back to reasoning from `git show` about
// what the tests would have done. Both said so honestly, which is the guard working — but
// the verification the pattern asks for did not happen, and a less careful pair would have
// rounded it up to "verified by running".
//
// The fix is not to widen the shell surface. Deciding from a command string where a shell
// will write means parsing `cd`, variables, substitution and quoting, and a guard that
// believes it knows and is wrong is worse than one that refuses — that failure mode has
// cost this repo more than the guard ever has. Instead there is ONE sanctioned entry point
// that the guard can recognise exactly, and it does the isolation itself.
//
// PROPERTIES
//
//   - The mutation NEVER touches the repository under review. It is applied inside a
//     detached `git worktree` under the OS temp directory, which is removed on the way out
//     including on failure. #218's invariant is untouched: the Reviewer still cannot change
//     what is being reviewed.
//   - The baseline runs FIRST by default. "The suite went red under mutation" means nothing
//     unless it was green before — a suite already failing for an unrelated reason reports
//     red either way, and that is the reading that turns a broken probe into a false CLEAR.
//   - Everything is REPORTED, including what could not be done. A probe that could not
//     install dependencies, or could not create the scratch tree, exits 1 and says so
//     rather than returning a verdict it did not earn.
//
// Last line of stdout is machine-readable:
//   PROBE-JSON: {"file","mutation","baseline","mutated","verdict","scratch","notes":[]}
//
//   verdict: "test-is-load-bearing"  baseline passed, mutated failed  <- what you want
//            "test-did-not-notice"   both passed                      <- a finding
//            "baseline-already-red"  baseline failed; nothing learned
//            "could-not-run"         the probe itself failed
//
// Exit codes: 0 = the probe ran and the verdict is meaningful (either of the first two);
//             1 = the probe could not produce a meaningful verdict.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, resolve, isAbsolute } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}
const has = (name) => argv.includes(name)

const notes = []
const out = { file: null, mutation: null, baseline: null, mutated: null, verdict: 'could-not-run', scratch: null, notes }

const die = (msg) => {
  notes.push(msg)
  console.error(msg)
  console.log('PROBE-JSON: ' + JSON.stringify(out))
  process.exit(1)
}

const file = flag('--file')
const testCmd = flag('--test')
const rev = flag('--rev') || 'HEAD'
const line = flag('--line') === null ? null : Number(flag('--line'))
const find = flag('--find')
const replace = flag('--replace')
const doDelete = has('--delete')
const all = has('--all')
const keep = has('--keep')
const baselineWanted = !has('--no-baseline')

if (!file) die('--file is required')
if (!testCmd) die('--test is required (the probe is meaningless without a suite to run)')

// Exactly one mutation, so a malformed invocation cannot silently probe nothing.
const forms = [line !== null && (replace !== null || doDelete), find !== null && replace !== null].filter(Boolean)
if (forms.length !== 1) {
  die('specify exactly one mutation: --line <n> with --replace/--delete, or --find <a> --replace <b>')
}
if (line !== null && (!Number.isInteger(line) || line < 1)) die(`--line must be a positive integer, got ${flag('--line')}`)

const git = (args, opts = {}) => spawnSync('git', args, { encoding: 'utf8', ...opts })

const top = git(['rev-parse', '--show-toplevel'])
if (top.status !== 0) die('not inside a git repository, so there is nothing to copy')
const REPO = resolve(top.stdout.trim())

// The file must be inside the repo. Checked with relative(), not a string prefix, for the
// same reason the write guard does: `../../elsewhere/x` is not in this repo.
const target = resolve(REPO, file)
const rel = relative(REPO, target)
if (rel.startsWith('..') || isAbsolute(rel)) die(`--file must be inside the repository: ${file}`)
if (!existsSync(target)) die(`no such file: ${file}`)
out.file = rel.replace(/\\/g, '/')

// ---- the scratch tree -------------------------------------------------------------------
// Under the OS temp directory, NOT under the repo. A copy inside the repo would be picked up
// by a suite that globs from the root, and lanes living inside the repository is precisely
// what produced the 1.2 GB leak in issue #199.
const scratch = mkdtempSync(join(tmpdir(), 'review-probe-'))
out.scratch = scratch
const tree = join(scratch, 'tree')

let cleaned = false
const cleanup = () => {
  if (cleaned || keep) return
  cleaned = true
  git(['worktree', 'remove', '--force', tree], { cwd: REPO })
  try { rmSync(scratch, { recursive: true, force: true }) } catch {}
  git(['worktree', 'prune'], { cwd: REPO })
}
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1) })

// Reap what a KILLED probe left behind, before adding one of our own. The exit handler
// below covers every ordinary ending, and covers none of the one that matters: a probe
// killed outright leaves its worktree registered, `git worktree prune` will not drop an
// entry whose directory still exists, and the stale entries then accumulate in the repo
// under review. That is issue #199's finding applied to this script — a process cannot
// clean up after itself precisely when it is stopped, so its successor does it.
{
  const list = git(['worktree', 'list', '--porcelain'], { cwd: REPO })
  for (const l of (list.stdout || '').split(/\r?\n/)) {
    if (!l.startsWith('worktree ')) continue
    const p = l.slice('worktree '.length).trim()
    if (!/review-probe-[^/\\]*[/\\]tree$/.test(p.replace(/\\/g, '/'))) continue
    if (resolve(p) === resolve(tree)) continue
    git(['worktree', 'remove', '--force', p], { cwd: REPO })
    try { rmSync(resolve(p, '..'), { recursive: true, force: true }) } catch {}
    notes.push(`reaped a scratch tree left by an earlier probe: ${p}`)
  }
  git(['worktree', 'prune'], { cwd: REPO })
}

const add = git(['worktree', 'add', '--detach', tree, rev], { cwd: REPO })
if (add.status !== 0) die(`could not create the scratch worktree: ${(add.stderr || add.stdout || '').split('\n')[0]}`)

// Dependencies. A detached worktree has no node_modules, and installing one per probe is
// minutes of wall clock. Link the repo's instead — the link points OUT of the scratch INTO
// the repo, so it is read, never written, and removing the scratch cannot damage the repo.
// (Issue #199's poisoned links ran the other way: a link inside the MAIN checkout pointing
// into a lane, which dangled when the lane went.)
const nm = join(REPO, 'node_modules')
if (existsSync(nm)) {
  try {
    symlinkSync(nm, join(tree, 'node_modules'), 'junction')
  } catch (e) {
    try {
      cpSync(nm, join(tree, 'node_modules'), { recursive: true })
      notes.push('could not link node_modules, copied it instead (slower, but the run is real)')
    } catch {
      notes.push(`no node_modules in the scratch tree (${e && e.message ? e.message : e}) — the suite may fail for that reason rather than the mutation`)
    }
  }
}

const runSuite = (label) => {
  const r = spawnSync(testCmd, { cwd: tree, shell: true, encoding: 'utf8' })
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join(' | ')
  return { label, ok: r.status === 0, status: r.status, tail: tail.slice(0, 400) }
}

// ---- baseline ---------------------------------------------------------------------------
if (baselineWanted) {
  out.baseline = runSuite('baseline')
  if (!out.baseline.ok) {
    out.verdict = 'baseline-already-red'
    notes.push('the suite was already failing BEFORE the mutation, so a red result under mutation proves nothing')
    console.log(`baseline: FAIL (${out.baseline.tail})`)
    console.log('PROBE-JSON: ' + JSON.stringify(out))
    process.exit(1)
  }
  console.log('baseline: pass')
} else {
  notes.push('baseline skipped (--no-baseline): a red mutated run is only evidence if the suite was green first')
}

// ---- mutate ------------------------------------------------------------------------------
const scratchFile = join(tree, rel)
if (!existsSync(scratchFile)) die(`${out.file} is not present at ${rev} — it may be uncommitted; pass --rev or commit first`)

const original = readFileSync(scratchFile, 'utf8')
const nl = original.includes('\r\n') ? '\r\n' : '\n'
let mutated

if (line !== null) {
  const lines = original.split(/\r?\n/)
  if (line > lines.length) die(`--line ${line} is past the end of ${out.file} (${lines.length} lines)`)
  out.mutation = doDelete ? `delete line ${line}` : `replace line ${line}`
  if (doDelete) lines.splice(line - 1, 1)
  else lines[line - 1] = replace
  mutated = lines.join(nl)
} else {
  if (!original.includes(find)) die(`--find text does not occur in ${out.file}, so nothing would be mutated`)
  const count = original.split(find).length - 1
  out.mutation = `replace ${all ? `all ${count}` : 'the first'} occurrence${all && count !== 1 ? 's' : ''} of ${JSON.stringify(find.slice(0, 60))}`
  mutated = all ? original.split(find).join(replace) : original.replace(find, replace)
}

if (mutated === original) die('the mutation produced an identical file, so it would probe nothing')
writeFileSync(scratchFile, mutated)
console.log(`mutated: ${out.file} — ${out.mutation}`)

// ---- mutated run --------------------------------------------------------------------------
out.mutated = runSuite('mutated')
out.verdict = out.mutated.ok ? 'test-did-not-notice' : 'test-is-load-bearing'

console.log(`mutated run: ${out.mutated.ok ? 'PASS — the suite did NOT notice' : 'FAIL — the suite caught it'}`)
if (out.verdict === 'test-did-not-notice') {
  console.log('  This is a FINDING: the code under test can change without any assertion objecting.')
}
if (keep) console.log(`scratch kept at: ${tree}`)
console.log('PROBE-JSON: ' + JSON.stringify(out))
process.exit(0)
