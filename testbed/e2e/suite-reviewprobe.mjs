// E2E for review-probe.mjs (catalog issue #229): the Reviewer's sanctioned mutation probe.
//
// The property that matters is not "it mutates a file" — it is that the mutation NEVER
// lands in the repository under review, and that a verdict is only returned when it was
// actually earned. A probe that reported "test-is-load-bearing" off a suite that was
// already red would be worse than no probe: it would manufacture the evidence the Reviewer
// is supposed to gather.
//
// Runs against REAL git repositories with a real (tiny) test command. Zero tokens, zero
// network.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'reviewprobe'
const SCRIPT = fileURLToPath(
  new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/review-probe.mjs', import.meta.url)
)

// A repo whose "suite" asserts one thing about src/app.mjs, so a mutation to that line is
// caught and a mutation elsewhere is not. Small enough to run in milliseconds.
function repo({ suitePasses = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-probe-'))
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
  spawnSync('git', ['init', '-q', '-b', 'main', dir])
  g('config', 'user.email', 'e2e@example.com')
  g('config', 'user.name', 'e2e')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.mjs'), ['export const two = () => 2', 'export const spare = () => 0', ''].join('\n'))
  writeFileSync(
    join(dir, 'test.mjs'),
    [
      "import { two } from './src/app.mjs'",
      `if (two() !== ${suitePasses ? 2 : 999}) { console.error('two() wrong'); process.exit(1) }`,
      "console.log('ok')",
      '',
    ].join('\n')
  )
  g('add', '-A')
  g('commit', '-q', '-m', 'init')
  return dir
}

function probe(dir, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('PROBE-JSON: '))
  let json = null
  try { json = line ? JSON.parse(line.slice('PROBE-JSON: '.length)) : null } catch {}
  const worktrees = spawnSync('git', ['-C', dir, 'worktree', 'list'], { encoding: 'utf8' }).stdout || ''
  return { ...r, out, json, worktrees }
}

const TEST = 'node test.mjs'

