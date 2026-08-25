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

import { existsSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

const out = { branchesDeleted: [], branchesKept: [], worktreesRemoved: [], worktreesOrphaned: [], worktreesKept: [], poisonedLinks: [], dryRun: DRY_RUN }

// Two spellings of one directory must compare equal. git reports the long, real path;
// a path built from the cwd can carry an 8.3 short name (C:/Users/HORACE~1/...), a
// different drive-letter case, or a symlinked prefix. Comparing those with resolve() alone
// says "not registered" for a worktree git is actively tracking -- and the orphan sweep
// below would then delete a live checkout behind git's back. realpathSync.native collapses
// all three; it throws for a path that no longer exists, which resolve() handles fine.
const canon = (p) => {
  try { return realpathSync.native(resolve(p)).toLowerCase() } catch { return resolve(p).toLowerCase() }
}

// Every lane path git currently tracks, canonicalised. Read FRESH on each call: the removal
// loop prunes between calls, so a cached list would answer for the tree as it used to be.
// One place asks git what it tracks, so the removal loop and the orphan sweep below cannot
// drift apart on how a path is spelled.
const registeredPaths = () => new Set(
  (git(['worktree', 'list', '--porcelain']).out || '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => canon(l.slice('worktree '.length).trim()))
)
const isRegistered = (p) => registeredPaths().has(canon(p))

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

      // Removal failed. Whatever the reason, the run must not CLAIM the worktree is gone:
      // git worktree prune exits 0 whether it pruned anything or nothing at all, so using its
      // exit code as proof reports a cleaned tree while git still lists it. That ghost entry is
      // what later makes git branch -D ticket/<id> fail with "checked out somewhere else",
      // under a cleanup report saying everything was fine (catalog issue #199).
      //
      // A LOCKED worktree is a human saying do not touch this, so its directory is left intact
      // -- but it takes the same verified path out, rather than a special case that skips the
      // check and can never be exercised.
      const isLocked = /locked/i.test(rm.out)
      if (!isLocked) {
        // A worktree whose directory is already gone but whose admin entry survives still has
        // to disappear: a stale entry blocks the next run when it tries to add the same path.
        try { rmSync(p, { recursive: true, force: true }) } catch {}
      }
      git(['worktree', 'prune'])
      if (!isRegistered(p)) { out.worktreesRemoved.push(p); continue }
      out.worktreesKept.push(p)
      note(isLocked
        ? `could not remove run worktree ${p}: it is locked -- run: git worktree unlock ${p}`
        : `could not remove run worktree ${p}: ${rm.out.split(String.fromCharCode(10))[0]} -- git still lists it, so a stale entry remains`)
    }
  }

  // ORPHANS: directories under .claude/worktrees/ that git no longer tracks (catalog issue
  // #199). `git worktree prune` drops administrative entries for directories that are
  // ALREADY GONE; it does not delete anything. So a run killed mid-flight leaves lane
  // directories that both the loop above and prune step straight past, because neither is
  // listed by `git worktree list`. One adopter measured 29 such directories from a single
  // run id, holding 1.2 GB — each lane is a full checkout with its own node_modules — while
  // git reported four worktrees, none of them those 29.
  //
  // Killed runs are exactly when lanes are most numerous and least likely to have been
  // cleaned, so a sweep that only covers the happy path does not cover the failure mode that
  // produces the leak.
  const wtRoot = '.claude/worktrees'
  if (existsSync(wtRoot)) {
    const registered = registeredPaths()
    let entries = []
    try { entries = readdirSync(wtRoot, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch {}
    for (const d of entries) {
      const p = join(wtRoot, d.name)
      if (registered.has(canon(p))) continue // handled by the loop above
      if (DRY_RUN) { out.worktreesOrphaned.push(p); continue }
      try {
        rmSync(p, { recursive: true, force: true })
        out.worktreesOrphaned.push(p)
      } catch (e) {
        out.worktreesKept.push(p)
        note(`could not remove orphaned lane directory ${p}: ${e && e.message ? e.message : e}`)
      }
    }
    if (out.worktreesOrphaned.length) {
      console.log(`  reaped ${out.worktreesOrphaned.length} orphaned lane director(ies) that git no longer tracked`)
    }
  }
}

// ---- a lane that poisoned the main checkout (catalog issue #199, part 2b) -----------------
// Because lanes live INSIDE the repository, package managers hoist across the boundary. A
// `pnpm install` inside a lane wrote a symlink in the MAIN checkout pointing into the lane's
// store. When the lane was removed the link dangled, and the app failed with
// `Cannot find package 'fastify'` on a `main` whose diff explains nothing — it reads,
// convincingly, as a regression in freshly merged work. A team lost time bisecting merged
// tickets before recognising it.
//
// Two properties make it worse: `pnpm install --force` reports "Already up to date" and
// leaves the dangling link in place, and the diagnostic (`readlink` showing a target under
// .claude/worktrees/) is not something anyone guesses.
//
// This REPORTS and does not repair. The repair is to delete the affected package's
// node_modules and reinstall, and deleting a node_modules tree on a developer's behalf is
// not a cleanup script's call.
const scanPoisonedLinks = () => {
  const hits = []
  const skip = new Set(['.git', '.claude'])
  const walk = (dir, depth) => {
    if (depth > 6 || hits.length >= 40) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (hits.length >= 40) return
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) {
        try {
          const target = readlinkSync(p)
          if (/[/\\]\.claude[/\\]worktrees[/\\]/.test(target)) {
            let dangling = false
            try { statSync(p) } catch { dangling = true }
            hits.push({ link: p.replace(/\\/g, '/'), target: String(target).replace(/\\/g, '/'), dangling })
          }
        } catch {}
        continue
      }
      if (!e.isDirectory()) continue
      if (skip.has(e.name)) continue
      // node_modules is where the hoisting happens, so it is walked rather than skipped —
      // but only one level of package directories deep, which is where the links land.
      walk(p, e.name === 'node_modules' ? depth + 3 : depth + 1)
    }
  }
  try { walk('.', 0) } catch {}
  return hits
}

out.poisonedLinks = scanPoisonedLinks()
if (out.poisonedLinks.length) {
  const dangling = out.poisonedLinks.filter((h) => h.dangling)
  note(
    `${out.poisonedLinks.length} symlink(s) in this checkout point INTO .claude/worktrees/` +
    (dangling.length ? `, ${dangling.length} of them dangling` : '') +
    `. A package manager run inside a lane hoisted into the main tree; when the lane is removed the link ` +
    `breaks and the app fails with a package-resolution error on a clean default branch, which reads as a ` +
    `regression in freshly merged code and is not. \`pnpm install --force\` does NOT repair it — delete the ` +
    `affected package's node_modules directory and reinstall. Nothing was changed here.`
  )
  for (const h of out.poisonedLinks.slice(0, 10)) {
    console.log(`  ${h.dangling ? 'DANGLING' : 'links to lane'}  ${h.link} -> ${h.target}`)
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
  `${out.worktreesRemoved.length} worktree(s) removed, ${out.worktreesOrphaned.length} orphan(s) reaped` +
  `${out.poisonedLinks.length ? `, ${out.poisonedLinks.length} lane symlink(s) FOUND IN THE MAIN TREE` : ''}` +
  `${DRY_RUN ? ' (dry run)' : ''}`
)
console.log('CLEANUP-JSON: ' + JSON.stringify({ ...out, escalations }))
process.exit(0)
