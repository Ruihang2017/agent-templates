#!/usr/bin/env node
// deliver-ticket.mjs — the ONLY sanctioned delivery path for the three-agent
// pattern (catalog issues #26, #50). Delivery used to be a generic LLM agent
// prompted to merge + close + verify; harness safety classifiers repeatedly
// blocked that agent even after a journaled CLEAR, stranding CLEAR-verdict
// tickets. Delivery is deterministic instead: the merge policy stays mechanically
// checkable and the only permission surface is this one command (which is why the
// `gh pr` / `glab mr` calls below live HERE and not on the agent's Bash surface —
// settings.json deliberately does NOT allow `gh pr`, issue #30).
//
// Two delivery modes (#50 — the pattern produced 0 PRs / 0 remote branches before):
//   pr     : push the branch, open a PR/MR carrying the plan + Closes #<n>, post the
//            Reviewer's CLEAR verdict as a PR/MR COMMENT (the durable review trail),
//            then merge THROUGH the forge (`gh pr merge` / `glab mr merge` — respects
//            branch protection; a required-but-unmet check fails the merge, which
//            escalates rather than force-landing), fast-forward the local default to
//            the merged remote, close + verify the issue, run the DoD test-cmd.
//   direct : the legacy local `--no-ff` merge + push (for repos with no remote or no
//            forge CLI). Kept intact so no-forge repos still deliver.
//   auto   : pr when an origin remote AND an authenticated forge CLI both exist,
//            else direct. (default)
//
// --no-merge (pr mode only): push + open PR/MR + post the verdict comment, then STOP
// without merging — this is how supervised mode hands the human an open, evidenced PR.
//
// Usage:
//   node .claude/scripts/deliver-ticket.mjs --id <ticket-id> --branch <branch>
//        [--default-branch main] [--issue <n>] [--platform gh|glab]
//        [--delivery pr|direct|auto] [--no-merge] [--verdict-file <path>]
//        [--test-cmd "<command>"]
//
// Last line of stdout is machine-readable for run-milestone:
//   DELIVER-SUMMARY-JSON: {"id","branch","deliveryMode","merged","issueClosed",
//     "dodPassed","awaitingMerge","prUrl","checks":{...},"notes"}
// Exit codes: 0 = definitive summary printed (flags may still be false);
//             1 = bad invocation or unexpected internal error.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const has = (name) => argv.includes('--' + name)
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
const DELIVERY = opt('delivery') || 'auto'
const NO_MERGE = has('no-merge')
const VERDICT_FILE = opt('verdict-file')
const TEST_CMD = opt('test-cmd')

