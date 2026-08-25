#!/usr/bin/env node
// check-pipeline-config.mjs — is the pipeline's OWN configuration the one it was started with?
//
// THE PROBLEM (catalog issue #200)
//
// This pattern version-controls itself under `.claude/`, and the Builder checks out the
// ticket branch — in the MAIN working tree whenever `concurrency = 1`, which is the default
// and the recommended on-ramp. So a ticket branch whose base predates a `.claude` change
// silently REVERTS that change on disk, mid-run:
//
//   .claude/agents/*.md    who each stage is
//   .claude/workflows/*.js the schedulers themselves
//   .claude/scripts/*.mjs  delivery, publishing, the DAG
//   .claude/hooks/*.mjs    the main-session write guard
//   .claude/settings.json  what any of them may run
//
// Observed: a bounce-fix round reverted `agents/builder.md` to a previously archived
// variant, so the run used a different Builder definition than the one it was configured
// with — and answered a different question than the one asked. Nothing reported it. Across
// that repo at the time, EVERY live ticket branch had drifted by 2-3 files, and one had
// rolled back seven, including the delivery script and both schedulers.
//
// TWO FAULTS, TWO WINDOWS, TWO REMEDIES — and this is the part that is easy to get wrong.
//
// Agent definitions are read ONCE PER CLI PROCESS, not at spawn time. A marker appended to
// an agent file was still absent from that agent's system prompt 2.5 minutes later. So a
// mid-run checkout does NOT swap the agents of a run already in flight — it poisons the
// whole lifetime of the NEXT session started over that tree. **Restoring the files is not
// sufficient; that session must be restarted.**
//
// Scripts and hooks are the opposite: exec'd from disk on every invocation, so they roll
// back LIVE, mid-run.
//
// This script ONLY LOOKS. It never checks out, resets, merges, stashes or writes anything.
// Auto-repair would mutate a ticket branch or change the diff the Reviewer judged, which
// trades a reported problem for an unreported one.
//
// Usage:
//   node .claude/scripts/check-pipeline-config.mjs [--default-branch main] [--ref <ref>]
//
// Prints one machine-readable line last:
//   CONFIG-CHECK-JSON: {"intact":bool,"ref":"...","drifted":[...],"agentsDrifted":[...],
//                       "liveDrifted":[...],"mainTree":"...","notes":[...]}
// Exit codes: 0 = intact, 1 = drift found, 2 = could not determine (never reported as intact).

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf(n)
  return i === -1 || i === argv.length - 1 ? d : argv[i + 1]
}
const DEFAULT_BRANCH = flag('--default-branch', 'main')
const REF_ARG = flag('--ref', '')

const notes = []
const git = (args, cwd) => {
  const r = spawnSync('git', args, { encoding: 'utf8', cwd })
  return { ok: r.status === 0, out: `${r.stdout || ''}`.trim(), err: `${r.stderr || ''}`.trim() }
}

// Resolve the MAIN working tree, not whichever lane we happen to be in. `--git-common-dir`
// points at the main repository's .git even from inside a linked worktree, which is exactly
// the case at concurrency > 1.
const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
if (!commonDir.ok) {
  console.error('not a git repository (or git unavailable) — cannot check the pipeline config')
  console.log('CONFIG-CHECK-JSON: ' + JSON.stringify({ intact: null, error: 'not-a-git-repo', drifted: [], notes: ['git rev-parse failed'] }))
  process.exit(2)
}
const mainTree = dirname(resolve(commonDir.out))

if (!existsSync(join(mainTree, '.claude'))) {
  console.log(`no .claude/ in ${mainTree} — nothing to check`)
  console.log('CONFIG-CHECK-JSON: ' + JSON.stringify({ intact: true, ref: null, drifted: [], agentsDrifted: [], liveDrifted: [], mainTree, notes: ['no .claude directory'] }))
  process.exit(0)
}

