#!/usr/bin/env node
// merge-docs-mr.mjs — the sanctioned path for a NON-ticket merge request.
//
//   node .claude/scripts/merge-docs-mr.mjs --title "<title>" [--body-file <path>]
//        [--base main] [--branch <name>] [--platform gh|glab] [--no-merge]
//
// The pattern has a deterministic, well-guarded path for delivering a TICKET
// (deliver-ticket.mjs) and had none for the merge requests it generates constantly: spec
// amendments, sub-PRD bumps, ticket corrections, checklist and README updates. Those were
// opened and merged by hand, so every agent invented its own wait-for-CI loop — and paid
// for it. Measured in the field: a hand-rolled poll printing one status line every 15s
// burned ~4,000 tokens waiting for a single documentation merge, on a repo whose CI takes
// 4–9 minutes. Nothing was learned from any line except the last. One phase produced five
// such merge requests (catalog issue #191).
//
// The waste is self-inflicted but structurally invited: with no helper to reach for, every
// agent writes the loop again, and the careless version is the default.
//
// THIS SCRIPT DOES NOT POLL. `glab mr merge` enables auto-merge by default and
// `gh pr merge --auto` is the GitHub equivalent: issue the merge once and the forge lands
// it when the pipeline goes green. No timer, no tokens, no agent sitting on a wait.
//
// Deliberately NOT ticket machinery: no Reviewer verdict comment, no `Closes #N`, no
// tracker close, no Definition-of-Done check. That is exactly what distinguishes a docs
// change from a delivery, and why reusing deliver-ticket.mjs here would be wrong — it
// would record a delivery that never happened.
//
// It DOES keep the destructive-diff guard, because a docs branch cut before a large merge
// produces the same revert-shaped diff (a real one measured +99 / -7688).
//
// Last line of stdout is machine-readable:
//   DOCS-MR-JSON: {"branch","base","url","autoMerge","pushed","notes"}
// Exit codes: 0 = definitive summary printed; 1 = bad invocation.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n) => {
  const i = argv.indexOf('--' + n)
  if (i === -1) return ''
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : ''
}

const TITLE = opt('title')
const BODY_FILE = opt('body-file')
const BASE = opt('base') || 'main'
const PLATFORM = opt('platform') || 'gh'
const NO_MERGE = has('no-merge')

const run = (bin, args, o = {}) => execFileSync(bin, args, { encoding: 'utf8', ...o })
const git = (args, o = {}) => run('git', args, o)
const tryGit = (args) => {
  try { return { ok: true, out: git(args, { stdio: ['ignore', 'pipe', 'pipe'] }) } }
  catch (e) { return { ok: false, out: String((e && (e.stderr || e.stdout || e.message)) || e).trim() } }
}
const cli = (args, o = {}) => {
  const raw = PLATFORM === 'gh' ? process.env.GH_BIN || 'gh' : process.env.GLAB_BIN || 'glab'
  const parts = raw.split(' ')
  return run(parts[0], [...parts.slice(1), ...args], o)
}
const tryCli = (args, o = {}) => {
  try { return { ok: true, out: cli(args, o) } }
  catch (e) { return { ok: false, out: String((e && (e.stderr || e.stdout || e.message)) || e).trim() } }
}
const firstLine = (s) => String(s).trim().split('\n')[0]
const lastLine = (s) => String(s).trim().split('\n').filter(Boolean).pop() || ''

const notes = []
const note = (m) => { notes.push(m); console.log('  (note) ' + m) }

const BRANCH = opt('branch') || (tryGit(['rev-parse', '--abbrev-ref', 'HEAD']).out || '').trim()

const finish = (code, extra = {}) => {
  console.log('DOCS-MR-JSON: ' + JSON.stringify({
    branch: BRANCH, base: BASE, url: '', autoMerge: false, pushed: false, ...extra,
    notes: notes.join('; '),
  }))
  process.exit(code)
}

if (!TITLE) {
  console.error('usage: node merge-docs-mr.mjs --title "<title>" [--body-file <path>] [--base main] [--branch <name>] [--platform gh|glab] [--no-merge]')
  process.exit(1)
}
if (PLATFORM !== 'gh' && PLATFORM !== 'glab') {
  console.error(`unknown platform: ${PLATFORM} (expected gh or glab)`)
  process.exit(1)
}
if (BODY_FILE && !existsSync(BODY_FILE)) {
  console.error(`--body-file not found: ${BODY_FILE}`)
  process.exit(1)
}
if (!BRANCH || BRANCH === 'HEAD') {
  console.error('cannot resolve the current branch — pass --branch <name>')
  process.exit(1)
}
if (BRANCH === BASE) {
  console.error(`--branch must differ from --base (got ${BRANCH} for both) — nothing to merge`)
  process.exit(1)
}

