// E2E for cleanup-run.mjs against REAL git repositories.
//
// This was a prompt (catalog issue #151) and became a script (issue #208). The rule it
// enforces is mechanical and the cost of getting it wrong is asymmetric: deleting a
// delivered ticket's branch is tidy-up, deleting a FAILED ticket's branch destroys the only
// copy of work a human still has to look at. suite-startall asserts the shape of the script;
// this suite asserts its behaviour, because a structural assertion cannot tell you whether
// `git branch -D` was actually reached.
//
// Zero tokens, zero network.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'cleanup'
const SCRIPT = fileURLToPath(
  new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/cleanup-run.mjs', import.meta.url)
)

function repo({ branches = [], worktrees = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-clean-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'e2e')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  for (const b of branches) git('branch', b)
  if (worktrees.length) mkdirSync(join(dir, '.claude', 'worktrees'), { recursive: true })
  for (const w of worktrees) git('worktree', 'add', '-q', join('.claude', 'worktrees', w), '-b', `wt-${w}`)
  return dir
}

function clean(dir, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('CLEANUP-JSON: '))
  let json = null
  try { json = line ? JSON.parse(line.slice('CLEANUP-JSON: '.length)) : null } catch {}
  const branches = execFileSync('git', ['-C', dir, 'branch', '--list'], { encoding: 'utf8' })
    .split(/\r?\n/).map((l) => l.replace('*', '').trim()).filter(Boolean)
  const wt = execFileSync('git', ['-C', dir, 'worktree', 'list'], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean)
  return { status: r.status, out, json, branches, worktrees: wt }
}

export async function run() {
  // ---- C1: delivered branches go; everything else stays -------------------------------
  {
    const dir = repo({ branches: ['ticket/T-01', 'ticket/T-02', 'ticket/T-FAILED', 'feature/human-work'] })
    const r = clean(dir, ['--delivered', 'T-01,T-02', '--default-branch', 'main'])
    eq(S, 'C1 exit 0', r.status, 0)
    eq(S, 'C1 delivered branches deleted', r.json.branchesDeleted.sort(), ['ticket/T-01', 'ticket/T-02'])
    check(S, 'C1 a FAILED ticket branch survives — it is the only copy of that work',
      r.branches.includes('ticket/T-FAILED'))
    check(S, "C1 an unrelated human branch is untouched", r.branches.includes('feature/human-work'))
    check(S, 'C1 the default branch is untouched', r.branches.includes('main'))
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C2: a branch it could not delete is REPORTED, never assumed gone ----------------
  // Silence is the entire failure mode here: an uncleaned branch is what later opens a
  // merge request proposing to revert the default branch.
  {
    const dir = repo({ branches: ['ticket/T-01'] })
    const r = clean(dir, ['--delivered', 'T-01,T-GHOST', '--default-branch', 'main'])
    eq(S, 'C2 the real branch is deleted', r.json.branchesDeleted, ['ticket/T-01'])
    eq(S, 'C2 the missing one is reported as kept, not silently succeeded', r.json.branchesKept, ['ticket/T-GHOST'])
    check(S, 'C2 with an escalation naming it', r.json.escalations.some((e) => /ticket\/T-GHOST/.test(e)))
    check(S, 'C2 and the escalation says why it matters', r.json.escalations.some((e) => /reverts main/.test(e)))
    check(S, 'C2 the escalation is visible to a human, not only in the JSON', /^! /m.test(r.out))
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C3: it refuses the default branch even if told to delete it ---------------------
  {
    const dir = repo({ branches: ['ticket/main'] })
    const r = clean(dir, ['--delivered', 'main', '--default-branch', 'main'])
    check(S, 'C3 refuses to delete the default branch', r.json.branchesDeleted.length === 0)
    check(S, 'C3 and says so', r.json.escalations.some((e) => /default branch/.test(e)))
    check(S, 'C3 main still exists', r.branches.includes('main'))
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C4: worktrees ------------------------------------------------------------------
  {
    const dir = repo({ branches: ['ticket/T-01'], worktrees: ['lane1', 'lane2'] })
    const before = clean(dir, ['--delivered', '', '--dry-run'])
    eq(S, 'C4 a dry run removes nothing', before.worktrees.length, 3)
    const r = clean(dir, ['--delivered', 'T-01', '--default-branch', 'main'])
    eq(S, 'C4 run worktrees are removed', r.json.worktreesRemoved.length, 2)
    eq(S, 'C4 only the main working tree is left', r.worktrees.length, 1)
    rmSync(dir, { recursive: true, force: true })
  }
  {
    const dir = repo({ branches: ['ticket/T-01'], worktrees: ['lane1'] })
    const r = clean(dir, ['--delivered', 'T-01', '--keep-worktrees'])
    eq(S, 'C4b --keep-worktrees leaves them alone', r.json.worktreesRemoved.length, 0)
    eq(S, 'C4b while the branch is still cleaned', r.json.branchesDeleted, ['ticket/T-01'])
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C5: invocation -------------------------------------------------------------------
  {
    const dir = repo({ branches: ['ticket/T-01'] })
    const missing = spawnSync(process.execPath, [SCRIPT, '--default-branch', 'main'], { cwd: dir, encoding: 'utf8' })
    eq(S, 'C5 omitting --delivered exits 1 rather than guessing', missing.status, 1)
    const empty = clean(dir, ['--delivered', ''])
    eq(S, 'C5 an EMPTY --delivered is legal (worktree-only cleanup) and deletes no branch', empty.json.branchesDeleted.length, 0)
    check(S, 'C5 and leaves the ticket branch alone', empty.branches.includes('ticket/T-01'))
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C6: a dry run is a report, not an action ------------------------------------------
  {
    const dir = repo({ branches: ['ticket/T-01'] })
    const r = clean(dir, ['--delivered', 'T-01', '--dry-run'])
    check(S, 'C6 the branch survives a dry run', r.branches.includes('ticket/T-01'))
    check(S, 'C6 but the report says what WOULD go', r.json.branchesDeleted.includes('ticket/T-01'))
    eq(S, 'C6 and flags itself as a dry run', r.json.dryRun, true)
    rmSync(dir, { recursive: true, force: true })
  }
}
