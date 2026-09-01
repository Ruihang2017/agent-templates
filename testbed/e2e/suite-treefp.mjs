// E2E for tree-fingerprint.mjs (catalog issue #233): the check that does not care which tool
// did the writing.
//
// The write guard is a blocklist of shell idioms. A field report found it permitting `patch`
// while refusing `cp`, and probing found five more gaps. Those are closed, but a shell is a
// general-purpose machine and the next tool nobody listed is always available — so the
// property worth testing is the one that does not depend on the list: a modification changes
// the hash, whatever made it.
//
// The three properties, in the order they matter:
//   1. any write to the tree changes the fingerprint;
//   2. the paths the PIPELINE itself writes between build and merge do NOT (or every delivery
//      would be refused, which is an outage dressed as a control);
//   3. "not checked" is reported as null, never as "unchanged".
//
// Real git repositories, no network, no tokens.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'treefp'
const SCRIPT = fileURLToPath(
  new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/tree-fingerprint.mjs', import.meta.url)
)

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-treefp-'))
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
  spawnSync('git', ['init', '-q', '-b', 'main', dir])
  g('config', 'user.email', 'e2e@example.com')
  g('config', 'user.name', 'e2e')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const two = () => 2\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'init')
  return dir
}

function fp(dir, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' })
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('TREE-FINGERPRINT-JSON: '))
  let json = null
  try { json = line ? JSON.parse(line.slice('TREE-FINGERPRINT-JSON: '.length)) : null } catch {}
  return { ...r, out: `${r.stdout || ''}${r.stderr || ''}`, json }
}

export async function run() {
  // TF1: stable on a clean tree, and it actually produced a hash.
  {
    const dir = repo()
    try {
      const a = fp(dir)
      const b = fp(dir)
      eq(S, 'TF1 exit 0 on a clean tree', a.status, 0)
      check(S, 'TF1 a fingerprint is produced', !!a.json && /^[0-9a-f]{64}$/.test(a.json.sha || ''), JSON.stringify(a.json))
      eq(S, 'TF1 and it is stable across runs', a.json.sha, b.json.sha)
      check(S, 'TF1 the HEAD it pinned is reported', !!a.json.head && a.json.head.length >= 7)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // TF2: the case the whole issue is about — an UNCOMMITTED edit to a tracked file. This is
  // exactly what `--expect-head` cannot see, because the branch head does not move.
  {
    const dir = repo()
    try {
      const before = fp(dir).json.sha
      const headBefore = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      writeFileSync(join(dir, 'src', 'app.mjs'), 'export const two = () => 3\n')
      const headAfter = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      const after = fp(dir).json.sha

      eq(S, 'TF2 the branch head did NOT move, which is why --expect-head misses this', headBefore, headAfter)
      check(S, 'TF2 but the fingerprint changed', before !== after, before + ' vs ' + after)

      const refused = fp(dir, ['--expect', before])
      eq(S, 'TF2 --expect exits 1 on a changed tree', refused.status, 1)
      eq(S, 'TF2 and reports matched: false', refused.json && refused.json.matched, false)
      check(S, 'TF2 the message says what to run to see it',
        /git status --porcelain -uall/.test(refused.out), refused.out.slice(0, 200))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // TF3: an added file and a deleted file both count. A role that may not write has no
  // business creating one either, so presence is enough — the content need not be diffable.
  {
    const dir = repo()
    try {
      const base = fp(dir).json.sha
      writeFileSync(join(dir, 'src', 'sneak.mjs'), 'x\n')
      check(S, 'TF3 an untracked file changes it', fp(dir).json.sha !== base)
      rmSync(join(dir, 'src', 'sneak.mjs'))
      eq(S, 'TF3 and removing it restores the original', fp(dir).json.sha, base)
      rmSync(join(dir, 'src', 'app.mjs'))
      check(S, 'TF3 a deleted tracked file changes it', fp(dir).json.sha !== base)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // TF4: the pipeline's OWN writes must not trip it. Between the build and the merge the
  // Reviewer writes its record under .claude/tmp/ (it has no Write tool — catalog #201), the
  // Architect's plan sits in docs/plans/, other lanes live under .claude/worktrees/, and
  // dag.html is regenerated on every scan. A fingerprint that counted those would refuse
  // every delivery — a control that stops the pipeline is an outage, not a control.
  {
    const dir = repo()
    try {
      const base = fp(dir).json.sha
      mkdirSync(join(dir, '.claude', 'tmp'), { recursive: true })
      mkdirSync(join(dir, '.claude', 'worktrees', 'wf_x'), { recursive: true })
      mkdirSync(join(dir, 'docs', 'plans'), { recursive: true })
      mkdirSync(join(dir, 'docs', 'prd'), { recursive: true })
      writeFileSync(join(dir, '.claude', 'tmp', 'T-01-verdict.md'), 'CLEAR: findings none\n')
      writeFileSync(join(dir, '.claude', 'worktrees', 'wf_x', 'junk'), 'x\n')
      writeFileSync(join(dir, 'docs', 'plans', 'T-01.md'), '# plan\n')
      writeFileSync(join(dir, 'docs', 'prd', 'dag.html'), '<html>regenerated</html>\n')
      eq(S, 'TF4 the review record, plan, lanes and dag.html are all ignored', fp(dir).json.sha, base)
      eq(S, 'TF4 so --expect still matches', fp(dir, ['--expect', base]).status, 0)

      // ...but the exemption is scoped to those paths, not to everything under them by name
      writeFileSync(join(dir, 'src', 'tmp.mjs'), 'x\n')
      check(S, 'TF4 a file merely NAMED tmp under src is not exempt', fp(dir).json.sha !== base)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // TF5: a commit is a change too. The Reviewer may not commit either, and a fingerprint that
  // ignored HEAD would let a committed rewrite through while catching a stray edit.
  {
    const dir = repo()
    try {
      const base = fp(dir).json.sha
      writeFileSync(join(dir, 'src', 'app.mjs'), 'export const two = () => 3\n')
      spawnSync('git', ['-C', dir, 'commit', '-qam', 'sneaky'], { encoding: 'utf8' })
      check(S, 'TF5 a committed change is caught, not just a dirty tree', fp(dir).json.sha !== base)
      eq(S, 'TF5 --expect refuses it', fp(dir, ['--expect', base]).status, 1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // TF6: it fails closed and says so, rather than returning a hash of nothing.
  {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-treefp-nogit-'))
    try {
      const r = fp(dir)
      eq(S, 'TF6 outside a git repository it exits 1', r.status, 1)
      check(S, 'TF6 and returns no fingerprint at all', !!r.json && r.json.sha === null, JSON.stringify(r.json))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}
