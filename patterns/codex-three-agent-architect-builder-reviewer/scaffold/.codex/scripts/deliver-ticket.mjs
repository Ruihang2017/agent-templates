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
// Delivery modes (#50, #56 — the pattern produced 0 PRs / 0 remote branches before #50):
//   pr     : push the branch, open a PR/MR carrying the plan + Closes #<n>, post the
//            Reviewer's CLEAR verdict as a PR/MR COMMENT (the durable review trail),
//            then merge THROUGH the forge (`gh pr merge` / `glab mr merge` — respects
//            branch protection; a required-but-unmet check fails the merge, which
//            escalates rather than force-landing), fast-forward the local default to
//            the merged remote, close + verify the issue, run the DoD test-cmd.
//   direct : the legacy local `--no-ff` merge + push (for repos with no remote or no
//            forge CLI). Kept intact so no-forge repos still deliver.
//   pushmr : GitLab only, for orgs whose token has the Issues API but a 403 MR API AND a
//            protected default branch (catalog issue #56) — where neither pr (needs MR API)
//            nor direct (needs to push protected main) works. Opens the MR over SSH via
//            `git push -o merge_request.*` (no MR API); the single-line description carries
//            Closes #N (git forbids newlines in push options), and the CLEAR verdict is
//            posted as an ISSUE comment via the working Issues API. Stops for a human web
//            merge; a resume run detects the landed merge and closes/verifies via Issues API.
//   auto   : pr when the MR/PR API is usable; else on glab, pushmr when the MR API is
//            403/denied; else direct. (default)
//
// --no-merge (pr mode): push + open PR/MR + post the verdict comment, then STOP without
// merging — how supervised mode hands the human an open, evidenced PR. (pushmr always
// stops for a human web merge, so --no-merge is implicit there.)
//
// Usage:
//   node .codex/scripts/deliver-ticket.mjs --id <ticket-id> --branch <branch>
//        [--default-branch main] [--issue <n>] [--platform gh|glab]
//        [--delivery pr|direct|pushmr|auto] [--no-merge] [--verdict-file <path>]
//        [--body-file <path>] [--test-cmd "<command>"]
//
// PR/MR body (issue #58): a pre-composed --body-file (the deliver agent fills the repo's
// .gitlab/merge_request_templates or .github/pull_request_template sections from the ticket,
// diff, verdict, and AGENTS.md constraints) is used verbatim; else the repo template is the
// skeleton (Closes #N ensured); else a hardcoded fallback. The script only assembles/selects.
//
// Asana mirror (catalog issue #126, optional): when `.codex/asana.json` exists, the
// ticket's Asana subtask is completed right after the tracker issue closes — same
// precondition, because a completed subtask on an unlanded merge would misreport
// delivery exactly the way a closed issue would. It is a MIRROR, so it is strictly
// fail-soft: the result lands in `asana` in the summary and in `notes`, and it is
// deliberately absent from the `dodPassed` expression. An expired Asana token must
// never fail a ticket that actually shipped. With no config the step makes no process
// call at all — no latency, no notes.
//
// Last line of stdout is machine-readable for run-milestone:
//   DELIVER-SUMMARY-JSON: {"id","branch","deliveryMode","merged","issueClosed",
//     "dodPassed","awaitingMerge","prUrl","checks":{...},"asana":{...}|null,"notes"}
// Exit codes: 0 = definitive summary printed (flags may still be false);
//             1 = bad invocation or unexpected internal error.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
// Integration-branch fallback (issue #139). OFF unless passed — never a silent default.
// When the DEFAULT branch refuses the merge because it is PROTECTED (not because a check
// failed), retarget onto this branch so an autonomous run keeps moving instead of turning
// every ticket into the same escalation. See classifyMergeFailure below for the
// distinction that makes this safe rather than a protection bypass.
const INTEGRATION_BRANCH = opt('integration-branch') || ''
const ISSUE_ARG = opt('issue')
const PLATFORM = opt('platform') || 'gh'
const DELIVERY = opt('delivery') || 'auto'
const NO_MERGE = has('no-merge')
const VERDICT_FILE = opt('verdict-file')
const BODY_FILE = opt('body-file') // pre-composed PR/MR body (agent-filled from the repo template)
const TEST_CMD = opt('test-cmd')

// Run-end handoff (issue #139): open ONE integration -> default MR/PR and stop. Never
// merges it — landing the accumulated work on a protected branch is a human decision by
// definition. Ticket-less, so it runs before the --id/--branch requirements.
const OPEN_INTEGRATION_MR = has('open-integration-mr')

