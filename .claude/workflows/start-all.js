export const meta = {
  name: 'start-all',
  description: 'Whole-PRD driver: schedules every ticket from the flat blocked_by DAG, reloading the DAG mid-run so tickets added while it runs still execute',
  phases: [{ title: 'Schedule', detail: 'dispatch ready tickets; reload the DAG on a cadence' }],
}

// Whole-PRD scheduler. Each ticket still runs architect plan -> builder execute ->
// fresh-context reviewer (bounce-capped in code) -> deterministic deliver.
//
// This does NOT compose run-milestone (catalog issue #71, maintainer decision). It
// schedules from ONE flat graph gated only by blocked_by, so two modules with no
// dependency between them run concurrently. The old module-barrier driver serialized
// them: measured at 11 ticket-rounds vs 5 on the catalog's 19-ticket fixture (#68).
//
// run-milestone.js is deliberately left in place for /start-milestone and the nightly
// sweep. The cost is that the dispatch loop, cascade, deadlock guard, worktree
// isolation and deliver mutex now exist in two workflow files -- workflow scripts
// cannot import each other, so the duplication is structural. suite-startall's PARITY
// test is the guard: both schedulers must agree on identical static input.
//
// args:
// {
//   tickets: [{ id, path, issue, module, blockedBy: ['OTHER-ID'] }],  // FLAT, all modules
//     // blockedBy carries cross-module edges too -- they gate directly now, instead of
//     // being approximated by a module barrier. Closed-issue tickets filtered upstream.
//   mode: 'supervised' | 'autonomous',
//   concurrency: 1,          // optional; >1 = parallel lanes (autonomous only)
//   rescanEvery: 3,          // optional; reload the DAG every N settled tickets. 0 = never
//   prdRoot: 'docs/prd',     // optional; what the rescan agent scans
//   maxTickets: 200,         // optional; runaway guard on dynamic growth
//   maxRescans: 100,         // optional; hard ceiling on DAG reloads (each is an agent call)
//   defaultBranch, platform, testCmd, maxBounces   // as run-milestone
// }
//
// Failure policy: a failed ticket cascades to its dependents (skipped); independent
// branches continue in `autonomous`; anything short of a CLEAR stops the run in
// `supervised`.

// args may arrive as a JSON string depending on the harness (catalog issue #23)
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {})
const cfg = Object.assign(
  { maxBounces: 2, defaultBranch: 'main', platform: 'gh', concurrency: 1, rescanEvery: 3, prdRoot: 'docs/prd', maxTickets: 200, maxRescans: 100 },
  parsedArgs
)

if (!Array.isArray(cfg.tickets) || cfg.tickets.length === 0) {
  throw new Error('args.tickets must be a non-empty array of {id, path, issue, module, blockedBy}')
}
for (const t of cfg.tickets) {
  if (!t || typeof t.id !== 'string' || !t.id || typeof t.path !== 'string' || !t.path) {
    throw new Error('every ticket needs a non-empty id and path; got: ' + JSON.stringify(t))
  }
  if (t.blockedBy !== undefined && !Array.isArray(t.blockedBy)) {
    throw new Error('ticket ' + t.id + ' blockedBy must be an array')
  }
}
if (cfg.mode !== 'supervised' && cfg.mode !== 'autonomous') {
  throw new Error("args.mode must be 'supervised' or 'autonomous'")
}
// 'none' = LOCAL delivery (catalog issue #180): no tracker, no push, no PR/MR. Every
// delivery defect this catalog has recorded lives at the forge boundary, and each one
// stops the whole run; 'none' takes that boundary off the critical path. Review is
// unchanged — what is deferred is PUBLICATION, not judgement.
if (cfg.platform !== 'gh' && cfg.platform !== 'glab' && cfg.platform !== 'none') throw new Error("args.platform must be 'gh', 'glab', or 'none' (local delivery, no tracker)")
const LOCAL_ONLY = cfg.platform === 'none'
if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1) {
  throw new Error('args.concurrency must be an integer >= 1')
}
if (!Number.isInteger(cfg.rescanEvery) || cfg.rescanEvery < 0) {
  throw new Error('args.rescanEvery must be an integer >= 0 (0 disables mid-run DAG reload)')
}
if (!Number.isInteger(cfg.maxTickets) || cfg.maxTickets < 1) {
  throw new Error('args.maxTickets must be an integer >= 1')
}
if (!Number.isInteger(cfg.maxRescans) || cfg.maxRescans < 1) {
  throw new Error('args.maxRescans must be an integer >= 1')
}
if (cfg.testCmd !== undefined && (typeof cfg.testCmd !== 'string' || !cfg.testCmd || cfg.testCmd.includes('"'))) {
  throw new Error('args.testCmd must be a non-empty string without double quotes when provided')
}

// supervised delivery opens a PR and stops for a human merge -- it cannot run parallel lanes
let concurrency = cfg.concurrency
if (cfg.mode === 'supervised' && concurrency > 1) {
  log('supervised mode is sequential -- forcing concurrency=1 (parallel lanes are autonomous-only)')
  concurrency = 1
}