// Which ref represents "the configuration this run was started with"? The remote default
// branch, because that is what every ticket branch is cut from and what a delivered change
// lands on. Deliberately NOT fetched: a check that reaches the network can fail for reasons
// that have nothing to do with the question, and would then report drift it cannot verify.
const candidates = REF_ARG ? [REF_ARG] : [`origin/${DEFAULT_BRANCH}`, DEFAULT_BRANCH]
let ref = ''
for (const c of candidates) {
  if (git(['rev-parse', '--verify', '--quiet', c], mainTree).ok) { ref = c; break }
}
if (!ref) {
  console.error(`could not resolve a comparison ref (tried ${candidates.join(', ')})`)
  console.log('CONFIG-CHECK-JSON: ' + JSON.stringify({ intact: null, error: 'no-ref', drifted: [], mainTree, notes: [`tried ${candidates.join(', ')}`] }))
  process.exit(2)
}
if (!REF_ARG && ref === DEFAULT_BRANCH) {
  notes.push(`origin/${DEFAULT_BRANCH} not present — compared against the local ${DEFAULT_BRANCH}, which may itself be behind`)
}

// Working tree vs ref, so this catches BOTH a rolled-back checkout and an uncommitted
// hand-edit. Either one means the running configuration is not the configured one.
const diff = git(['diff', '--name-only', ref, '--', '.claude'], mainTree)
if (!diff.ok) {
  console.error(`git diff against ${ref} failed: ${diff.err.split('\n')[0]}`)
  console.log('CONFIG-CHECK-JSON: ' + JSON.stringify({ intact: null, error: 'diff-failed', ref, drifted: [], mainTree, notes: [diff.err.split('\n')[0]] }))
  process.exit(2)
}

// Ephemeral by design: scratch the pipeline writes during a run, lane worktrees, and the
// human's deliberate override switch. None of these is the pipeline's configuration.
const IGNORED = [/^\.claude\/tmp\//, /^\.claude\/worktrees\//, /^\.claude\/allow-main-writes$/, /^\.claude\/delivered\.json$/]
const drifted = diff.out
  .split(/\r?\n/)
  .map((l) => l.trim().replace(/\\/g, '/'))
  .filter(Boolean)
  .filter((p) => !IGNORED.some((re) => re.test(p)))
  .sort()

// The two windows have different remedies, so they are reported separately rather than as
// one list a reader has to classify themselves.
const agentsDrifted = drifted.filter((p) => /^\.claude\/agents\//.test(p))
const liveDrifted = drifted.filter((p) => /^\.claude\/(scripts|hooks|workflows)\//.test(p) || p === '.claude/settings.json')

const intact = drifted.length === 0
const out = { intact, ref, drifted, agentsDrifted, liveDrifted, mainTree, notes }

if (intact) {
  console.log(`pipeline config intact (.claude matches ${ref})`)
} else {
  console.log(`! pipeline config DRIFTED from ${ref} — ${drifted.length} file(s):`)
  for (const p of drifted) console.log(`    ${p}`)
  if (liveDrifted.length) {
    console.log('  These take effect IMMEDIATELY — scripts, hooks and workflows are read from disk on every')
    console.log('  invocation, so the run is already using them:')
    for (const p of liveDrifted) console.log(`    ${p}`)
  }
  if (agentsDrifted.length) {
    console.log('  These do NOT affect the run already in flight — agent definitions are read once per CLI')
    console.log('  process — but they poison the whole lifetime of the NEXT session started over this tree:')
    for (const p of agentsDrifted) console.log(`    ${p}`)
    console.log('  RESTORING THE FILES IS NOT ENOUGH. That session must be restarted.')
  }
  console.log('  Nothing was changed here: repairing a ticket branch automatically would alter the diff a')
  console.log('  Reviewer judged, trading a reported problem for an unreported one.')
}
console.log('CONFIG-CHECK-JSON: ' + JSON.stringify(out))
process.exit(intact ? 0 : 1)