if (!OPEN_INTEGRATION_MR && (!ID || !BRANCH)) {
  console.error('usage: node deliver-ticket.mjs --id <ticket-id> --branch <branch> [--default-branch main] [--integration-branch ai-staging] [--issue <n>] [--platform gh|glab] [--delivery pr|direct|auto] [--no-merge] [--verdict-file <path>] [--test-cmd "<command>"]\n   or: node deliver-ticket.mjs --open-integration-mr --integration-branch <name> [--default-branch main] [--platform gh|glab]')
  process.exit(1)
}
if (OPEN_INTEGRATION_MR && !INTEGRATION_BRANCH) {
  console.error('--open-integration-mr requires --integration-branch <name>')
  process.exit(1)
}
if (!OPEN_INTEGRATION_MR && !/^[A-Za-z0-9._-]+$/.test(ID)) {
  console.error(`invalid --id (allowed: letters, digits, . _ -): ${ID}`)
  process.exit(1)
}
if (!OPEN_INTEGRATION_MR && (!/^[A-Za-z0-9/._-]+$/.test(BRANCH) || !/^[A-Za-z0-9/._-]+$/.test(DEFAULT_BRANCH))) {
  console.error('invalid --branch / --default-branch (allowed: letters, digits, / . _ -)')
  process.exit(1)
}
if (!OPEN_INTEGRATION_MR && BRANCH === DEFAULT_BRANCH) {
  console.error(`--branch must differ from --default-branch (got ${BRANCH} for both) — nothing to deliver`)
  process.exit(1)
}
if (PLATFORM !== 'gh' && PLATFORM !== 'glab') {
  console.error(`unknown platform: ${PLATFORM} (expected gh or glab)`)
  process.exit(1)
}
if (!['pr', 'direct', 'pushmr', 'local', 'auto'].includes(DELIVERY)) {
  console.error(`unknown --delivery: ${DELIVERY} (expected pr, direct, pushmr, local, or auto)`)
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

// Run-end handoff: open ONE integration -> default MR and STOP (issue #139). Runs before
// any ticket logic and exits; it never merges, because landing accumulated work on a
// protected branch is exactly the human decision the protection exists to require.
if (OPEN_INTEGRATION_MR) {
  const fail = (msg) => {
    console.error(`x ${msg}`)
    console.log('INTEGRATION-MR-JSON: ' + JSON.stringify({ integrationBranch: INTEGRATION_BRANCH, defaultBranch: DEFAULT_BRANCH, opened: false, error: msg }))
    process.exit(0) // a missing handoff must not fail the run that produced the work
  }
  try { cli(['auth', 'status'], { stdio: ['ignore', 'ignore', 'ignore'] }) } catch { fail(`${PLATFORM} not authenticated`) }
  if (!tryGit(['fetch', 'origin', INTEGRATION_BRANCH]).ok) fail(`${INTEGRATION_BRANCH} does not exist on origin — nothing was delivered to it`)
  tryGit(['fetch', 'origin', DEFAULT_BRANCH])
  // Nothing to hand off if the integration branch adds no commits.
  const aheadOut = tryGit(['rev-list', '--count', `origin/${DEFAULT_BRANCH}..origin/${INTEGRATION_BRANCH}`])
  const ahead = aheadOut.ok ? Number(String(aheadOut.out).trim()) || 0 : 0
  if (ahead === 0) {
    console.log(`= nothing to hand off: ${INTEGRATION_BRANCH} is not ahead of ${DEFAULT_BRANCH}`)
    console.log('INTEGRATION-MR-JSON: ' + JSON.stringify({ integrationBranch: INTEGRATION_BRANCH, defaultBranch: DEFAULT_BRANCH, ahead: 0, opened: false }))
    process.exit(0)
  }
  // Reuse an existing open handoff MR rather than opening a second one each run.
  let existing = null
  try {
    if (PLATFORM === 'gh') {
      const arr = JSON.parse(cli(['pr', 'list', '--head', INTEGRATION_BRANCH, '--state', 'open', '--json', 'number,url']))
      existing = arr && arr[0] ? arr[0].url : null
    } else {
      const m = cli(['mr', 'list', '--source-branch', INTEGRATION_BRANCH]).match(/!(\d+)/)
      existing = m ? `!${m[1]}` : null
    }
  } catch {}
  if (existing) {
    console.log(`= handoff MR already open: ${existing} (${ahead} commit(s) ahead)`)
    console.log('INTEGRATION-MR-JSON: ' + JSON.stringify({ integrationBranch: INTEGRATION_BRANCH, defaultBranch: DEFAULT_BRANCH, ahead, opened: false, url: existing, alreadyOpen: true }))
    process.exit(0)
  }
  const subjects = (tryGit(['log', '--format=%s', `origin/${DEFAULT_BRANCH}..origin/${INTEGRATION_BRANCH}`]).out || '')
    .split('\n').map((l) => l.trim()).filter(Boolean)
  const ids = [...new Set(subjects.map((l) => (l.match(/\[([A-Za-z0-9._-]+)\]/) || [])[1]).filter(Boolean))]
  const title = `Land AI-delivered work: ${INTEGRATION_BRANCH} -> ${DEFAULT_BRANCH} (${ahead} commit(s))`
  const body =
    `> 🤖 **Automated delivery — this branch was written and merged by AI.**\n` +
    `> The pipeline could not merge to \`${DEFAULT_BRANCH}\` (branch protection), so it delivered to \`${INTEGRATION_BRANCH}\` instead.\n` +
    `> It runs under the account whose Personal Access Token authenticated the forge CLI, so **the author shown is that token's owner, not the code's author.**\n\n` +
    `## Summary\n\n${ahead} commit(s) on \`${INTEGRATION_BRANCH}\` are not on \`${DEFAULT_BRANCH}\`.\n\n` +
    (ids.length ? `## Tickets\n\n${ids.map((i) => `- \`${i}\``).join('\n')}\n\n` : '') +
    `## Status\n\nEach ticket passed an independent AI review (CLEAR) before landing here. ` +
    `**None of them meets the Definition of Done yet** — the DoD requires the default branch, and this MR is what would satisfy it.\n\n` +
    `**This MR is deliberately not merged by the pipeline.** Landing accumulated work on a protected branch is a human decision.\n`
  const tmp = mkdtempSync(join(tmpdir(), 'deliver-int-'))
  const bodyFile = join(tmp, 'body.md')
  writeFileSync(bodyFile, body)
  try {
    const out = PLATFORM === 'gh'
      ? cli(['pr', 'create', '--base', DEFAULT_BRANCH, '--head', INTEGRATION_BRANCH, '--title', title, '--body-file', bodyFile])
      : cli(['mr', 'create', '--source-branch', INTEGRATION_BRANCH, '--target-branch', DEFAULT_BRANCH, '--title', title, '--description', body, '--yes'])
    const url = lastLine(out)
    console.log(`+ handoff MR opened (NOT merged): ${url}`)
    console.log(`  ${ahead} commit(s), ${ids.length} ticket(s) — a human lands this on ${DEFAULT_BRANCH}`)
    console.log('INTEGRATION-MR-JSON: ' + JSON.stringify({ integrationBranch: INTEGRATION_BRANCH, defaultBranch: DEFAULT_BRANCH, ahead, tickets: ids, opened: true, url }))
    process.exit(0)
  } catch (e) {
    fail(`could not open the handoff MR: ${firstLine(errText(e))}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const checks = {
  planExists: false, alreadyMerged: false, merged: false,
  pushRequired: false, pushed: false, branchPushed: false,
  prCreated: false, prExists: false, verdictPosted: false,
  issueClosed: false, ledgerWritten: false, testsPassed: null,
  // Integration-branch delivery (issue #139). Deliberately SEPARATE from `merged`, which
  // measures ancestry into the DEFAULT branch — so dodPassed reads false, honestly, until
  // the integration branch lands on the default one.
  mergedToIntegration: false,
}
// Which branch the work actually landed on: the default branch, or the integration branch.
let deliveredTo = DEFAULT_BRANCH
let prUrl = ''
let deliveryMode = 'direct'
let awaitingMerge = false
// Asana mirror outcome, or null when the repo is not connected. Reported, never gating.
let asana = null
const notes = []
const note = (line) => { notes.push(line); console.log('  (note) ' + line) }

const finish = (code) => {
  // DO NOT add an Asana term here. Asana is a reporting mirror (issue #126); making the
  // Definition of Done depend on it would let a token expiry fail a delivered ticket.
  // The E2E integrity suite asserts this expression stays Asana-free.
  // In `local` mode there is no tracker, so `issueClosed` can never become true and would
  // make dodPassed permanently false — the ticket would deliver and still read as failed,
  // which is the exact false-negative class issue #152 removed. The Definition of Done
  // drops the tracker term ONLY in that mode, and gains the ledger write in its place, so
  // the run still has a durable, checkable record of what landed (issue #180).
  const dodPassed = !awaitingMerge &&
    checks.planExists &&
    checks.merged &&
    (deliveryMode === 'local' ? checks.ledgerWritten : checks.issueClosed) &&
    (!checks.pushRequired || checks.pushed) &&
    (TEST_CMD ? checks.testsPassed === true : true)
  // Branch cleanup deliberately does NOT happen here (issue #151). Deleting the ticket
  // branch on delivery breaks the pattern's idempotent re-run: a second invocation — a
  // resume, or a pass to close the tracker — would find no ref and report "not delivered"
  // for work that shipped, which is the same false-negative class the squash fix removes.
  // Cleanup belongs to the run that OWNS the branches, so it lives in start-all's post-run
  // step; the revert guard above is what makes a leftover branch harmless in the meantime.
  const summary = {
    id: ID, branch: BRANCH, deliveryMode,
    merged: checks.merged, issueClosed: checks.issueClosed, dodPassed,
    // `delivered-to-integration` is a DISTINCT outcome, never folded into `delivered`.
    // A run that reports 20/20 delivered while the default branch has nothing is the
    // failure class this catalog keeps recording (#109, #115, #119, #127, #132).
    outcome: checks.merged ? 'delivered' : (checks.mergedToIntegration ? 'delivered-to-integration' : 'not-delivered'),
    deliveredTo, integrationBranch: INTEGRATION_BRANCH || null,
    awaitingMerge, prUrl, checks, asana, notes: notes.join('; '),
  }
  console.log('DELIVER-SUMMARY-JSON: ' + JSON.stringify(summary))
  process.exit(code)
}

// Complete the ticket's Asana subtask (issue #126). No-op with no config — and it is a
// true no-op: no child process, so a repo that never connected Asana pays nothing and
// sees no notes. Everything here is advisory; nothing can change the DoD.
const ASANA_CONFIG = join('.codex', 'asana.json')
const ASANA_SCRIPT = join('.codex', 'scripts', 'asana-sync.mjs')
const completeAsana = () => {
  if (!existsSync(ASANA_CONFIG)) return
  if (!existsSync(ASANA_SCRIPT)) {
    asana = { ok: false, errors: [{ code: 'script-missing', message: `${ASANA_SCRIPT} not found — re-run adopt to reinstall the Asana integration` }] }
    note(`Asana configured but ${ASANA_SCRIPT} is missing — subtask NOT completed`)
    return
  }
  const r = spawnSync(process.execPath, [ASANA_SCRIPT, 'complete', ID, '--create'], { encoding: 'utf8' })
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('ASANA-SYNC-JSON: '))
  try {
    asana = line ? JSON.parse(line.slice('ASANA-SYNC-JSON: '.length)) : null
  } catch { asana = null }
  if (!asana) {
    // The child is contractually supposed to exit 0 with a summary; if it did not, say so
    // rather than reporting silence as success.
    asana = { ok: false, errors: [{ code: 'no-summary', message: `asana-sync produced no summary line (exit ${r.status})` }] }
  }
  if (asana.ok) {
    const it = (asana.items || [])[0]
    console.log(`+ asana   subtask ${it && it.alreadyCompleted ? 'already complete' : 'completed'} for ${ID}`)
  } else {
    // Surfaced in notes so run-milestone's escalation path carries it. Fail-soft means
    // do not block; it never means do not mention (issue #124).
    for (const e of asana.errors || []) note(`Asana mirror: ${e.code} — ${e.message}`)
  }
}

// close the tracker issue and verify the transition — never assume auto-close.
// ONLY after the work actually landed: a closed issue is what resume filtering
// treats as "delivered by an earlier run", so closing on a failed merge would
// silently drop the ticket from every future run.
// ---------------------------------------------------------------------------
// Local delivery ledger (catalog issue #180).
//
// With no tracker there is no "issue closed" to resume from, and that signal is what makes
// a re-run after a pause, a crash, or a new PRD phase execute only the NEW work. Something
// has to carry it, and it has to survive a process exit.
//
// A COMMITTED file, not a gitignored one, and that is the whole design: it is the record
// of what this repo has delivered, so it belongs in history alongside the code it
// describes. It is also what a later human or agent reads to know what still needs
// pushing. A scratch file under .codex/tmp/ would be lost on the first clean checkout —
// exactly when someone needs to know what happened.
// ---------------------------------------------------------------------------

// RUNTIME-NEUTRAL on purpose (catalog issue #181). One project may run the Claude and the
// Codex three-agent patterns side by side — different team members, different tool
// budgets — and they share `docs/prd/`, the ticket ids, the branch names and the tracker.
// A ledger under `.codex/` or `.codex/` would give each runtime its OWN record of what
// shipped, so the other would re-plan and re-build delivered tickets: catalog issue #136's
// harm, reintroduced through the runtime split.
//
// It lives beside `docs/prd/` rather than inside it, because prd-phase.mjs freezes that
// tree as append-only and a ledger that changes on every delivery would fight the freeze.
const LEDGER = join('docs', 'delivered.json')

const readLedger = () => {
  if (!existsSync(LEDGER)) return { delivered: [] }
  try {
    const j = JSON.parse(readFileSync(LEDGER, 'utf8'))
    return Array.isArray(j.delivered) ? j : { delivered: [] }
  } catch {
    // A corrupt ledger must not be silently replaced: that would erase the record of every
    // previously delivered ticket and let the next run redo all of it.
    note(`${LEDGER} is present but unparseable — refusing to overwrite it; fix or remove it by hand`)
    return null
  }
}

const writeLedger = () => {
  const led = readLedger()
  if (!led) return false
  const sha = (tryGit(['rev-parse', 'HEAD']).out || '').trim()
  const existing = led.delivered.findIndex((d) => d && d.id === ID)
  const row = { id: ID, branch: BRANCH, sha, at: new Date().toISOString() }
  if (existing === -1) led.delivered.push(row)
  else led.delivered[existing] = row // a re-delivery updates in place; never duplicates
  try {
    // A repo may reach `local` delivery without a `.codex/` directory — the mode is
    // deliberately usable in a plain checkout, not only in an adopted one.
    mkdirSync(dirname(LEDGER), { recursive: true })
    writeFileSync(LEDGER, JSON.stringify(led, null, 2) + '\n')
  } catch (e) {
    note(`could not write ${LEDGER}: ${firstLine(errText(e))}`)
    return false
  }
  // Committed on the default branch, so the ledger and the work it describes move together.
  // If this fails the ledger is still on disk but uncommitted, which the next run's
  // clean-tree check would trip over — so say so rather than leaving it dangling.
  const add = tryGit(['add', LEDGER])
  if (!add.ok) { note(`could not stage ${LEDGER}: ${firstLine(add.out)}`); return false }
  const commit = tryGit(['commit', '-m', `chore(deliver): record ${ID} as delivered locally`, '--', LEDGER])
  if (!commit.ok && !/nothing to commit/i.test(commit.out)) {
    note(`could not commit ${LEDGER}: ${firstLine(commit.out)}`)
    return false
  }
  console.log(`+ ledger  recorded ${ID} in ${LEDGER}`)
  return true
}

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
    const closeNote = checks.mergedToIntegration
      ? `Delivered: ${BRANCH} merged to ${deliveredTo} — NOT to ${DEFAULT_BRANCH}, which refused the merge (branch protection). The Definition of Done is not met until ${deliveredTo} lands on ${DEFAULT_BRANCH}. Closed so re-runs do not rebuild this ticket.`
      : `Delivered: ${BRANCH} merged to ${DEFAULT_BRANCH} (run-milestone, CLEAR verdict).`
    cli(['issue', 'close', String(issueNum), ...(PLATFORM === 'gh' ? ['--comment', closeNote] : [])])
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

// the PR/MR title and structured body — shared by the pr (API) and pushmr paths.
// withVerdict inlines the CLEAR verdict into the body; the pr path posts it as a
// comment instead, but pushmr has no MR-comment API (issue #56) so it goes in the body.
const prTitle = () => {
  const subject = (tryGit(['log', '-1', '--format=%s', BRANCH]).out || BRANCH).trim().slice(0, 100)
  return `[${ID}] ${subject}`.slice(0, 120)
}
const buildBody = () => {
  const closes = ISSUE_ARG && Number(ISSUE_ARG) > 0 ? `Closes #${Number(ISSUE_ARG)}` : `(ticket ${ID} — issue looked up by \`[${ID}]\` title prefix)`
  return `## Summary\nDelivered by the three-agent pipeline for ticket [${ID}].\n\n` +
    `## Related issue / ticket\n${closes} — ticket \`${ID}\`\n\n` +
    `## Pipeline evidence\n` +
    `- Plan: \`docs/plans/${ID}.md\`\n` +
    `- Builder branch: \`${BRANCH}\` -> \`${DEFAULT_BRANCH}\`\n` +
    `- Reviewer verdict: **CLEAR** (full text posted as a comment below)\n` +
    `- Delivered deterministically by \`run-milestone\` / \`deliver-ticket.mjs\`\n`
}

// the repo's own MR/PR template file, used as the body skeleton (issue #58) instead of a
// hardcoded body — so an adopted repo's 8-section template actually applies to pipeline MRs.
const findMrTemplate = () => {
  const candidates = PLATFORM === 'glab'
    ? ['.gitlab/merge_request_templates/default.md', '.gitlab/merge_request_templates/Default.md']
    : ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md']
  for (const c of candidates) { if (existsSync(c)) return { path: c, text: readFileSync(c, 'utf8') } }
  if (PLATFORM === 'glab') {
    try {
      const dir = '.gitlab/merge_request_templates'
      const f = readdirSync(dir).find((n) => n.toLowerCase().endsWith('.md'))
      if (f) return { path: `${dir}/${f}`, text: readFileSync(`${dir}/${f}`, 'utf8') }
    } catch {}
  }
  return null
}
// ensure `Closes #N` is in a template body (so the issue auto-closes on merge) — under a
// "Related" section if the template has one, else appended.
const ensureCloses = (text) => {
  const n = ISSUE_ARG && Number(ISSUE_ARG) > 0 ? Number(ISSUE_ARG) : null
  if (!n || new RegExp(`Closes\\s+#${n}\\b`).test(text)) return text
  const m = text.match(/(^|\n)#+[ \t]*Related[^\n]*\n/i)
  if (m) { const at = m.index + m[0].length; return text.slice(0, at) + `Closes #${n}\n` + text.slice(at) }
  return `${text.trimEnd()}\n\nCloses #${n}\n`
}
// PR/MR body: a pre-composed --body-file (the deliver agent fills the repo template's
// semantic sections — Type/Changes/Constraint-check/Evidence — issue #58) wins; else the
// repo's own template as a skeleton (with Closes #N ensured); else the hardcoded fallback.
// deliver-ticket stays deterministic: it only selects/assembles, never judges the diff.
// AI attribution, prepended UNCONDITIONALLY to every body path (issue #137).
//
// The pipeline authenticates as whoever owns the PAT that `glab`/`gh` is logged in with,
// so the forge shows a HUMAN as author and merger. That is the intended model — the AI
// acts as the user — but it means nothing on the MR reveals the change is machine-made
// unless the body says so. It previously did not: the `--body-file` path (the normal
// autonomous route, #58) carried no marker at all, and the repo-template path carried only
// an HTML comment, which GitLab does not render. Both are the paths adopted repos take.
//
// Rendered-visible and content-bearing on purpose: a reviewer must be able to tell what
// produced this and why the author field looks human, without reading page source.
const aiMarker = () =>
  `> 🤖 **Automated delivery — this change was written and merged by AI.**\n` +
  `> Produced by the three-agent Architect → Builder → Reviewer pipeline for ticket \`${ID}\`, ` +
  `cleared by an independent reviewer in a fresh context, and merged by \`deliver-ticket.mjs\` (no human wrote or merged it).\n` +
  `> It runs under the account whose Personal Access Token authenticated the forge CLI, so **the author and merger shown above are that token's owner, not the code's author.**\n` +
  `> Plan: \`docs/plans/${ID}.md\` · Reviewer verdict: **CLEAR**, posted as a comment below.\n\n`

const resolvePrBody = () => {
  if (BODY_FILE && existsSync(BODY_FILE)) return aiMarker() + readFileSync(BODY_FILE, 'utf8')
  const tpl = findMrTemplate()
  if (tpl) {
    note(`MR/PR body from repo template ${tpl.path}`)
    return aiMarker() + ensureCloses(tpl.text)
  }
  return aiMarker() + buildBody()
}

// ---------------------------------------------------------------------------
// Integration-branch fallback (issue #139)
// ---------------------------------------------------------------------------

// THE distinction this whole feature rests on: "cannot merge here" is not "must not merge".
//
//   protection — 403, protected branch, no merge/push rights. The change is fine; this
//                branch is closed to us. Rerouting to another branch is legitimate.
//   gate       — failing pipeline, missing approvals, GitLab 405 because the pipeline has
//                not finished (#135). The change is NOT cleared to land ANYWHERE.
//                Rerouting would launder a broken change into a branch that later gets
//                merged wholesale, and would be a backdoor around the rule §4 sets from
//                issue #50: a required-but-unmet check escalates rather than force-lands.
//
// Anything unrecognised is treated as a gate — fail closed. Guessing "probably protection"
// is the one mistake that turns this feature into a protection bypass.
const classifyMergeFailure = (out) => {
  const s = String(out || '').toLowerCase()
  const gate = /pipeline|status check|checks have not|approval|approver|unresolved|conflict|not mergeable|draft|405/
  if (gate.test(s)) return 'gate'
  const protection = /protected|not allowed to (merge|push)|403|forbidden|insufficient|permission|maintainer|developers cannot/
  if (protection.test(s)) return 'protection'
  return 'gate'
}

// ---------------------------------------------------------------------------
// GitLab merge gate (catalog issues #135, #152). Three defects, one root cause each,
// which together meant NO ticket could deliver unattended on a pipeline-gated,
// squash-on-merge project — while the code itself landed.
// ---------------------------------------------------------------------------

const MERGE_WAIT_MS = Number(process.env.DELIVER_MERGE_WAIT_MS || 300000) // 5 min
const MERGE_POLL_MS = Number(process.env.DELIVER_MERGE_POLL_MS || 5000)

// Synchronous sleep: this script is execFileSync throughout, so there is no event loop to
// await on. Atomics.wait on a throwaway SharedArrayBuffer is the standard way.
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

const glabMr = (iid) => {
  const r = tryCli(['api', `projects/:fullpath/merge_requests/${iid}`])
  if (!r.ok) return null
  try { return JSON.parse(r.out) } catch { return null }
}

// GitLab is still COMPUTING mergeability right after an MR is created. Merging into that
// window returns 405, which the old code reported as a guess — "required checks pending,
// conflict, or approval required" — and three separate delivery agents chased
// protected-branch and approval theories off the back of it, all wrong.
const WAIT_STATUS = new Set(['checking', 'unchecked', 'preparing', 'ci_still_running'])
// Refused IMMEDIATELY: waiting cannot change any of these, so polling would only burn the
// timeout before escalating with the same answer.
const REFUSE_STATUS = new Set([
  'conflict', 'discussions_not_resolved', 'not_approved', 'need_rebase',
  'broken_status', 'ci_must_pass', 'draft_status', 'blocked_status',
])

/**
 * Poll `detailed_merge_status` until GitLab says the MR can merge.
 *
 * Bounded, because this runs unattended. What it waited for and for how long lands in the
 * notes either way — an escalation that does not say what it waited on is indistinguishable
 * from the pipeline being broken, which is exactly the state #135 describes.
 */
const waitForMergeable = (iid) => {
  const started = Date.now()
  let last = ''
  for (;;) {
    const mr = glabMr(iid)
    // No readable status is not "mergeable" — proceed and let the merge itself decide,
    // rather than blocking forever on a field this GitLab version may not expose.
    if (!mr) return { ok: true, status: 'unknown', waitedMs: Date.now() - started }
    last = String(mr.detailed_merge_status || mr.merge_status || '')
    if (mr.state === 'merged') return { ok: true, status: 'merged', waitedMs: Date.now() - started }
    if (REFUSE_STATUS.has(last)) return { ok: false, status: last, waitedMs: Date.now() - started }
    if (!WAIT_STATUS.has(last)) return { ok: true, status: last || 'unknown', waitedMs: Date.now() - started }
    if (Date.now() - started >= MERGE_WAIT_MS) return { ok: false, status: last, timedOut: true, waitedMs: Date.now() - started }
    console.log(`  … waiting for GitLab: ${last} (${Math.round((Date.now() - started) / 1000)}s)`)
    sleepSync(MERGE_POLL_MS)
  }
}

/**
 * The head SHA the Reviewer actually cleared.
 *
 * `glab mr merge` without `--sha` returns 400 "SHA must be provided when merging": modern
 * glab defaults --auto-merge on, and GitLab's auto-merge requires one. Passing it is also
 * a correctness win, not just an API formality — the merge only lands if the branch head
 * still matches the reviewed commit, so a push arriving after the CLEAR verdict fails safe
 * instead of merging unreviewed work.
 */
const headSha = () => {
  for (const ref of [`origin/${BRANCH}`, BRANCH]) {
    const r = tryGit(['rev-parse', ref])
    if (r.ok && /^[0-9a-f]{7,40}$/i.test(r.out.trim())) return r.out.trim()
  }
  return ''
}

/**
 * Did this ticket's work actually land on the default branch?
 *
 * Ancestry FIRST, so non-squash repos are unchanged. But with `squash_option: default_on`
 * the source commit is squashed into a NEW one, so the original is never an ancestor and
 * ancestry alone is permanently false. Observed in the field on five merge requests at
 * once: all merged, all issues auto-closed by `Closes #N`, and the script reported
 * `not-delivered` for every one — a state worse than a clean failure, because a resume
 * then re-runs work that is already delivered.
 *
 * Status alone is deliberately NOT sufficient. A forge can report a merge that did not
 * land; the squash/merge commit must be REACHABLE from the target after a fetch. That is
 * the whole point of the check.
 */
const landedOn = (branch, pr) => {
  if (tryGit(['merge-base', '--is-ancestor', BRANCH, `origin/${branch}`]).ok) return 'ancestry'
  if (PLATFORM !== 'glab' || !pr || !pr.number) return ''
  const mr = glabMr(pr.number)
  if (!mr || mr.state !== 'merged') return ''
  const sha = mr.squash_commit_sha || mr.merge_commit_sha
  if (!sha) return ''
  tryGit(['fetch', 'origin', branch])
  return tryGit(['merge-base', '--is-ancestor', sha, `origin/${branch}`]).ok ? 'squash-commit' : ''
}

// Ensure the integration branch exists on origin, branched from the DEFAULT branch.
// Idempotent: a second ticket in the same run reuses it and never resets it (resetting
// would silently discard the previous ticket's delivery).
const ensureIntegrationBranch = () => {
  if (tryGit(['fetch', 'origin', INTEGRATION_BRANCH]).ok) return true
  const base = tryGit(['fetch', 'origin', DEFAULT_BRANCH])
  if (!base.ok) { note(`cannot create ${INTEGRATION_BRANCH}: fetching ${DEFAULT_BRANCH} failed`); return false }
  const push = tryGit(['push', 'origin', `origin/${DEFAULT_BRANCH}:refs/heads/${INTEGRATION_BRANCH}`])
  if (!push.ok) { note(`cannot create ${INTEGRATION_BRANCH}: ${firstLine(push.out)}`); return false }
  console.log(`+ branch  created ${INTEGRATION_BRANCH} from ${DEFAULT_BRANCH}`)
  return true
}

// Retarget the open MR/PR at the integration branch and merge it there.
// checks.merged is deliberately NOT set — it measures ancestry into the DEFAULT branch,
// so dodPassed stays false and the ticket reads as "not on main", which is the truth.
const rerouteToIntegration = (pr, failureOut) => {
  const kind = classifyMergeFailure(failureOut)
  if (kind !== 'protection') {
    note(`NOT rerouting to ${INTEGRATION_BRANCH}: the merge was refused by an unmet gate, not by branch protection — the change is not cleared to land anywhere`)
    return
  }
  if (!pr || !pr.number) { note(`cannot reroute to ${INTEGRATION_BRANCH}: no MR/PR number`); return }
  if (!ensureIntegrationBranch()) return

  const rt = PLATFORM === 'gh'
    ? tryCli(['pr', 'edit', String(pr.number), '--base', INTEGRATION_BRANCH])
    : tryCli(['mr', 'update', String(pr.number), '--target-branch', INTEGRATION_BRANCH])
  if (!rt.ok) { note(`retarget to ${INTEGRATION_BRANCH} failed: ${firstLine(rt.out)}`); return }

  // Same --sha requirement as the default-branch path (#152): both call sites hit the
  // identical 400 without it, and both gain the same safety — the merge lands only if the
  // head still matches what the Reviewer cleared.
  const rtSha = PLATFORM === 'glab' ? headSha() : ''
  const mg = PLATFORM === 'gh'
    ? tryCli(['pr', 'merge', String(pr.number), '--merge'])
    : tryCli(['mr', 'merge', String(pr.number), '--yes', ...(rtSha ? ['--sha', rtSha] : [])])
  if (!mg.ok) { note(`merge into ${INTEGRATION_BRANCH} failed: ${firstLine(mg.out)}`); return }

  tryGit(['fetch', 'origin', INTEGRATION_BRANCH])
  // Squash-aware, for the same reason as the default branch: under squash_option the
  // source commit is never an ancestor, so ancestry alone would report a successful
  // reroute as "not counted" forever.
  if (!landedOn(INTEGRATION_BRANCH, pr)) {
    note(`merge into ${INTEGRATION_BRANCH} reported success but the work is not reachable from it — not counting it`)
    return
  }
  checks.mergedToIntegration = true
  deliveredTo = INTEGRATION_BRANCH
  console.log(`+ merged  #${pr.number} -> ${INTEGRATION_BRANCH} (${DEFAULT_BRANCH} is protected)`)
  note(`DELIVERED TO ${INTEGRATION_BRANCH}, NOT ${DEFAULT_BRANCH} — ${DEFAULT_BRANCH} refused the merge (branch protection). The Definition of Done is NOT met until ${INTEGRATION_BRANCH} lands on ${DEFAULT_BRANCH}.`)
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

  // 1. clean tree — merging over uncommitted work is never sanctioned. `.codex/tmp/`
  // is ignored: run-milestone stages the Reviewer's verdict there for --verdict-file,
  // and that ephemeral scratch must not read as "dirty" and block delivery.
  // `.codex/tmp/` (staged verdict/body) and `docs/plans/` (the Architect's HOW plan —
  // ephemeral, and the DoD needs it to EXIST on disk, not be committed) are ignored so
  // untracked scratch never reads as "dirty" and blocks delivery (issues #50, #58).
  // `-uall` is load-bearing, not a detail: porcelain defaults to `-unormal`, which
  // COLLAPSES an entirely-untracked directory to a single entry. In a repo with nothing
  // tracked under docs/, the Architect's plan makes git print `?? docs/` — which this
  // path-anchored allowlist cannot match, so delivery refused every ticket as "dirty".
  // Observed on the catalog's own Level-1 rehearsal, 2026-07-27 (issue #75).
  //
  // `.codex/worktrees/` is exempt too (issue #141). At concurrency > 1 the HARNESS puts
  // each isolated agent's worktree at `.codex/worktrees/wf_<runId>-<agentIndex>/` —
  // inside the repo, and the pattern does not choose that path. Those are untracked, so
  // `-uall` reports them and every delivery refused to merge. Field report: 7 tickets
  // produced 16 worktrees (Builder and Reviewer are isolated; the Architect is not, since
  // it must write docs/plans/ on the main tree), and delivery was blocked throughout.
  // adopt.mjs also git-ignores the path, but this exemption is deliberate belt-and-braces:
  // the .gitignore block is marker-guarded, so a repo adopted earlier never gains the rule
  // unless someone re-adopts.
  //
  // `docs/prd/dag.html` is exempt for the same belt-and-braces reason (issue #153). It is
  // GENERATED by dag-report.mjs on every run, including mid-run when rescanEvery fires, so
  // on a Windows checkout with no eol rule it sits permanently modified with an EMPTY
  // diff and blocks delivery — intermittently, depending on whether the DAG happened to be
  // regenerated before that ticket's delivery ran. adopt.mjs now pins it to LF, but that
  // rule is marker-guarded and a repo adopted earlier never gains it without re-adopting.
  // The field report also shows why this must not be left to the agent: a delivery agent
  // that hit "working tree not clean" resolved it by running `git checkout --` on a file
  // it had never written, in a repo with other agents' worktrees live. It was harmless
  // only because the diff happened to be empty.
  const dirty = git(['status', '--porcelain', '-uall'])
    .split('\n')
    .filter((l) => l.trim() && !/\.claude\/tmp\/|\.claude\/worktrees\/|docs\/plans\/|docs\/prd\/dag\.html/.test(l))
  if (dirty.length) { note('working tree not clean — refusing to merge'); finish(0) }

  // 2. refs must exist locally
  for (const ref of [BRANCH, DEFAULT_BRANCH]) {
    if (!tryGit(['rev-parse', '--verify', '--quiet', ref]).ok) { note(`ref not found: ${ref}`); finish(0) }
  }

  // 3. resolve delivery mode
  checks.pushRequired = tryGit(['remote', 'get-url', 'origin']).ok
  const cliAuthed = tryCli(['auth', 'status'], { stdio: ['ignore', 'ignore', 'ignore'] }).ok
  // Cheap MR/PR-API probe: a token can have a working Issues API but a 403 MR API
  // (org policy — catalog issue #56). On glab that routes delivery to push-option MR.
  const mrApiOk = () => (PLATFORM === 'gh'
    ? tryCli(['pr', 'list', '--limit', '1', '--json', 'number'], { stdio: ['ignore', 'pipe', 'ignore'] }).ok
    : tryCli(['mr', 'list', '--per-page', '1'], { stdio: ['ignore', 'pipe', 'ignore'] }).ok)
  // `local` (catalog issue #180): finish the whole PRD on the local default branch and
  // touch NO forge — no push, no PR/MR, no tracker. The forge work is deferred to a human
  // (or an agent) after the run.
  //
  // The motivation is not tidiness. Every delivery defect this catalog has recorded lives
  // at the forge boundary — pipeline gates, protected branches, a 403 MR API, squash
  // ancestry, a missing --sha — and each one stops the whole run. `local` removes that
  // boundary from the critical path so development is never blocked by the tracker's
  // availability, its auth, or its merge policy.
  //
  // It is NOT a way to bypass review: the Architect -> Builder -> fresh Reviewer chain is
  // unchanged, and a ticket still only merges on CLEAR. What is deferred is publication.
  if (DELIVERY === 'local') {
    deliveryMode = 'local'
    // Deliberately ignore whether an origin exists. `local` means local, so a repo WITH a
    // remote must behave identically to one without — otherwise the mode would silently
    // do different things in the two places people actually use it.
    checks.pushRequired = false
  } else if (DELIVERY === 'direct') deliveryMode = 'direct'
  else if (DELIVERY === 'pushmr') {
    if (PLATFORM !== 'glab') { note('--delivery pushmr is GitLab-only (a GitHub push cannot open a PR); use pr or direct'); finish(0) }
    if (!checks.pushRequired) { note('--delivery pushmr requires an origin remote'); finish(0) }
    deliveryMode = 'pushmr'
  } else if (DELIVERY === 'pr') {
    if (!checks.pushRequired || !cliAuthed) { note(`--delivery pr requires an origin remote and an authenticated ${PLATFORM}; falling back is not allowed under an explicit flag`); finish(0) }
    deliveryMode = 'pr'
  } else if (!checks.pushRequired || !cliAuthed) deliveryMode = 'direct'
  else if (mrApiOk()) deliveryMode = 'pr'
  else if (PLATFORM === 'glab') { deliveryMode = 'pushmr'; note('MR API unavailable (403/denied) — using GitLab push-option MR (issue #56)') }
  else deliveryMode = 'direct' // GitHub with no PR API: falls back; a protected default branch would then block the push (note it)
  console.log(`delivery mode: ${deliveryMode}`)

  // supervised (--no-merge) with no forge: there is no PR to open — leave the local
  // branch for the human to merge, exactly as pre-PR-mode supervised delivery did.
  if (NO_MERGE && deliveryMode === 'direct') {
    awaitingMerge = true
    note('supervised (--no-merge) with no forge: leaving the local branch for the human to merge')
    finish(0)
  }

  // `local` reuses the direct path's local --no-ff merge; what differs is downstream —
  // pushRequired is false, so nothing is pushed, and the DoD term is the ledger.
  if (deliveryMode === 'direct' || deliveryMode === 'local') {
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
  } else if (deliveryMode === 'pushmr') {
    // ---- GitLab push-option MR path (no MR API; issue #56) ----
    // Resume: a prior run opened the MR and a human merged it on the web -> the branch is
    // now on origin/<base>. Detect that and fall through to close + DoD (Issues-API only).
    tryGit(['fetch', 'origin', DEFAULT_BRANCH])
    if (tryGit(['merge-base', '--is-ancestor', BRANCH, `origin/${DEFAULT_BRANCH}`]).ok) {
      checks.alreadyMerged = true; checks.merged = true; checks.pushed = true; checks.branchPushed = true
      console.log(`= merged  ${BRANCH} already on origin/${DEFAULT_BRANCH} (MR merged on the web)`)
      git(['checkout', DEFAULT_BRANCH], { stdio: ['ignore', 'pipe', 'pipe'] })
      const ff = tryGit(['merge', '--ff-only', `origin/${DEFAULT_BRANCH}`])
      if (!ff.ok) note(`local fast-forward failed: ${firstLine(ff.out)}`)
    } else {
      // open/update the MR over SSH via push options — no MR API. git forbids newlines in
      // a push-option value, so the description is a single line carrying Closes #N (issue
      // auto-closes on merge) + pointers; the full CLEAR verdict is posted as an ISSUE
      // comment via the WORKING Issues API. Re-running on a branch that already has an open
      // MR returns the existing MR URL (no duplicate). spawnSync so GitLab's "remote:"
      // stderr lines (the MR URL) are captured even on a successful push.
      const closes = ISSUE_ARG && Number(ISSUE_ARG) > 0 ? `Closes #${Number(ISSUE_ARG)}. ` : ''
      const desc = `${closes}Delivered by the three-agent pipeline (ticket ${ID}); plan docs/plans/${ID}.md; Reviewer verdict CLEAR — posted as a comment on the issue.`
      const pushArgs = ['push', '-o', 'merge_request.create', '-o', `merge_request.target=${DEFAULT_BRANCH}`,
        '-o', `merge_request.title=${prTitle()}`, '-o', `merge_request.description=${desc}`, '-u', 'origin', BRANCH]
      const res = spawnSync('git', pushArgs, { encoding: 'utf8' })
      const out = (res.stdout || '') + '\n' + (res.stderr || '')
      if (res.status !== 0 && !/merge_requests\//.test(out)) { note(`push-option MR failed: ${lastLine(out)}`); finish(0) }
      checks.branchPushed = true
      const m = out.match(/https?:\/\/\S*\/-\/merge_requests\/\d+/) || out.match(/merge_requests\/(\d+)/)
      if (m) { prUrl = m[0].startsWith('http') ? m[0] : ('/-/merge_requests/' + m[1]); checks.prCreated = true; console.log(`+ mr      ${prUrl}`) }
      else { checks.prCreated = true; note('MR opened via push option, but no MR URL appeared in the remote output') }
      // the full evidence goes as an ISSUE comment via the Issues API (works even when the
      // MR API is 403). The push-option MR description is single-line, so the structured body
      // (agent-filled --body-file) can't live there — it lives on the issue. Prefer the full
      // body; fall back to the verdict text.
      const vnum = ISSUE_ARG && Number(ISSUE_ARG) > 0 ? Number(ISSUE_ARG) : null
      const commentSrc = BODY_FILE && existsSync(BODY_FILE) ? BODY_FILE : VERDICT_FILE
      if (commentSrc && vnum) {
        const vr = tryCli(['issue', 'note', String(vnum), '--message', readFileSync(commentSrc, 'utf8')])
        if (vr.ok) { checks.verdictPosted = true; console.log(`+ comment delivery evidence posted to issue #${vnum}`) }
        else note(`issue-comment failed: ${firstLine(vr.out)}`)
      } else if (commentSrc) note('evidence not posted — no --issue number to comment on')
      awaitingMerge = true
      console.log('= awaiting human merge on the web — no MR API to merge programmatically (issue #56)')
      finish(0)
    }
  } else {
    // ---- pr path ----
    // 3a. push the ticket branch so the forge has it (AC2: branch exists on remote)
    const pb = tryGit(['push', '-u', 'origin', BRANCH])
    if (pb.ok) { checks.branchPushed = true; console.log(`+ pushed  ${BRANCH} -> origin`) }
    else { note(`branch push failed: ${lastLine(pb.out)} — cannot open a PR without it`); finish(0) }

    // 3a-bis. REFUSE to open a merge request that would revert the default branch.
    //
    // Catalog issue #151, and it is the most dangerous defect reported against this
    // pattern so far because it fails in the INVERTED direction. Every other failure here
    // ends at "the ticket did not deliver", which a human sees. This one ends at "here is
    // a normal-looking, conflict-free merge request" whose effect is a large deletion.
    //
    // The chain: /start-all leaves `ticket/<ID>` branches behind; the project squashes on
    // merge, so the original tip is never an ancestor of the default branch; any later
    // deliver invocation for that ticket — a resume, a retry, a second pass to close the
    // tracker — sees the branch still present, re-pushes it, and opens a NEW merge request
    // against the CURRENT default branch. That branch was cut from an old default and
    // never rebased, so the MR proposes reverting everything merged since. Four such MRs
    // sat open in a real repo, one of them -12,095 lines, all showing NO conflict. They
    // were found by a human scrolling the merge request list.
    //
    // Deliberately a REFUSAL, not a warning: the whole failure mode is that nothing in the
    // chain reports an error, so adding one more line to a log nobody reads is not a fix.
    {
      // TWO dots, not three. `a...b` diffs from the MERGE BASE, so it shows only what the
      // ticket changed and hides everything the default branch gained since — which is
      // precisely the damage a stale branch would do. `a..b` is the comparison the forge
      // shows as "diff vs main", and the one whose deletion count is the actual signal.
      const stat = tryGit(['diff', '--numstat', `origin/${DEFAULT_BRANCH}..${BRANCH}`])
      if (stat.ok) {
        let added = 0
        let removed = 0
        for (const line of stat.out.split('\n')) {
          const m = line.match(/^(\d+)\s+(\d+)\s/)
          if (m) { added += Number(m[1]); removed += Number(m[2]) }
        }
        // A ticket legitimately deletes code — a refactor, a removal ticket — so a bare
        // "removes anything" test would fire constantly and be turned off. The signature
        // of a stale branch is a diff dominated by deletions AND large in absolute terms.
        const REVERT_MIN_LINES = 200
        const REVERT_RATIO = 5
        if (removed >= REVERT_MIN_LINES && removed >= added * REVERT_RATIO) {
          note(`refusing to open a PR/MR: ${BRANCH} would REMOVE ${removed} lines and add ${added} against ${DEFAULT_BRANCH}. `
            + `That is the signature of a stale branch cut from an older ${DEFAULT_BRANCH} and never rebased — merging it would revert work delivered since. `
            + `If this ticket genuinely removes that much, rebase the branch onto ${DEFAULT_BRANCH} and re-run.`)
          finish(0)
        }
      }
    }

    // 3b. find or create the PR/MR
    let pr = findPr()
    if (pr) { checks.prExists = true; prUrl = pr.url; console.log(`= pr      exists for ${BRANCH} (#${pr.number})`) }
    else {
      const title = prTitle()
      const body = resolvePrBody() // repo MR/PR template (agent-filled) > template skeleton > hardcoded
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
    const landedBefore = landedOn(DEFAULT_BRANCH, pr)
    if (landedBefore) {
      checks.alreadyMerged = true
      console.log(`= merged  ${BRANCH} already on origin/${DEFAULT_BRANCH} (${landedBefore})`)
    } else if (pr && pr.number) {
      // GitLab only: wait for it to finish computing mergeability before attempting the
      // merge. Without this the merge races the forge and returns 405 on a project with a
      // pipeline gate — every ticket stranded as an open MR (#135, #152).
      let ready = { ok: true, status: '', waitedMs: 0 }
      if (PLATFORM === 'glab') {
        ready = waitForMergeable(pr.number)
        if (ready.waitedMs > 0) console.log(`  waited ${Math.round(ready.waitedMs / 1000)}s for GitLab (${ready.status})`)
      }
      if (!ready.ok) {
        // The observed status, verbatim. The old wording was a GUESS covering three
        // unrelated causes at once, and delivery agents chased the wrong ones.
        note(ready.timedOut
          ? `merge not attempted: GitLab still reported \`${ready.status}\` after ${Math.round(ready.waitedMs / 1000)}s — MR left open`
          : `merge refused by GitLab: detailed_merge_status=\`${ready.status}\``)
        if (INTEGRATION_BRANCH) rerouteToIntegration(pr, ready.status)
      } else {
        const sha = PLATFORM === 'glab' ? headSha() : ''
        const mg = PLATFORM === 'gh'
          ? tryCli(['pr', 'merge', String(pr.number), '--merge'])
          : tryCli(['mr', 'merge', String(pr.number), '--yes', ...(sha ? ['--sha', sha] : [])])
        if (!mg.ok) {
          note(`forge merge failed${ready.status ? ` (detailed_merge_status=\`${ready.status}\`)` : ''}: ${firstLine(mg.out)}`)
          // Only a PROTECTION refusal may be rerouted. Anything else stays an escalation.
          if (INTEGRATION_BRANCH) rerouteToIntegration(pr, mg.out)
        } else console.log(`+ merged  #${pr.number} via ${PLATFORM} (forge-side)`)
      }
      tryGit(['fetch', 'origin', DEFAULT_BRANCH])
    }
    // confirm the merge actually landed on the remote default, then sync local
    const landedHow = landedOn(DEFAULT_BRANCH, pr)
    if (landedHow) {
      if (landedHow === 'squash-commit') {
        console.log(`+ landed  via squash commit (the source commit is not an ancestor — squash_option is on)`)
      }
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
  // Landing on the INTEGRATION branch counts for closing the issue, but not for the DoD
  // (issue #139, maintainer decision). Leaving the issue open instead would make the
  // resume filter re-run every ticket already built on the integration branch, producing
  // duplicate and conflicting work — the larger cost. The close comment names the branch,
  // and `dodPassed` stays false, so the ticket reads as delivered-but-not-on-main.
  const landed = (checks.merged && (!checks.pushRequired || checks.pushed)) || checks.mergedToIntegration
  if (!landed) note(deliveryMode === 'local' ? 'skipping ledger write — the merge did not complete, ticket is NOT delivered' : 'skipping tracker close — merge/push did not complete, ticket is NOT delivered')
  else if (deliveryMode === 'local') checks.ledgerWritten = writeLedger()
  else closeIssue()

  // 4b. mirror the completion into Asana (issue #126). Same `landed` precondition as the
  // tracker close, for the same reason: a completed subtask on an unlanded merge reports
  // delivery that did not happen. Fail-soft by construction — asana-sync.mjs exits 0 on
  // every Asana problem, and even a crash of the child is only a note here.
  if (landed) completeAsana()

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