const PLAN = {
  type: 'object',
  properties: { planPath: { type: 'string' }, summary: { type: 'string' }, content: { type: 'string' } },
  required: ['planPath', 'summary'],
}
const BUILD = {
  type: 'object',
  properties: { branch: { type: 'string' }, testsPassed: { type: 'boolean' }, testOutput: { type: 'string' }, deviations: { type: 'string' }, summary: { type: 'string' } },
  required: ['branch', 'testsPassed', 'testOutput'],
}
const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['CLEAR', 'BOUNCE'] },
    findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string' }, issue: { type: 'string' } }, required: ['file', 'issue'] } },
    checkedNote: { type: 'string' },
    // The PATH the Reviewer wrote its own record to — never the record's text.
    // Carrying the text is what forced a third party to re-type a verdict, which a
    // safety classifier correctly read as one agent authoring another agent's approval
    // and blocked, stranding CLEAR tickets (catalog issue #201).
    recordPath: { type: 'string' },
    // One entry per [machine]/[fixture] acceptance row (catalog issue #183). A CLEAR
    // carrying an unmet row is REJECTED below, which is what turns "did the Reviewer
    // check acceptance?" from a judgement into a check.
    machineChecks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { row: { type: 'string' }, met: { type: 'boolean' }, note: { type: 'string' } },
        required: ['row', 'met'],
      },
    },
  },
  required: ['verdict'],
}
const DELIVERY = {
  type: 'object',
  properties: { merged: { type: 'boolean' }, issueClosed: { type: 'boolean' }, dodPassed: { type: 'boolean' }, awaitingMerge: { type: 'boolean' }, prUrl: { type: 'string' }, notes: { type: 'string' } },
  required: ['merged', 'issueClosed', 'dodPassed'],
}
// Post-run cleanup report (catalog issue #151). `branchesKept` is not an afterthought:
// what could NOT be cleaned is the part that matters, because a leftover ticket branch is
// what later opens a merge request that reverts the default branch.
const CLEANUP = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    detail: { type: 'string' },
    worktreesPruned: { type: 'boolean' },
    branchesDeleted: { type: 'array', items: { type: 'string' } },
    branchesKept: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok'],
}

const SCAN = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    detail: { type: 'string' },
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        // `state` is load-bearing, not decoration (catalog issue #136). Step 4 filters out
        // tickets whose issue is CLOSED -- that is the resume filter, and what makes a
        // re-run after a pause or a new PRD phase execute only the new work. The mid-run
        // rescan never had it, so an already-delivered ticket was pulled straight back
        // into the running schedule: re-planned and re-built against a codebase that
        // already contains its work, and if it reached deliver, merged a second time.
        properties: { id: { type: 'string' }, module: { type: 'string' }, path: { type: 'string' }, issue: { type: 'number' }, state: { type: 'string' }, blockedBy: { type: 'array', items: { type: 'string' } } },
        required: ['id', 'path'],
      },
    },
  },
  required: ['ok'],
}

const normalizePath = function (p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim() }

const makeLock = function () {
  let tail = Promise.resolve()
  return function (fn) { const run = tail.then(fn); tail = run.then(function () {}, function () {}); return run }
}

