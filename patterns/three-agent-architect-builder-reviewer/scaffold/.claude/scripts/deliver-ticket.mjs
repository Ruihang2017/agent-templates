#!/usr/bin/env node
// deliver-ticket.mjs — the ONLY sanctioned delivery path for the three-agent
// pattern (catalog issue #26). Delivery used to be a generic LLM agent prompted
// to merge + close + verify; harness safety classifiers repeatedly blocked that
// agent even after a journaled CLEAR (3/3 in one field session), stranding
// CLEAR-verdict tickets. Like issue creation (publish-tickets.mjs), delivery is
// now deterministic: the merge policy stays mechanically checkable and the only
// permission surface is this one command.
//
// Usage:
//   node .claude/scripts/deliver-ticket.mjs --id <ticket-id> --branch <branch>
//        [--default-branch main] [--issue <n>] [--platform gh|glab]
//        [--test-cmd "<command>"]
//
// Does, in order (every step lands in the summary):
//   1. refuses to run on a dirty working tree
//   2. checks out <default-branch>; merges <branch> with --no-ff (an
//      already-merged branch is recognized and succeeds idempotently);
//      a conflict aborts the merge and leaves the tree clean
//   3. pushes <default-branch> to origin (required only when origin exists)
//   4. closes the tracker issue (--issue <n>, else looked up by the "[<id>]"
//      title prefix) and VERIFIES it is actually closed afterwards
//   5. deterministic DoD: plan file exists (docs/plans/<id>.md), merged,
//      pushed, issue closed, plus --test-cmd green when supplied (post-merge
//      test runs otherwise stay with /verify-delivery)
//
// Last line of stdout is machine-readable for run-milestone:
//   DELIVER-SUMMARY-JSON: {"id","branch","merged","issueClosed","dodPassed","checks":{...},"notes"}
// Exit codes: 0 = definitive summary printed (flags may still be false);
//             1 = bad invocation or unexpected internal error.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf('--' + name)
  if (i === -1) return ''
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : ''
}

const ID = opt('id')
const BRANCH = opt('branch')
const DEFAULT_BRANCH = opt('default-branch') || 'main'
const ISSUE_ARG = opt('issue')
const PLATFORM = opt('platform') || 'gh'
const TEST_CMD = opt('test-cmd')

if (!ID || !BRANCH) {
  console.error('usage: node deliver-ticket.mjs --id <ticket-id> --branch <branch> [--default-branch main] [--issue <n>] [--platform gh|glab] [--test-cmd "<command>"]')
  process.exit(1)
}
if (!/^[A-Za-z0-9._-]+$/.test(ID)) {
  console.error(`invalid --id (allowed: letters, digits, . _ -): ${ID}`)
  process.exit(1)
}
if (!/^[A-Za-z0-9/._-]+$/.test(BRANCH) || !/^[A-Za-z0-9/._-]+$/.test(DEFAULT_BRANCH)) {
  console.error('invalid --branch / --default-branch (allowed: letters, digits, / . _ -)')
  process.exit(1)
}
if (BRANCH === DEFAULT_BRANCH) {
  console.error(`--branch must differ from --default-branch (got ${BRANCH} for both) — nothing to deliver`)
  process.exit(1)
}
if (PLATFORM !== 'gh' && PLATFORM !== 'glab') {
  console.error(`unknown platform: ${PLATFORM} (expected gh or glab)`)
  process.exit(1)
}