if (!ID || !BRANCH) {
  console.error('usage: node deliver-ticket.mjs --id <ticket-id> --branch <branch> [--default-branch main] [--issue <n>] [--platform gh|glab] [--delivery pr|direct|auto] [--no-merge] [--verdict-file <path>] [--test-cmd "<command>"]')
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
if (!['pr', 'direct', 'auto'].includes(DELIVERY)) {
  console.error(`unknown --delivery: ${DELIVERY} (expected pr, direct, or auto)`)
  process.exit(1)
}
if (VERDICT_FILE && !existsSync(VERDICT_FILE)) {
  console.error(`--verdict-file not found: ${VERDICT_FILE}`)
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
const tryCli = (args, opts = {}) => {
  try { return { ok: true, out: cli(args, opts) } } catch (e) { return { ok: false, out: errText(e) } }
}

const checks = {
  planExists: false, alreadyMerged: false, merged: false,
  pushRequired: false, pushed: false, branchPushed: false,
  prCreated: false, prExists: false, verdictPosted: false,
  issueClosed: false, testsPassed: null,
}
let prUrl = ''
let deliveryMode = 'direct'
let awaitingMerge = false
const notes = []
const note = (line) => { notes.push(line); console.log('  (note) ' + line) }

const finish = (code) => {
  const dodPassed = !awaitingMerge &&
    checks.planExists &&
    checks.merged &&
    checks.issueClosed &&
    (!checks.pushRequired || checks.pushed) &&
    (TEST_CMD ? checks.testsPassed === true : true)
  const summary = {
    id: ID, branch: BRANCH, deliveryMode,
    merged: checks.merged, issueClosed: checks.issueClosed, dodPassed,
    awaitingMerge, prUrl, checks, notes: notes.join('; '),
  }
  console.log('DELIVER-SUMMARY-JSON: ' + JSON.stringify(summary))
  process.exit(code)
}

// close the tracker issue and verify the transition — never assume auto-close.
// ONLY after the work actually landed: a closed issue is what resume filtering
// treats as "delivered by an earlier run", so closing on a failed merge would
// silently drop the ticket from every future run.
const closeIssue = () => {
  let issueNum = ISSUE_ARG ? Number(ISSUE_ARG) : null
  if (issueNum !== null && (!Number.isInteger(issueNum) || issueNum < 1)) {
    note(`invalid --issue value: ${ISSUE_ARG}`)
    issueNum = null
  }
  if (!issueNum) {
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
  if (!issueNum) { note(`no tracker issue found for [${ID}]`); return }
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
      checks.issueClosed = cli(['issue', 'view', String(issueNum)]).split('\n').slice(0, 5).some((l) => /\bclosed\b/i.test(l))
    }
    console.log((checks.issueClosed ? '+ closed  ' : '  (note) NOT closed: ') + `issue #${issueNum}`)
    if (!checks.issueClosed) notes.push(`issue #${issueNum} still open after close attempt`)
  } catch (e) {
    note(`issue state verification failed: ${firstLine(errText(e))}`)
  }
}

// find an existing PR/MR for the branch; returns { number, url } or null
const findPr = () => {
  try {
    if (PLATFORM === 'gh') {
      const arr = JSON.parse(cli(['pr', 'list', '--head', BRANCH, '--state', 'all', '--json', 'number,url']))
      return arr && arr[0] ? { number: arr[0].number, url: arr[0].url } : null
    }
    const text = cli(['mr', 'list', '--source-branch', BRANCH])
    const m = text.match(/!(\d+)/)
    return m ? { number: Number(m[1]), url: '' } : null
  } catch (e) {
    note(`PR/MR lookup failed: ${firstLine(errText(e))}`)
    return null
  }
}

try {
  // 0. operate from the repo root regardless of cwd
  process.chdir(git(['rev-parse', '--show-toplevel']).trim())

  // 1. clean tree — merging over uncommitted work is never sanctioned. `.claude/tmp/`
  // is ignored: run-milestone stages the Reviewer's verdict there for --verdict-file,
  // and that ephemeral scratch must not read as "dirty" and block delivery.
  const dirty = git(['status', '--porcelain']).split('\n').filter((l) => l.trim() && !/\.claude\/tmp\//.test(l))
  if (dirty.length) { note('working tree not clean — refusing to merge'); finish(0) }

  // 2. refs must exist locally
  for (const ref of [BRANCH, DEFAULT_BRANCH]) {
    if (!tryGit(['rev-parse', '--verify', '--quiet', ref]).ok) { note(`ref not found: ${ref}`); finish(0) }
  }

  // 3. resolve delivery mode
  checks.pushRequired = tryGit(['remote', 'get-url', 'origin']).ok
  const cliAuthed = tryCli(['auth', 'status'], { stdio: ['ignore', 'ignore', 'ignore'] }).ok
  if (DELIVERY === 'direct') deliveryMode = 'direct'
  else if (DELIVERY === 'pr') {
    if (!checks.pushRequired || !cliAuthed) { note(`--delivery pr requires an origin remote and an authenticated ${PLATFORM}; falling back is not allowed under an explicit flag`); finish(0) }
    deliveryMode = 'pr'
  } else deliveryMode = (checks.pushRequired && cliAuthed) ? 'pr' : 'direct'
  console.log(`delivery mode: ${deliveryMode}`)

  // supervised (--no-merge) with no forge: there is no PR to open — leave the local
  // branch for the human to merge, exactly as pre-PR-mode supervised delivery did.
  if (NO_MERGE && deliveryMode === 'direct') {
    awaitingMerge = true
    note('supervised (--no-merge) with no forge: leaving the local branch for the human to merge')
    finish(0)
  }

  if (deliveryMode === 'direct') {
    // ---- direct (legacy, no-forge) path ----
    git(['checkout', DEFAULT_BRANCH], { stdio: ['ignore', 'pipe', 'pipe'] })
    if (tryGit(['merge-base', '--is-ancestor', BRANCH, 'HEAD']).ok) {
      checks.alreadyMerged = true; checks.merged = true
      console.log(`= merged  ${BRANCH} is already contained in ${DEFAULT_BRANCH}`)
    } else {
      const m = tryGit(['merge', '--no-ff', '--no-edit', '-m', `merge: [${ID}] ${BRANCH} -> ${DEFAULT_BRANCH} (pipeline CLEAR)`, BRANCH])
      if (m.ok) { checks.merged = true; console.log(`+ merged  ${BRANCH} -> ${DEFAULT_BRANCH} (--no-ff)`) }
      else { tryGit(['merge', '--abort']); note(`merge failed (aborted, tree left clean): ${firstLine(m.out)}`) }
    }
    if (checks.merged && checks.pushRequired) {
      const p = tryGit(['push', 'origin', DEFAULT_BRANCH])
      if (p.ok) { checks.pushed = true; console.log(`+ pushed  ${DEFAULT_BRANCH} -> origin`) }
      else note(`push failed: ${lastLine(p.out)}`)
    }
  } else {
    // ---- pr path ----
    // 3a. push the ticket branch so the forge has it (AC2: branch exists on remote)
    const pb = tryGit(['push', '-u', 'origin', BRANCH])
    if (pb.ok) { checks.branchPushed = true; console.log(`+ pushed  ${BRANCH} -> origin`) }
    else { note(`branch push failed: ${lastLine(pb.out)} — cannot open a PR without it`); finish(0) }

    // 3b. find or create the PR/MR
    let pr = findPr()
    if (pr) { checks.prExists = true; prUrl = pr.url; console.log(`= pr      exists for ${BRANCH} (#${pr.number})`) }
    else {
      const subject = (tryGit(['log', '-1', '--format=%s', BRANCH]).out || BRANCH).trim().slice(0, 100)
      const title = `[${ID}] ${subject}`.slice(0, 120)
      const closes = ISSUE_ARG && Number(ISSUE_ARG) > 0 ? `Closes #${Number(ISSUE_ARG)}` : `(ticket ${ID} — issue looked up by \`[${ID}]\` title prefix)`
      const body =
        `## Summary\nDelivered by the three-agent pipeline for ticket [${ID}].\n\n` +
        `## Related issue / ticket\n${closes} — ticket \`${ID}\`\n\n` +
        `## Pipeline evidence\n` +
        `- Plan: \`docs/plans/${ID}.md\`\n` +
        `- Builder branch: \`${BRANCH}\` -> \`${DEFAULT_BRANCH}\`\n` +
        `- Reviewer verdict: **CLEAR** (full text posted as a comment below)\n` +
        `- Delivered deterministically by \`run-milestone\` / \`deliver-ticket.mjs\`\n`
      const tmp = mkdtempSync(join(tmpdir(), 'deliver-'))
      const bodyFile = join(tmp, 'body.md')
      writeFileSync(bodyFile, body)
      try {
        let out
        if (PLATFORM === 'gh') out = cli(['pr', 'create', '--base', DEFAULT_BRANCH, '--head', BRANCH, '--title', title, '--body-file', bodyFile])
        else out = cli(['mr', 'create', '--source-branch', BRANCH, '--target-branch', DEFAULT_BRANCH, '--title', title, '--description', body, '--yes'])
        prUrl = lastLine(out)
        const m = prUrl.match(/[#!/](\d+)\s*$/)
        pr = { number: m ? Number(m[1]) : null, url: prUrl }
        checks.prCreated = true; checks.prExists = true
        console.log(`+ pr      created: ${prUrl}`)
      } catch (e) {
        note(`PR/MR create failed: ${firstLine(errText(e))}`); finish(0)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }

    // 3c. post the Reviewer's CLEAR verdict as a comment (AC1 — the durable review trail).
    // Only on a freshly-created PR, so re-runs never duplicate the comment.
    if (checks.prCreated && VERDICT_FILE && pr && pr.number) {
      const vr = PLATFORM === 'gh'
        ? tryCli(['pr', 'comment', String(pr.number), '--body-file', VERDICT_FILE])
        : tryCli(['mr', 'note', String(pr.number), '--message', readFileSync(VERDICT_FILE, 'utf8')])
      if (vr.ok) { checks.verdictPosted = true; console.log(`+ comment CLEAR verdict posted to #${pr.number}`) }
      else note(`verdict comment failed: ${firstLine(vr.out)}`)
    } else if (checks.prCreated && !VERDICT_FILE) {
      note('no --verdict-file supplied — PR opened without the verdict comment')
    }

    // 3d. supervised: stop here with an open, evidenced PR for the human to merge
    if (NO_MERGE) {
      awaitingMerge = true
      console.log(`= awaiting human merge: ${prUrl || '(PR open)'}`)
      finish(0)
    }

    // 3e. merge THROUGH the forge, then fast-forward the local default to it.
    tryGit(['fetch', 'origin', DEFAULT_BRANCH])
    if (tryGit(['merge-base', '--is-ancestor', BRANCH, `origin/${DEFAULT_BRANCH}`]).ok) {
      checks.alreadyMerged = true
      console.log(`= merged  ${BRANCH} already on origin/${DEFAULT_BRANCH}`)
    } else if (pr && pr.number) {
      const mg = PLATFORM === 'gh'
        ? tryCli(['pr', 'merge', String(pr.number), '--merge'])
        : tryCli(['mr', 'merge', String(pr.number), '--yes'])
      if (!mg.ok) note(`forge merge failed (required checks pending, conflict, or approval required): ${firstLine(mg.out)}`)
      else console.log(`+ merged  #${pr.number} via ${PLATFORM} (forge-side)`)
      tryGit(['fetch', 'origin', DEFAULT_BRANCH])
    }
    // confirm the merge actually landed on the remote default, then sync local
    if (tryGit(['merge-base', '--is-ancestor', BRANCH, `origin/${DEFAULT_BRANCH}`]).ok) {
      checks.merged = true
      checks.pushed = true // the forge landed it on origin
      git(['checkout', DEFAULT_BRANCH], { stdio: ['ignore', 'pipe', 'pipe'] })
      const ff = tryGit(['merge', '--ff-only', `origin/${DEFAULT_BRANCH}`])
      if (!ff.ok) note(`local fast-forward to origin/${DEFAULT_BRANCH} failed: ${firstLine(ff.out)} (DoD test-cmd runs against local ${DEFAULT_BRANCH})`)
    } else if (!checks.alreadyMerged) {
      note('merge did not land on the remote default branch — ticket is NOT delivered')
    }
    if (checks.alreadyMerged) checks.merged = true
  }

  // 4. close the tracker issue only once the work landed
  const landed = checks.merged && (!checks.pushRequired || checks.pushed)
  if (!landed) note('skipping tracker close — merge/push did not complete, ticket is NOT delivered')
  else closeIssue()

  // 5. deterministic DoD inputs
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