// ---- one ticket, end to end (same contract as run-milestone's runTicket) -------------
async function runTicket(t, opts) {
  const isolate = opts && opts.isolate
  const deliverLock = (opts && opts.deliverLock) || function (fn) { return fn() }
  const P = 'T:' + t.id
  const branch = 'ticket/' + t.id
  const planPath = 'docs/plans/' + t.id + '.md'

  log('[' + t.id + '] architect: planning')
  const plan = await agent(
    'You are running as the Architect stage of the three-agent pattern. Ticket file: ' + t.path +
    '. Produce the implementation plan per your role definition and write it to EXACTLY ' + planPath +
    '. Return planPath (must be ' + planPath + ') and a one-paragraph summary.' +
    (isolate ? ' ALSO return the full plan text in the `content` field -- the Builder runs in an isolated worktree and cannot read the plan file.' : ''),
    { agentType: 'architect', label: 'plan:' + t.id, phase: P, schema: PLAN }
  )
  if (!plan || normalizePath(plan.planPath) !== planPath) {
    return { id: t.id, status: 'failed', stage: 'architect', detail: plan ? 'plan written to unexpected path: ' + plan.planPath : 'architect agent returned nothing' }
  }

  const buildBad = function (b) { return !b || !b.testsPassed || String(b.branch).trim() !== branch }
  const buildIsolation = isolate ? { isolation: 'worktree' } : {}
  const planForBuilder = isolate
    ? 'You are in a fresh isolated git worktree of ' + cfg.defaultBranch + ' (it already contains every delivered dependency). Implement this plan (the plan file is NOT in your worktree):\n<<<PLAN\n' + (plan.content || plan.summary) + '\nPLAN\n'
    : 'Plan: ' + planPath + '. '

  log('[' + t.id + '] builder: implementing on ' + branch)
  let build = await agent(
    'Builder stage. Ticket: ' + t.path + '. ' + planForBuilder + 'Create branch ' + branch +
    ' from ' + cfg.defaultBranch + ', implement it there, commit, run the tests. Do NOT merge and do NOT touch the tracker. ' +
    'Return branch (must be ' + branch + '), testsPassed, testOutput (paste real output), deviations, ' +
    'and summary = one paragraph on WHAT you changed and why, written for a human reviewer and describing only what you actually did -- it is quoted into the pull request body.',
    Object.assign({ agentType: 'builder', label: 'build:' + t.id, phase: P, schema: BUILD }, buildIsolation)
  )
  if (buildBad(build)) {
    return { id: t.id, status: 'failed', stage: 'builder', detail: !build ? 'builder agent returned nothing' : (String(build.branch).trim() !== branch ? 'worked on wrong branch: ' + build.branch : build.testOutput) }
  }

  const reviewOnce = function (tag) {
    return agent(
      'Reviewer stage. Inputs (artifact refs only): ticket ' + t.path + ', plan ' + planPath +
      ', diff = branch ' + branch + ' vs ' + cfg.defaultBranch + '. ' +
      (isolate ? 'You are in a fresh isolated worktree: `git fetch` if needed, then `git checkout --detach ' + branch + '` (detached, so a busy branch elsewhere is fine) to get the code, and run the tests there. ' : '') +
      'Review per your role definition; run the tests yourself -- no test results are provided on purpose. ' +
      'FIRST take every [machine] and [fixture] acceptance row in the ticket, run it, and report it in machineChecks with met true/false -- one entry per row, a reason on any false. An unmet row is disqualifying: BOUNCE, or escalate where the ticket contradicts itself. A Builder-documented blocker is NOT grounds for CLEAR. ' +
      'THEN WRITE YOUR OWN REVIEW RECORD to EXACTLY .claude/tmp/' + t.id + '-verdict.md -- your findings, the commands you ran with their real output, and anything you could not verify. ' +
      (isolate ? 'That path is relative to the MAIN repository, not your worktree: get the main root with `git rev-parse --path-format=absolute --git-common-dir` and write under <that directory minus the trailing /.git>. A record written inside a throwaway worktree disappears with it. ' : '') +
      'Nobody else writes this file and nobody re-types it -- it is posted on the pull request as YOUR words, and a verdict with no record is refused at delivery. Write it on BOUNCE as well as CLEAR, and return recordPath. ' +
    'Return verdict CLEAR or BOUNCE with findings (a BOUNCE with zero findings is invalid).',
      Object.assign({ agentType: 'reviewer', label: 'review:' + t.id + '#' + tag, phase: P, schema: VERDICT }, isolate ? { isolation: 'worktree' } : {})
    )
  }
  const reviewValid = function (v) {
    if (!v) return false
    if (v.verdict === 'BOUNCE' && (!v.findings || v.findings.length === 0)) return false
    return true
  }

  let bounces = 0
  let verdict = await reviewOnce('0')
  if (!reviewValid(verdict)) { log('[' + t.id + '] reviewer returned no usable verdict -- retrying once'); verdict = await reviewOnce('0-retry') }
  let reviewerBroken = !reviewValid(verdict)
  let fixBroken = false

  while (!reviewerBroken && verdict.verdict === 'BOUNCE' && bounces < cfg.maxBounces) {
    bounces += 1
    log('[' + t.id + '] bounce ' + bounces + '/' + cfg.maxBounces + ': back to builder with ' + verdict.findings.length + ' finding(s)')
    build = await agent(
      'Builder stage, bounce fix. Ticket: ' + t.path + '. ' + planForBuilder + 'Stay on branch ' + branch +
      ' -- do NOT merge and do NOT touch the tracker. Reviewer findings -- address ALL of them and add regression tests: ' +
      JSON.stringify(verdict.findings) + '. Run the tests. Return branch (must be ' + branch + '), testsPassed, testOutput, deviations.',
      Object.assign({ agentType: 'builder', label: 'fix:' + t.id + '#' + bounces, phase: P, schema: BUILD }, buildIsolation)
    )
    if (buildBad(build)) { fixBroken = true; break }
    verdict = await reviewOnce(String(bounces))
    if (!reviewValid(verdict)) { log('[' + t.id + '] reviewer returned no usable verdict -- retrying once'); verdict = await reviewOnce(bounces + '-retry') }
    reviewerBroken = !reviewValid(verdict)
  }


  // A CLEAR carrying an UNMET acceptance row is not a CLEAR (catalog issue #183). A ticket
  // was delivered with three [machine] rows unsatisfiable by inspection: the Builder
  // refused to implement them and said so, and the Reviewer passed it anyway — a
  // well-documented blocker reads like diligence, and diligence reads like grounds to
  // pass. This turns that judgement into a check, and it escalates rather than bounces,
  // because a ticket that contradicts itself is a human's decision.
  const unmet = reviewValid(verdict) && verdict.verdict === 'CLEAR'
    ? (verdict.machineChecks || []).filter(function (c) { return c && c.met === false })
    : []
  if (unmet.length) {
    log('[' + t.id + '] CLEAR REJECTED -- ' + unmet.length + ' acceptance row(s) reported unmet')
    return {
      id: t.id, status: 'escalated', stage: 'acceptance-unmet', bounces: bounces,
      findings: verdict.findings || [],
      detail: 'reviewer returned CLEAR with unmet acceptance: ' + unmet.map(function (c) { return c.row + (c.note ? ' (' + c.note + ')' : '') }).join('; '),
    }
  }

  if (reviewerBroken || fixBroken || verdict.verdict !== 'CLEAR') {
    const stage = reviewerBroken ? 'reviewer-failed' : (fixBroken ? 'bounce-fix-build' : 'review')
    log('[' + t.id + '] escalated to a human (stage: ' + stage + ', after ' + bounces + ' bounce(s))')
    return {
      id: t.id, status: 'escalated', stage: stage, bounces: bounces,
      findings: reviewValid(verdict) ? (verdict.findings || []) : [],
      detail: fixBroken ? (!build ? 'fix builder returned nothing' : (String(build.branch).trim() !== branch ? 'fix worked on wrong branch: ' + build.branch : build.testOutput)) : (reviewerBroken ? 'reviewer produced no usable verdict after one retry' : 'bounce cap exhausted'),
    }
  }

  const recordPath = '.claude/tmp/' + t.id + '-verdict.md'
  const bodyFile = '.claude/tmp/' + t.id + '-mrbody.md'
  const deliverCmd = 'node .claude/scripts/deliver-ticket.mjs --id ' + t.id + ' --branch ' + branch +
    ' --default-branch ' + cfg.defaultBranch + (LOCAL_ONLY ? ' --delivery local' : ' --platform ' + cfg.platform + (t.issue ? ' --issue ' + t.issue : '')) +
    (cfg.testCmd ? ' --test-cmd "' + cfg.testCmd + '"' : '') + ' --verdict-file ' + recordPath + ' --body-file ' + bodyFile +
    (cfg.mode === 'supervised' ? ' --no-merge' : '')
  // The Reviewer wrote its own record. This stage VERIFIES it and points the script at
  // it; it never writes or summarises a verdict (catalog issues #201, #206). Delivery is
  // an executor here for a MECHANICAL reason -- a workflow script has no filesystem and no
  // exec, so an agent is the only actor inside a run that can invoke a command -- which is
  // the same reason the Codex pattern keeps its own delivery actuator.
  const deliverPrompt =
    'Delivery step. You are an EXECUTOR, not a judge: you (1) verify the Reviewer wrote its record, (2) compose the PR/MR body from the artifacts below, and (3) run one command. Never merge, push, open PRs/MRs, or close issues yourself. ' +
    'FIRST verify ' + recordPath + ' exists and is NOT empty. If it is missing or empty, STOP: return merged/issueClosed/dodPassed = false with that as the reason. Do NOT write it, do NOT summarise the verdict, do NOT substitute anything -- the Reviewer authors that file and an unevidenced review must not become a merge. ' +
    'Next compose the PR/MR body and write it to ' + bodyFile + ': START from the repo\'s MR/PR template ' +
    '(.gitlab/merge_request_templates/default.md on GitLab, else .github/pull_request_template.md; if neither exists, write nothing and skip this file) and FILL its sections from the ticket ' + t.path +
    ', the diff (`git diff ' + cfg.defaultBranch + '...' + branch + '` -- summarize, do not paste it whole), the Reviewer\'s record above (quote it; do not paraphrase it into an approval), and the repo CLAUDE.md non-negotiables for the **Constraint check** section (tick what the diff touches, mark the rest N/A). ' +
    'These facts are supplied because only this run holds them, and a body that reads complete but is partly invented is worse than one that admits a gap: BOUNCE cycles = ' + bounces + '; Builder-declared deviations = ' + JSON.stringify((build && build.deviations) || 'none declared') + '; Builder summary = ' + JSON.stringify((build && build.summary) || '(none returned)') + '. ' +
    'Any section you cannot fill from an artifact must say it is unavailable and why -- never infer one. Include `Closes #' + (t.issue || '<n>') + '`. Do not invent spec the ticket lacks. ' +
    'Then, from the repo root, run EXACTLY this command and let it do all git and tracker work: ' + deliverCmd +
    ' -- this is the only sanctioned delivery path. Parse the DELIVER-SUMMARY-JSON line it prints last and return ' +
    'merged, issueClosed, dodPassed, awaitingMerge, outcome, deliveredTo, and prUrl EXACTLY as reported there, with notes = its notes field plus anything unusual. ' +
    'If the command cannot run or prints no DELIVER-SUMMARY-JSON, return merged/issueClosed/dodPassed = false with the output tail in notes.'

  if (cfg.mode === 'supervised') {
    log('[' + t.id + '] CLEAR -- supervised: opening a PR/MR for human review (deterministic deliver, --no-merge)')
    const delivery = await agent(deliverPrompt, { label: 'deliver:' + t.id, phase: P, schema: DELIVERY })
    if (delivery && delivery.awaitingMerge) {
      log('[' + t.id + '] PR/MR open for review: ' + (delivery.prUrl || '(url not reported)') + ' -- merge it, then re-run to continue (closed issues are filtered out).')
      return { id: t.id, status: 'awaiting-human-merge', branch: branch, prUrl: delivery.prUrl || '', bounces: bounces, note: verdict.checkedNote || '' }
    }
    return { id: t.id, status: 'delivery-incomplete', detail: 'supervised PR/MR creation did not complete' + (delivery && delivery.notes ? ' -- ' + delivery.notes : '') }
  }

  log('[' + t.id + '] deliver: PR/MR + forge-merge + close + DoD (deterministic script, serialized)')
  const delivery = await deliverLock(function () { return agent(deliverPrompt, { label: 'deliver:' + t.id, phase: P, schema: DELIVERY }) })
  // Trust deliver-ticket.mjs's own verdict rather than re-deriving one. `dodPassed`
  // already encodes the mode (local delivery swaps the closed issue for a ledger write),
  // and requiring `issueClosed` here reported every correct LOCAL delivery as incomplete
  // -- the false-negative class issue #152 removed, reintroduced by issue #180's new mode.
  const landed = delivery && delivery.merged === true && delivery.dodPassed === true
  if (!landed) {
    const missing = !delivery
      ? 'delivery agent returned nothing'
      : ['merged', 'dodPassed'].filter(function (k) { return delivery[k] !== true }).join(', ') + ' = false' +
        (delivery.outcome ? ' (outcome: ' + delivery.outcome + ')' : '')
    return { id: t.id, status: 'delivery-incomplete', detail: missing + (delivery && delivery.notes ? ' -- ' + delivery.notes : '') }
  }
  return { id: t.id, status: 'delivered', bounces: bounces, prUrl: delivery.prUrl || '' }
}