const run = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: 'utf8', ...opts })
const git = (args, opts = {}) => run('git', args, opts)
const errText = (e) => String((e && (e.stderr || e.stdout || e.message)) || e).trim()
const firstLine = (s) => String(s).trim().split('\n')[0]
const lastLine = (s) => String(s).trim().split('\n').filter(Boolean).pop() || ''
const tryGit = (args) => {
  try { return { ok: true, out: git(args, { stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (e) { return { ok: false, out: errText(e) } }
}

// GH_BIN / GLAB_BIN env overrides (same mechanism as publish-tickets.mjs) for
// non-PATH binaries and test doubles, e.g. GH_BIN="node tools/fake-gh.mjs".
const cli = (args, opts = {}) => {
  const raw = PLATFORM === 'gh' ? process.env.GH_BIN || 'gh' : process.env.GLAB_BIN || 'glab'
  const parts = raw.split(' ')
  return run(parts[0], [...parts.slice(1), ...args], opts)
}

const checks = { planExists: false, alreadyMerged: false, merged: false, pushRequired: false, pushed: false, issueClosed: false, testsPassed: null }
const notes = []
const note = (line) => { notes.push(line); console.log('  (note) ' + line) }

const finish = (code) => {
  const dodPassed =
    checks.planExists &&
    checks.merged &&
    checks.issueClosed &&
    (!checks.pushRequired || checks.pushed) &&
    (TEST_CMD ? checks.testsPassed === true : true)
  const summary = { id: ID, branch: BRANCH, merged: checks.merged, issueClosed: checks.issueClosed, dodPassed, checks, notes: notes.join('; ') }
  console.log('DELIVER-SUMMARY-JSON: ' + JSON.stringify(summary))
  process.exit(code)
}

try {
  // 0. operate from the repo root regardless of cwd (plan path + command shape)
  process.chdir(git(['rev-parse', '--show-toplevel']).trim())

  // 1. clean tree — merging over uncommitted work is never sanctioned
  if (git(['status', '--porcelain']).trim()) {
    note('working tree not clean — refusing to merge')
    finish(0)
  }

  // 2. refs must exist
  for (const ref of [BRANCH, DEFAULT_BRANCH]) {
    if (!tryGit(['rev-parse', '--verify', '--quiet', ref]).ok) {
      note(`ref not found: ${ref}`)
      finish(0)
    }
  }

  // 3. merge --no-ff into the default branch (idempotent on re-runs)
  git(['checkout', DEFAULT_BRANCH], { stdio: ['ignore', 'pipe', 'pipe'] })
  if (tryGit(['merge-base', '--is-ancestor', BRANCH, 'HEAD']).ok) {
    checks.alreadyMerged = true
    checks.merged = true
    console.log(`= merged  ${BRANCH} is already contained in ${DEFAULT_BRANCH}`)
  } else {
    const m = tryGit(['merge', '--no-ff', '--no-edit', '-m', `merge: [${ID}] ${BRANCH} -> ${DEFAULT_BRANCH} (pipeline CLEAR)`, BRANCH])
    if (m.ok) {
      checks.merged = true
      console.log(`+ merged  ${BRANCH} -> ${DEFAULT_BRANCH} (--no-ff)`)
    } else {
      tryGit(['merge', '--abort'])
      note(`merge failed (aborted, tree left clean): ${firstLine(m.out)}`)
    }
  }

  // 4. push (only meaningful when an origin remote exists)
  checks.pushRequired = tryGit(['remote', 'get-url', 'origin']).ok
  if (checks.merged && checks.pushRequired) {
    const p = tryGit(['push', 'origin', DEFAULT_BRANCH])
    if (p.ok) {
      checks.pushed = true
      console.log(`+ pushed  ${DEFAULT_BRANCH} -> origin`)
    } else {
      note(`push failed: ${lastLine(p.out)}`)
    }
  }

  // 5. close the tracker issue and verify the transition (never assume auto-close).
  // ONLY after the work actually landed: a closed issue is what resume filtering
  // treats as "delivered by an earlier run", so closing on a failed merge/push
  // would silently drop the ticket from every future run.
  const landed = checks.merged && (!checks.pushRequired || checks.pushed)
  let issueNum = ISSUE_ARG ? Number(ISSUE_ARG) : null
  if (issueNum !== null && (!Number.isInteger(issueNum) || issueNum < 1)) {
    note(`invalid --issue value: ${ISSUE_ARG}`)
    issueNum = null
  }
  if (!landed) {
    note('skipping tracker close — merge/push did not complete, ticket is NOT delivered')
  } else {
    if (!issueNum) {
      // fall back to the "[<id>]" title-prefix convention (publish-tickets.mjs key)
      try {
        if (PLATFORM === 'gh') {
          const list = JSON.parse(cli(['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,title']))
          const hit = list.find((i) => String(i.title).startsWith(`[${ID}]`))
          if (hit) issueNum = hit.number
        } else {
          const text = cli(['issue', 'list', '--all'])
          const line = text.split('\n').find((l) => l.includes(`[${ID}]`))
          const m = line && line.match(/#(\d+)\b/)
          if (m) issueNum = Number(m[1])
        }
      } catch (e) {
        note(`issue lookup failed: ${firstLine(errText(e))}`)
      }
    }
    if (!issueNum) {
      note(`no tracker issue found for [${ID}]`)
    } else {
      try {
        cli(['issue', 'close', String(issueNum), ...(PLATFORM === 'gh' ? ['--comment', `Delivered: ${BRANCH} merged to ${DEFAULT_BRANCH} (run-milestone, CLEAR verdict).`] : [])])
      } catch (e) {
        note(`issue close command failed: ${firstLine(errText(e))}`) // verification below still decides
      }
      try {
        if (PLATFORM === 'gh') {
          const view = JSON.parse(cli(['issue', 'view', String(issueNum), '--json', 'state']))
          checks.issueClosed = String(view.state).toUpperCase() === 'CLOSED'
        } else {
          // text scrape (older glab has no JSON): only trust a "closed" in the header lines
          checks.issueClosed = cli(['issue', 'view', String(issueNum)]).split('\n').slice(0, 5).some((l) => /\bclosed\b/i.test(l))
        }
        console.log((checks.issueClosed ? '+ closed  ' : '  (note) NOT closed: ') + `issue #${issueNum}`)
        if (!checks.issueClosed) notes.push(`issue #${issueNum} still open after close attempt`)
      } catch (e) {
        note(`issue state verification failed: ${firstLine(errText(e))}`)
      }
    }
  }

  // 6. deterministic DoD inputs
  checks.planExists = existsSync(join('docs', 'plans', `${ID}.md`))
  if (!checks.planExists) note(`plan file missing: docs/plans/${ID}.md`)
  if (TEST_CMD) {
    const t = spawnSync(TEST_CMD, { shell: true, encoding: 'utf8' })
    checks.testsPassed = t.status === 0
    if (!checks.testsPassed) note(`--test-cmd failed (exit ${t.status}): ${String(t.stdout || t.stderr || '').trim().split('\n').slice(-3).join(' | ')}`)
  }

  finish(0)
} catch (e) {
  note(`unexpected error: ${firstLine(errText(e))}`)
  finish(1)
}