export async function run() {
  // RP1: a mutation the suite catches — the verdict the Reviewer is looking for.
  {
    const dir = repo()
    try {
      const r = probe(dir, ['--file', 'src/app.mjs', '--test', TEST, '--line', '1', '--replace', 'export const two = () => 3'])
      eq(S, 'RP1 exit 0', r.status, 0)
      eq(S, 'RP1 verdict', r.json && r.json.verdict, 'test-is-load-bearing')
      check(S, 'RP1 the baseline ran and was green first', r.json && r.json.baseline && r.json.baseline.ok === true)
      check(S, 'RP1 the mutated run failed', r.json && r.json.mutated && r.json.mutated.ok === false)
      // the whole point
      eq(S, 'RP1 the repo under review is UNTOUCHED', readFileSync(join(dir, 'src', 'app.mjs'), 'utf8').split('\n')[0], 'export const two = () => 2')
      check(S, 'RP1 no scratch worktree is left registered', !/review-probe/.test(r.worktrees), r.worktrees)
      check(S, 'RP1 no scratch directory is left on disk', !!r.json && !existsSync(r.json.scratch))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // RP2: a mutation nothing asserts on. This is a FINDING, not a failure of the probe —
  // the Reviewer learns the code can change with no test objecting.
  {
    const dir = repo()
    try {
      const r = probe(dir, ['--file', 'src/app.mjs', '--test', TEST, '--line', '2', '--replace', 'export const spare = () => 12345'])
      eq(S, 'RP2 exit 0 — the probe ran fine', r.status, 0)
      eq(S, 'RP2 verdict names the gap', r.json && r.json.verdict, 'test-did-not-notice')
      check(S, 'RP2 and says so in words, since this is the result a reader skims past',
        /did NOT notice/.test(r.out) && /FINDING/.test(r.out), r.out.slice(-300))
      eq(S, 'RP2 the repo under review is UNTOUCHED', readFileSync(join(dir, 'src', 'app.mjs'), 'utf8').split('\n')[1], 'export const spare = () => 0')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // RP3: an ALREADY-RED suite must not yield a verdict. "It went red under mutation" is
  // evidence only if it was green before; without the baseline this probe would report
  // test-is-load-bearing for every mutation in a repo whose suite happens to be broken,
  // and a Reviewer would carry that into a CLEAR.
  {
    const dir = repo({ suitePasses: false })
    try {
      const r = probe(dir, ['--file', 'src/app.mjs', '--test', TEST, '--line', '1', '--replace', 'export const two = () => 3'])
      eq(S, 'RP3 exit 1 — no verdict was earned', r.status, 1)
      eq(S, 'RP3 verdict', r.json && r.json.verdict, 'baseline-already-red')
      check(S, 'RP3 it explains why nothing was learned',
        (r.json.notes || []).some((n) => /proves nothing/.test(n)), JSON.stringify(r.json.notes))
      check(S, 'RP3 no scratch worktree is left registered', !/review-probe/.test(r.worktrees), r.worktrees)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // RP4: --find/--replace, and the refusal when the text is absent. A probe that silently
  // mutated nothing would run a clean suite and report test-did-not-notice — a fabricated
  // finding against code that was never changed.
  {
    const dir = repo()
    try {
      const hit = probe(dir, ['--file', 'src/app.mjs', '--test', TEST, '--find', '=> 2', '--replace', '=> 3'])
      eq(S, 'RP4 --find mutates and the suite catches it', hit.json && hit.json.verdict, 'test-is-load-bearing')

      const miss = probe(dir, ['--file', 'src/app.mjs', '--test', TEST, '--find', 'nowhere-in-this-file', '--replace', 'x'])
      eq(S, 'RP4 absent --find text exits 1', miss.status, 1)
      eq(S, 'RP4 and returns no verdict', miss.json && miss.json.verdict, 'could-not-run')
      check(S, 'RP4 it says nothing would be mutated', /does not occur/.test(miss.out), miss.out.slice(0, 200))

      const noop = probe(dir, ['--file', 'src/app.mjs', '--test', TEST, '--find', '=> 2', '--replace', '=> 2'])
      eq(S, 'RP4 a mutation identical to the original exits 1', noop.status, 1)
      check(S, 'RP4 rather than probing nothing and calling it a result', /identical/.test(noop.out), noop.out.slice(0, 200))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // RP5: containment. --file may not reach outside the repository, checked with relative()
  // rather than a string prefix — the same rule the write guard uses.
  {
    const dir = repo()
    try {
      const r = probe(dir, ['--file', '../../../etc/hosts', '--test', TEST, '--line', '1', '--replace', 'x'])
      eq(S, 'RP5 a path outside the repo exits 1', r.status, 1)
      check(S, 'RP5 and names the rule', /must be inside the repository/.test(r.out), r.out.slice(0, 200))
      const t = probe(dir, ['--file', 'src/../src/app.mjs', '--test', TEST, '--line', '1', '--replace', 'export const two = () => 3'])
      eq(S, 'RP5 but traversal that stays inside is fine', t.status, 0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // RP6: a malformed invocation must refuse rather than guess. Two mutations, or none, is
  // an ambiguous request; picking one silently is how a probe reports on something other
  // than what was asked.
  {
    const dir = repo()
    try {
      const none = probe(dir, ['--file', 'src/app.mjs', '--test', TEST])
      eq(S, 'RP6 no mutation exits 1', none.status, 1)
      const both = probe(dir, ['--file', 'src/app.mjs', '--test', TEST, '--line', '1', '--find', 'x', '--replace', 'y'])
      eq(S, 'RP6 two mutations exit 1', both.status, 1)
      check(S, 'RP6 it asks for exactly one', /exactly one mutation/.test(both.out), both.out.slice(0, 200))
      const noTest = probe(dir, ['--file', 'src/app.mjs', '--line', '1', '--replace', 'x'])
      eq(S, 'RP6 a probe with no suite to run exits 1', noTest.status, 1)
      check(S, 'RP6 because a mutation nobody runs proves nothing', /meaningless/.test(noTest.out), noTest.out.slice(0, 200))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // RP7: a KILLED probe leaves its worktree registered — `git worktree prune` will not drop
  // an entry whose directory still exists, so the stale entries accumulate in the repo under
  // review. Issue #199's finding, applied to this script: the successor reaps them.
  {
    const dir = repo()
    try {
      const stale = mkdtempSync(join(tmpdir(), 'review-probe-'))
      spawnSync('git', ['-C', dir, 'worktree', 'add', '--detach', join(stale, 'tree'), 'HEAD'], { encoding: 'utf8' })
      const before = spawnSync('git', ['-C', dir, 'worktree', 'list'], { encoding: 'utf8' }).stdout || ''
      check(S, 'RP7 the stale scratch tree is registered to begin with', /review-probe/.test(before), before)

      const r = probe(dir, ['--file', 'src/app.mjs', '--test', TEST, '--line', '1', '--replace', 'export const two = () => 3'])
      eq(S, 'RP7 the next probe still works', r.json && r.json.verdict, 'test-is-load-bearing')
      check(S, 'RP7 and the leftover is gone', !/review-probe/.test(r.worktrees), r.worktrees)
      check(S, 'RP7 the reaping is reported, not silent',
        (r.json.notes || []).some((n) => /reaped a scratch tree/.test(n)), JSON.stringify(r.json.notes))
      rmSync(stale, { recursive: true, force: true })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}