// ---- the graph, live -----------------------------------------------------------------
const tickets = new Map()
const state = new Map() // pending | running | done | failed | skipped
const resultById = new Map()
const escalations = []
for (const t of cfg.tickets) {
  tickets.set(t.id, { id: t.id, path: t.path, issue: t.issue, module: t.module || '', blockedBy: (t.blockedBy || []).slice() })
  state.set(t.id, 'pending')
}

// Only edges to tickets IN this run gate scheduling: a blocker delivered by an earlier
// run (or living outside the PRD) is already satisfied and must not stall the graph.
const depsOf = function (t) { return (t.blockedBy || []).filter(function (d) { return tickets.has(d) }) }
const anyPending = function () { return Array.from(state.values()).some(function (s) { return s === 'pending' }) }

// A pending ticket whose blocker failed or was skipped can never run -- mark it now so
// the reason reads "a blocker did not deliver" rather than surfacing as a deadlock.
const cascade = function () {
  let changed = true
  while (changed) {
    changed = false
    for (const t of tickets.values()) {
      if (state.get(t.id) !== 'pending') continue
      if (depsOf(t).some(function (d) { return state.get(d) === 'failed' || state.get(d) === 'skipped' })) {
        state.set(t.id, 'skipped')
        resultById.set(t.id, { id: t.id, status: 'skipped-dependency', detail: 'a blocker did not deliver' })
        changed = true
      }
    }
  }
}