process.chdir(git(['rev-parse', '--show-toplevel']).trim())

// A dirty tree means the change is not actually in the commit being proposed.
const dirty = git(['status', '--porcelain', '-uall'])
  .split('\n')
  .filter((l) => l.trim() && !/\.claude\/tmp\/|\.claude\/worktrees\/|docs\/plans\/|docs\/prd\/dag\.html/.test(l))
if (dirty.length) { note('working tree not clean — commit or stash first'); finish(0) }

tryGit(['fetch', 'origin', BASE])

// The same destructive-diff guard delivery uses (catalog issue #151). A docs branch cut
// before a large merge and never rebased proposes to revert everything since — conflict
// free, with the deletion count the only signal. Two dots, not three: `a...b` measures
// from the merge base and hides exactly the damage this is looking for.
{
  const stat = tryGit(['diff', '--numstat', `origin/${BASE}..${BRANCH}`])
  if (stat.ok) {
    let added = 0
    let removed = 0
    for (const line of stat.out.split('\n')) {
      const m = line.match(/^(\d+)\s+(\d+)\s/)
      if (m) { added += Number(m[1]); removed += Number(m[2]) }
    }
    if (removed >= 200 && removed >= added * 5) {
      note(`refusing to open the MR: ${BRANCH} would REMOVE ${removed} lines and add ${added} against ${BASE}. `
        + `That is a stale branch cut from an older ${BASE} — rebase it and re-run.`)
      finish(0, { removed, added })
    }
  }
}

const push = tryGit(['push', '-u', 'origin', BRANCH])
if (!push.ok) { note(`branch push failed: ${lastLine(push.out)}`); finish(0) }
console.log(`+ pushed  ${BRANCH} -> origin`)

// Find an existing MR/PR first, so a re-run does not open a second one.
let url = ''
let number = null
{
  const found = PLATFORM === 'gh'
    ? tryCli(['pr', 'list', '--head', BRANCH, '--json', 'number,url', '--limit', '1'])
    : tryCli(['mr', 'list', '--source-branch', BRANCH])
  if (found.ok && found.out.trim()) {
    const m = found.out.match(/"number"\s*:\s*(\d+)/) || found.out.match(/[!#](\d+)/)
    if (m) number = Number(m[1])
    const u = found.out.match(/https?:\/\/\S+/)
    if (u) url = u[0]
  }
}

if (number) {
  console.log(`= exists  MR/PR #${number} for ${BRANCH}`)
} else {
  const args = PLATFORM === 'gh'
    ? ['pr', 'create', '--base', BASE, '--head', BRANCH, '--title', TITLE, ...(BODY_FILE ? ['--body-file', BODY_FILE] : ['--body', ''])]
    : ['mr', 'create', '--source-branch', BRANCH, '--target-branch', BASE, '--title', TITLE,
      '--description', BODY_FILE ? readFileSync(BODY_FILE, 'utf8') : '', '--yes']
  const created = tryCli(args)
  if (!created.ok) { note(`MR/PR create failed: ${firstLine(created.out)}`); finish(0) }
  url = lastLine(created.out)
  const m = url.match(/[#!/](\d+)\s*$/)
  number = m ? Number(m[1]) : null
  console.log(`+ opened  ${url}`)
}

if (NO_MERGE) {
  note('--no-merge: opened only, left for a human')
  finish(0, { url, pushed: true })
}
if (!number) {
  note('could not resolve the MR/PR number — opened, but auto-merge was not requested')
  finish(0, { url, pushed: true })
}

// The whole point: ONE call, then leave. The forge holds the merge until its own checks
// pass. No polling loop, no elapsed-time reporting, no tokens spent watching a pipeline.
const merge = PLATFORM === 'gh'
  ? tryCli(['pr', 'merge', String(number), '--auto', '--merge'])
  : tryCli(['mr', 'merge', String(number), '--yes', '--auto-merge',
    ...((tryGit(['rev-parse', `origin/${BRANCH}`]).out || '').trim() ? ['--sha', (tryGit(['rev-parse', `origin/${BRANCH}`]).out || '').trim()] : [])])

if (!merge.ok) {
  // Not fatal: the MR is open and a human can land it. Auto-merge is refused by some
  // configurations (no pipeline at all, or the setting disabled), and that is a fact to
  // report rather than a reason to start polling.
  note(`auto-merge not accepted: ${firstLine(merge.out)} — the MR is open; land it in the forge`)
  finish(0, { url, pushed: true })
}
console.log(`+ auto-merge requested — the forge will land it when its checks pass`)
finish(0, { url, autoMerge: true, pushed: true })
