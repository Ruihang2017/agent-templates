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
if (cfg.platform !== 'gh' && cfg.platform !== 'glab') throw new Error("args.platform must be 'gh' or 'glab'")
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
  properties: { branch: { type: 'string' }, testsPassed: { type: 'boolean' }, testOutput: { type: 'string' }, deviations: { type: 'string' } },
  required: ['branch', 'testsPassed', 'testOutput'],
}
const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['CLEAR', 'BOUNCE'] },
    findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string' }, issue: { type: 'string' } }, required: ['file', 'issue'] } },
    checkedNote: { type: 'string' },
  },
  required: ['verdict'],
}
const DELIVERY = {
  type: 'object',
  properties: { merged: { type: 'boolean' }, issueClosed: { type: 'boolean' }, dodPassed: { type: 'boolean' }, awaitingMerge: { type: 'boolean' }, prUrl: { type: 'string' }, notes: { type: 'string' } },
  required: ['merged', 'issueClosed', 'dodPassed'],
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
        properties: { id: { type: 'string' }, module: { type: 'string' }, path: { type: 'string' }, issue: { type: 'number' }, blockedBy: { type: 'array', items: { type: 'string' } } },
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
    'Return branch (must be ' + branch + '), testsPassed, testOutput (paste real output), deviations.',
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

  if (reviewerBroken || fixBroken || verdict.verdict !== 'CLEAR') {
    const stage = reviewerBroken ? 'reviewer-failed' : (fixBroken ? 'bounce-fix-build' : 'review')
    log('[' + t.id + '] escalated to a human (stage: ' + stage + ', after ' + bounces + ' bounce(s))')
    return {
      id: t.id, status: 'escalated', stage: stage, bounces: bounces,
      findings: reviewValid(verdict) ? (verdict.findings || []) : [],
      detail: fixBroken ? (!build ? 'fix builder returned nothing' : (String(build.branch).trim() !== branch ? 'fix worked on wrong branch: ' + build.branch : build.testOutput)) : (reviewerBroken ? 'reviewer produced no usable verdict after one retry' : 'bounce cap exhausted'),
    }
  }

  const verdictNote = verdict && verdict.checkedNote ? verdict.checkedNote : 'CLEAR (the reviewer returned no note text)'
  const verdictFile = '.claude/tmp/' + t.id + '-verdict.md'
  const bodyFile = '.claude/tmp/' + t.id + '-mrbody.md'
  const deliverCmd = 'node .claude/scripts/deliver-ticket.mjs --id ' + t.id + ' --branch ' + branch +
    ' --default-branch ' + cfg.defaultBranch + ' --platform ' + cfg.platform + (t.issue ? ' --issue ' + t.issue : '') +
    (cfg.testCmd ? ' --test-cmd "' + cfg.testCmd + '"' : '') + ' --verdict-file ' + verdictFile + ' --body-file ' + bodyFile +
    (cfg.mode === 'supervised' ? ' --no-merge' : '')
  const deliverPrompt =
    'Delivery step. Delivery is DETERMINISTIC -- you only (1) record the verdict, (2) compose the PR/MR body, and (3) run one command; never merge, push, open PRs/MRs, or close issues yourself. ' +
    'First write the following Reviewer CLEAR verdict text VERBATIM to ' + verdictFile + ' (create the .claude/tmp directory if needed):\n' +
    '<<<VERDICT\n' + verdictNote + '\nVERDICT\n' +
    'Next compose the PR/MR body and write it to ' + bodyFile + ': START from the repo\'s MR/PR template ' +
    '(.gitlab/merge_request_templates/default.md on GitLab, else .github/pull_request_template.md; if neither exists, write nothing and skip this file) and FILL its sections from the ticket ' + t.path +
    ', the diff (`git diff ' + cfg.defaultBranch + '...' + branch + '` -- summarize, do not paste it whole), the CLEAR verdict above, and the repo CLAUDE.md non-negotiables for the **Constraint check** section (tick what the diff touches, mark the rest N/A). Include `Closes #' + (t.issue || '<n>') + '`. Do not invent spec the ticket lacks. ' +
    'Then, from the repo root, run EXACTLY this command and let it do all git and tracker work: ' + deliverCmd +
    ' -- this is the only sanctioned delivery path. Parse the DELIVER-SUMMARY-JSON line it prints last and return ' +
    'merged, issueClosed, dodPassed, awaitingMerge, and prUrl EXACTLY as reported there, with notes = its notes field plus anything unusual. ' +
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
  if (!delivery || !(delivery.merged && delivery.issueClosed && delivery.dodPassed)) {
    const missing = !delivery ? 'delivery agent returned nothing' : ['merged', 'issueClosed', 'dodPassed'].filter(function (k) { return !delivery[k] }).join(', ') + ' = false'
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
    '2. For every scanned ticket whose id is NOT in this already-known list [' + known + '], publish it so delivery can close its issue: ' +
    'run `node .claude/scripts/publish-tickets.mjs <its module dir under ' + cfg.prdRoot + '> --create --platform ' + cfg.platform + '` ' +
    'once per affected module dir (idempotent -- the [<id>] title prefix dedupes), and read the issue numbers from its PUBLISH-SUMMARY-JSON line. Skip this step entirely if there are no new ids.\n' +
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

const delivered = results.filter(function (r) { return r.status === 'delivered' || r.status === 'awaiting-human-merge' }).length
log('start-all finished: ' + delivered + '/' + results.length + ' ticket(s) through the pipeline ' +
  '(concurrency=' + concurrency + ', ' + scans + ' DAG reload(s))')
for (const e of escalations) log('escalation: ' + e)

return {
  scheduler: 'global-dag',
  mode: cfg.mode,
  concurrency: concurrency,
  rescans: scans,
  ticketCount: results.length,
  delivered: delivered,
  escalations: escalations,
  results: results,
}