// Cycles can only appear mid-run (dag-scan topo-sorts the initial graph and rejects
// cycles), so this runs after a reload: peel pendings whose blockers are not themselves
// pending; whatever will not peel is a cycle.
const pendingCycle = function () {
  const remaining = new Set()
  for (const t of tickets.values()) if (state.get(t.id) === 'pending') remaining.add(t.id)
  let changed = true
  while (changed) {
    changed = false
    for (const id of Array.from(remaining)) {
      const stillBlocked = depsOf(tickets.get(id)).some(function (d) { return remaining.has(d) })
      if (!stillBlocked) { remaining.delete(id); changed = true }
    }
  }
  return Array.from(remaining).sort()
}

let scans = 0
let settledSinceScan = 0
let growthStopped = false
// Tickets a RESCAN dropped because their issue is already closed. Kept separate from the
// launch-time drops so the final report can distinguish them: "filtered at launch" and
// "filtered mid-run" mean different things to whoever reads it.
const rescanDroppedClosed = []

// Merge a fresh scan into the live graph. Returns true if anything became schedulable.
const mergeScan = function (scanned) {
  const seen = new Set()
  let added = 0
  let changed = false

  for (const s of scanned.tickets || []) {
    if (!s || typeof s.id !== 'string' || !s.id || typeof s.path !== 'string' || !s.path) continue
    seen.add(s.id)
    const known = tickets.get(s.id)
    if (!known) {
      // The SAME closed-issue rule step 4 applies at launch (catalog issue #136). Without
      // it the rescan re-admitted delivered tickets, and the reporter's workaround was
      // rescanEvery: 0 -- disabling the live-DAG feature outright. That the workaround
      // worked is itself evidence the two paths had diverged instead of sharing one rule.
      //
      // Reported, never silent: step 4 already carries that obligation, because a filter
      // that removes work without saying so is indistinguishable from work that ran.
      if (String(s.state || '').toLowerCase() === 'closed') {
        rescanDroppedClosed.push(s.id)
        log('rescan: - ' + s.id + ' (already delivered; its issue is closed)')
        continue
      }
      if (tickets.size >= cfg.maxTickets) {
        if (!growthStopped) {
          growthStopped = true
          escalations.push('maxTickets (' + cfg.maxTickets + ') reached -- stopped taking new tickets; ' + s.id + ' and any later additions were NOT run')
          log('rescan: maxTickets reached -- refusing further growth')
        }
        continue
      }
      tickets.set(s.id, { id: s.id, path: s.path, issue: s.issue, module: s.module || '', blockedBy: (s.blockedBy || []).slice() })
      state.set(s.id, 'pending')
      added += 1
      changed = true
      log('rescan: + ' + s.id + ' (added mid-run' + (s.module ? ', module ' + s.module : '') + ')')
      continue
    }
    if (s.issue && !known.issue) { known.issue = s.issue; changed = true }
    const before = (known.blockedBy || []).slice().sort().join(',')
    const after = (s.blockedBy || []).slice().sort().join(',')
    if (before === after) continue
    const st = state.get(s.id)
    if (st === 'pending') {
      known.blockedBy = (s.blockedBy || []).slice()
      changed = true
      log('rescan: ~ ' + s.id + ' blockers updated to [' + after + ']')
    } else {
      // The lane is already past the point where this edge could have been honored.
      // Rewriting deps now would misreport what the run enforced, and aborting would
      // discard in-flight work -- so record it and let the human judge.
      escalations.push('late dependency change on ' + s.id + ' ignored: it is already ' + st +
        ' (was [' + before + '], now [' + after + ']) -- the run did not enforce the new edge')
      log('rescan: ! ' + s.id + ' dependency changed after dispatch -- NOT enforced, escalated')
    }
  }

  for (const id of Array.from(tickets.keys())) {
    if (seen.has(id)) continue
    if (state.get(id) !== 'pending') continue
    tickets.delete(id)
    state.delete(id)
    changed = true
    log('rescan: - ' + id + ' (ticket removed while still pending)')
  }

  const cyc = pendingCycle()
  for (const id of cyc) {
    state.set(id, 'failed')
    resultById.set(id, { id: id, status: 'failed', stage: 'schedule', detail: 'dependency cycle introduced by a mid-run DAG change: ' + cyc.join(', ') })
  }
  if (cyc.length) {
    escalations.push('mid-run DAG change introduced a dependency cycle among: ' + cyc.join(', '))
    log('rescan: dependency cycle among ' + cyc.join(', ') + ' -- failed loudly')
  }

  if (added) log('rescan: graph is now ' + tickets.size + ' ticket(s)')
  return changed
}

