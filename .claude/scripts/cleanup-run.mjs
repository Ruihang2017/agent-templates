#!/usr/bin/env node
// cleanup-run.mjs — remove a finished run's ticket branches and worktrees.
//
// This was a prompt (catalog issue #151): an agent was told, in prose, which branches it
// might delete and which it must leave alone. The rule is mechanical and the consequence of
// getting it wrong is severe, so it belongs in code — an agent asked to "delete only the
// DELIVERED ones" is one summarisation away from deleting a failed ticket's branch, which
// is the only remaining copy of work a human still has to look at.
//
// Why it matters at all: on a squash-on-merge project the delivered commit is a NEW commit,
// so a ticket tip is never an ancestor of the default branch. A leftover ticket branch will
// therefore be re-pushed by any later deliver invocation and opened as a merge request
// against a default branch that has moved on — proposing to revert everything merged since.
// Four such merge requests sat open in a real repository, one of them -12,095 lines, all
// conflict-free, found only because a human happened to scroll the list.
//
// Usage:
//   node .claude/scripts/cleanup-run.mjs --delivered <id,id,...> [options]
//
//   --delivered <ids>       ticket ids that FULLY landed. Only these branches are deleted.
//   --default-branch <name> never touched; named only so the report can warn about it
//   --keep-worktrees        leave .claude/worktrees/ alone
//   --dry-run               report what would happen, delete nothing
//
// Last line of stdout:
//   CLEANUP-JSON: {"branchesDeleted":[...],"branchesKept":[...],"worktreesRemoved":[...],
//                  "worktreesKept":[...],"escalations":[...]}
// Exit codes: 0 = a definitive report was printed (items may still have failed);
//             1 = bad invocation.
//
// What could NOT be cleaned is REPORTED rather than dropped. The whole failure mode here is
// that nothing said anything.

import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const flag = (n, d) => {
  const i = argv.indexOf(n)
  return i === -1 || i === argv.length - 1 ? d : argv[i + 1]
}

const DEFAULT_BRANCH = flag('--default-branch', 'main')
const KEEP_WORKTREES = has('--keep-worktrees')
const DRY_RUN = has('--dry-run')

const delivered = String(flag('--delivered', ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

if (!argv.includes('--delivered')) {
  console.error('--delivered <id,id,...> is required (pass an empty value to clean worktrees only)')
  process.exit(1)
}

const escalations = []
const note = (m) => { escalations.push(m); console.log(`! ${m}`) }
const git = (a) => {
  const r = spawnSync('git', a, { encoding: 'utf8' })
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }
}

const out = { branchesDeleted: [], branchesKept: [], worktreesRemoved: [], worktreesKept: [], dryRun: DRY_RUN }

// ---- worktrees --------------------------------------------------------------------------
// Only ours: paths under .claude/worktrees/. A worktree a human created elsewhere is not
// this run's to remove, however tempting the tidy-up.
if (!KEEP_WORKTREES) {
  const prune = git(['worktree', 'prune'])
  if (!prune.ok) note(`git worktree prune failed: ${prune.out.split('\n')[0]}`)

  const list = git(['worktree', 'list', '--porcelain'])
  if (!list.ok) note(`could not list worktrees: ${list.out.split('\n')[0]}`)
  else {
    for (const line of list.out.split(/\r?\n/)) {
      if (!line.startsWith('worktree ')) continue
      const p = line.slice('worktree '.length).trim()
      if (!/[/\\]\.claude[/\\]worktrees[/\\]/.test(p)) continue
      if (DRY_RUN) { out.worktreesRemoved.push(p); continue }
      const rm = git(['worktree', 'remove', '--force', p])
      if (rm.ok) { out.worktreesRemoved.push(p); continue }
      // A worktree whose directory is gone but whose admin entry survives, or one holding a
      // lock, still has to disappear — a stale entry blocks the next run's `worktree add`.
      try { rmSync(p, { recursive: true, force: true }) } catch {}
      const retry = git(['worktree', 'prune'])
      if (retry.ok) out.worktreesRemoved.push(p)
      else { out.worktreesKept.push(p); note(`could not remove run worktree ${p}: ${rm.out.split('\n')[0]}`) }
    }
  }
}

// ---- branches ---------------------------------------------------------------------------
// ONLY the ids the caller reported as fully delivered. A failed, escalated or
// awaiting-merge ticket's branch is evidence and stays.
for (const id of delivered) {
  const branch = `ticket/${id}`
  if (branch === DEFAULT_BRANCH || id === DEFAULT_BRANCH) {
    note(`refusing to delete ${branch}: it is the default branch`)
    out.branchesKept.push(branch)
    continue
  }
  if (DRY_RUN) { out.branchesDeleted.push(branch); continue }
  const del = git(['branch', '-D', branch])
  if (del.ok) out.branchesDeleted.push(branch)
  else {
    out.branchesKept.push(branch)
    note(
      `could not delete ${branch}: ${del.out.split('\n')[0]} — delete it by hand; ` +
      `a stale ticket branch can later open a merge request that reverts ${DEFAULT_BRANCH}`
    )
  }
}

// Never delete a REMOTE branch: the remote copy is what a human reviews after the fact.
console.log(
  `cleanup: ${out.branchesDeleted.length} branch(es) deleted, ${out.branchesKept.length} kept, ` +
  `${out.worktreesRemoved.length} worktree(s) removed${DRY_RUN ? ' (dry run)' : ''}`
)
console.log('CLEANUP-JSON: ' + JSON.stringify({ ...out, escalations }))
process.exit(0)