const rescan = async function (reason) {
  if (cfg.rescanEvery === 0) return false
  if (growthStopped) return false
  // Hard ceiling independent of the cadence: a reload is an agent call, and a run that
  // somehow keeps reloading must stop costing tokens rather than be trusted to converge.
  if (scans >= cfg.maxRescans) {
    if (scans === cfg.maxRescans) {
      scans += 1
      escalations.push('maxRescans (' + cfg.maxRescans + ') reached -- stopped reloading the DAG; tickets added after this point were NOT run')
      log('rescan: maxRescans reached -- no further DAG reloads')
    }
    return false
  }
  scans += 1
  const known = Array.from(tickets.keys()).join(', ')
  const scanned = await agent(
    'DAG reload step for the running /start-all scheduler (reason: ' + reason + '). You are NOT implementing anything. ' +
    'Run these commands from the repo root and report what they print -- do not invent, infer, or edit any ticket:\n' +
    '1. `node .claude/scripts/dag-scan.mjs ' + cfg.prdRoot + '` -- parse its final SCAN-JSON line. If it exits non-zero, ' +
    'STOP and return ok=false with its stderr in detail; a half-written ticket must not disturb a run already in flight.\n' +
    // Steps 2 and 2b differ by runtime, but the RULE they feed is identical: a ticket
    // already delivered must not be re-admitted. Only the signal differs — a closed
    // tracker issue, or a row in the local ledger (catalog issues #136, #180).
    (LOCAL_ONLY
      ? '2. There is NO tracker in this run (platform: none). Do NOT publish anything and do NOT run publish-tickets.mjs.\n' +
        '2b. Report each ticket\'s `state` from the LOCAL DELIVERY LEDGER instead: read `docs/delivered.json` (it may not exist yet -- then every state is "open"). ' +
        'A ticket whose id appears in its `delivered` array is "closed"; every other ticket is "open". ' +
        'This is the same filter the run applies at launch, reading the only signal that exists without a tracker: re-admitting an already-delivered ticket re-plans and re-builds it against a codebase that already contains its work. ' +
        'If you cannot read the ledger, say so in detail rather than reporting every ticket as "open".\n'
      : '2. For every scanned ticket whose id is NOT in this already-known list [' + known + '], publish it so delivery can close its issue: ' +
        'run `node .claude/scripts/publish-tickets.mjs <its module dir under ' + cfg.prdRoot + '> --create --platform ' + cfg.platform + '` ' +
        'once per affected module dir (idempotent -- the [<id>] title prefix dedupes), and read the issue numbers from its PUBLISH-SUMMARY-JSON line. Skip this step entirely if there are no new ids.\n' +
        '2b. You MUST report each ticket\'s issue `state` ("open" or "closed") exactly as PUBLISH-SUMMARY-JSON reports it. ' +
        'For a module you did not publish in step 2, run the SAME command WITHOUT --create (a dry run creates nothing) purely to read the states. ' +
        'This is not optional bookkeeping: a ticket whose issue is closed has already been delivered, and re-admitting it re-plans and re-builds against a codebase that already contains its work. ' +
        'If you genuinely cannot determine a state, omit the field rather than guessing "open".\n') +
    '3. `node .claude/scripts/dag-report.mjs ' + cfg.prdRoot + '` -- refresh the Gate 1 visualization so it shows the live DAG.\n' +
    'Return ok=true and `tickets` = the SCAN-JSON ticket list, each with id, module, path and blockedBy exactly as scanned, ' +
    'plus `issue` (a number) for any ticket whose issue number you saw in a PUBLISH-SUMMARY-JSON line.',
    { label: 'rescan#' + scans + ':' + reason, phase: 'Schedule', effort: 'low', schema: SCAN }
  )
  if (!scanned || !scanned.ok || !Array.isArray(scanned.tickets) || scanned.tickets.length === 0) {
    // Keeping the previous graph is the point: a transient bad edit must not kill work.
    const why = scanned && scanned.detail ? scanned.detail : 'rescan agent returned nothing usable'
    escalations.push('DAG reload #' + scans + ' (' + reason + ') failed, kept the previous graph: ' + why)
    log('rescan #' + scans + ' failed -- keeping the previous graph: ' + why)
    return false
  }
  return mergeScan(scanned)
}

// ---- schedule ------------------------------------------------------------------------
const deliverLock = makeLock()
const isolate = concurrency > 1
let stopRun = false
let active = 0
const inflight = new Map()

const nextReady = function () {
  for (const t of tickets.values()) {
    if (state.get(t.id) !== 'pending') continue
    if (!depsOf(t).every(function (d) { return state.get(d) === 'done' })) continue
    return t
  }
  return null
}

const settle = function (id, r) {
  resultById.set(id, r)
  state.set(id, r.status === 'delivered' ? 'done' : 'failed')
  if (cfg.mode === 'supervised' && r.status !== 'delivered') stopRun = true
}

log('start-all: scheduling ' + tickets.size + ' ticket(s) from the flat DAG (concurrency=' + concurrency +
  ', rescanEvery=' + (cfg.rescanEvery || 'off') + ')')

while (true) {
  cascade()

  if (!stopRun) {
    while (active < concurrency) {
      const t = nextReady()
      if (!t) break
      state.set(t.id, 'running')
      active += 1
      const id = t.id
      inflight.set(id, runTicket(t, { isolate: isolate, deliverLock: deliverLock }).then(
        function (r) { return { id: id, r: r } },
        function (e) { return { id: id, r: { id: id, status: 'failed', stage: 'lane', detail: 'lane threw: ' + (e && e.message ? e.message : String(e)) } } }
      ))
    }
  }

  if (inflight.size === 0) {
    // Nothing is running. Before finishing OR declaring deadlock, force a reload: a
    // ticket added late would otherwise never be seen, and "pending with nothing to
    // unblock it" cannot tell a real cycle from a blocker not yet written.
    const stuck = anyPending()
    if (!stopRun) {
      await rescan(stuck ? 'deadlock-check' : 'final-check')
      cascade()
      // Loop again only if the reload produced work we can actually dispatch. Gating on
      // "something changed" instead would spin forever on a reload that reports a
      // difference the scheduler cannot act on.
      if (nextReady()) continue
    }
    if (stuck && !stopRun) {
      for (const t of tickets.values()) {
        if (state.get(t.id) !== 'pending') continue
        state.set(t.id, 'failed')
        resultById.set(t.id, { id: t.id, status: 'failed', stage: 'schedule', detail: 'unsatisfiable dependency (cycle, or a blocker that never arrived) -- confirmed after a DAG reload' })
      }
      cascade()
    }
    break
  }

  const settled = await Promise.race(Array.from(inflight.values()))
  inflight.delete(settled.id)
  active -= 1
  settle(settled.id, settled.r)

  settledSinceScan += 1
  if (cfg.rescanEvery > 0 && settledSinceScan >= cfg.rescanEvery && !stopRun) {
    settledSinceScan = 0
    await rescan('cadence')
  }
}

const results = []
for (const id of tickets.keys()) if (resultById.has(id)) results.push(resultById.get(id))
for (const t of tickets.values()) {
  if (resultById.has(t.id)) continue
  results.push({ id: t.id, status: 'not-started', detail: stopRun ? 'run stopped before this ticket' : 'never scheduled' })
}

// ---- post-run cleanup (catalog issue #151) --------------------------------------------
// The run creates a `ticket/<ID>` branch per ticket and, at concurrency > 1, a worktree
// per isolated agent. Neither was ever cleaned up: one observed run left 16 worktrees, a
// later one 21, on top of the previous leftovers.
//
// Left alone the branches are not merely untidy. On a squash-on-merge project the
// delivered commit is a NEW commit, so the ticket tip is never an ancestor of the default
// branch — and any later deliver invocation for that ticket re-pushes the branch and opens
// a merge request against a default branch that has moved on, proposing to revert
// everything merged since. Four such merge requests sat open in a real repo, one of them
// -12,095 lines, all conflict-free, found only because a human scrolled the list.
//
// Only DELIVERED tickets are cleaned. A failed or skipped ticket's branch is evidence and
// stays. And what could not be cleaned is REPORTED rather than dropped — the whole failure
// mode is that nothing said anything.
const cleanupReport = { branchesDeleted: [], branchesKept: [], worktreesPruned: false }
{
  const deliveredIds = results
    .filter(function (r) { return r.status === 'delivered' })
    .map(function (r) { return r.id })
  if (deliveredIds.length || concurrency > 1) {
    // The cleanup RULE lives in cleanup-run.mjs, not in this prompt (catalog issue #208).
    // It used to be prose — which branches may be deleted, which are evidence and must be
    // left — and an agent asked to 'delete only the DELIVERED ones' is one summarisation
    // away from deleting the only copy of work a human still has to look at. This stage is
    // an executor: it runs one command because a workflow script cannot, and relays JSON.
    const clean = await agent(
      'Post-run cleanup. You are NOT implementing anything and must NOT touch any ticket, plan, or source file. ' +
      'Run EXACTLY this command from the repo root and nothing else:\n' +
      'node .claude/scripts/cleanup-run.mjs --delivered ' + (deliveredIds.join(',') || '') + ' --default-branch ' + cfg.defaultBranch +
      (concurrency > 1 ? '' : ' --keep-worktrees') + '\n' +
      'Parse its CLEANUP-JSON line and return ok=true with branchesDeleted, branchesKept and worktreesPruned taken EXACTLY from it, ' +
      'plus detail = its escalations joined. Do NOT delete anything yourself, do NOT touch remote branches, and if the command ' +
      'cannot run return ok=false with the output tail in detail.',
      { label: 'cleanup', phase: 'Deliver', effort: 'low', schema: CLEANUP }
    )
    if (clean && clean.ok) {
      cleanupReport.branchesDeleted = clean.branchesDeleted || []
      cleanupReport.branchesKept = clean.branchesKept || []
      cleanupReport.worktreesPruned = clean.worktreesPruned === true
      log('cleanup: deleted ' + cleanupReport.branchesDeleted.length + ' delivered ticket branch(es)' +
        (cleanupReport.worktreesPruned ? ', pruned run worktrees' : ''))
      if (cleanupReport.branchesKept.length) {
        escalations.push('cleanup could not remove: ' + cleanupReport.branchesKept.join(', ') +
          ' — delete them by hand; a stale ticket branch can later open a merge request that reverts ' + cfg.defaultBranch)
      }
    } else {
      // Never silent. An uncleaned run is exactly the state that produced the reverting
      // merge requests, so it has to reach the operator.
      escalations.push('post-run cleanup did not complete' + (clean && clean.detail ? ': ' + clean.detail : '') +
        ' — ticket branches and any run worktrees are still present; a stale ticket branch can later open a merge request that reverts ' + cfg.defaultBranch)
      log('cleanup: did NOT complete — leftover branches/worktrees remain (see escalations)')
    }
  }
}

// Local delivery leaves work on the LOCAL default branch and nowhere else, so the run has
// to hand it over explicitly (issue #180). Without this the mode is indistinguishable from
// silent hoarding: everything looks delivered, and nothing is anywhere a colleague can see.
const localHandoff = LOCAL_ONLY
  ? {
      branch: cfg.defaultBranch,
      ledger: 'docs/delivered.json',
      pushed: false,
      next: [
        'Nothing was pushed and no PR/MR was opened — this run touched no forge.',
        'Review the local history: git log --oneline ' + cfg.defaultBranch,
        'When you want it published: git push origin ' + cfg.defaultBranch,
        'Or hand this summary to an agent and ask it to push and open the PR/MR.',
      ],
    }
  : null

const delivered = results.filter(function (r) { return r.status === 'delivered' || r.status === 'awaiting-human-merge' }).length
log('start-all finished: ' + delivered + '/' + results.length + ' ticket(s) through the pipeline ' +
  '(concurrency=' + concurrency + ', ' + scans + ' DAG reload(s))')
// Surfaced at the END, not only in the mid-run log line: a rescan drop is the same class
// of event as a launch-time drop, and step 4 already reports those. A filter that removes
// work silently is indistinguishable from work that ran (catalog issue #136).
if (rescanDroppedClosed.length) {
  log('rescan dropped ' + rescanDroppedClosed.length + ' already-delivered ticket(s) (issue closed): ' + rescanDroppedClosed.join(', '))
}
if (localHandoff) {
  log('LOCAL DELIVERY -- nothing was pushed and no PR/MR was opened.')
  for (const line of localHandoff.next) log('  ' + line)
}
for (const e of escalations) log('escalation: ' + e)

return {
  scheduler: 'global-dag',
  mode: cfg.mode,
  concurrency: concurrency,
  rescans: scans,
  ticketCount: results.length,
  delivered: delivered,
  // Machine-readable, so a caller can distinguish "the rescan found nothing new" from
  // "the rescan found delivered work and correctly declined to re-run it".
  rescanDroppedClosed: rescanDroppedClosed,
  cleanup: cleanupReport,
  localHandoff: localHandoff,
  escalations: escalations,
  results: results,
}
