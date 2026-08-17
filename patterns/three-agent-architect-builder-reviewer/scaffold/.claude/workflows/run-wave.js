export const meta = {
  name: 'run-wave',
  description: 'Run one WAVE of mutually independent tickets through architect -> builder -> fresh reviewer (bounce-capped in code). Delivery is the orchestrator\'s, not this workflow\'s.',
  phases: [{ title: 'Wave', detail: 'plan, implement and review every ticket in the wave' }],
}

// The three-agent pipeline for ONE WAVE. Replaces run-milestone.js and start-all.js
// (catalog issue #206).
//
// WHY THERE IS NO DELIVERY STAGE HERE
// -----------------------------------
// There used to be a fourth agent. It made no judgement: it verified a file existed,
// filled in a PR template, ran one deterministic command, and relayed a JSON line. It was
// not even a defined role — no agents/delivery.md, no agentType, just an inline prompt.
// Being a separate context was its only distinguishing property, and that property is what
// forced the Reviewer's approval to be HANDED across a boundary and re-typed by a third
// party, which a safety classifier correctly read as one agent authoring another agent's
// approval and blocked (catalog issues #201, #206).
//
// Delivery now belongs to the orchestrator, which was idle for the whole run and already
// holds every artifact. That has one hard consequence, and it is the reason this file is
// wave-scoped rather than DAG-scoped: a workflow script has no filesystem and no exec, so
// the ONLY actor inside a running workflow that can run deliver-ticket.mjs is an agent. No
// delivery inside means no merge inside; no merge inside means a ticket and its blocker can
// never share a run, because a dependent builds from a default branch that must already
// contain its dependency.
//
// So scheduling moved out too — to wave-plan.mjs, which is deterministic code, not prose.
// The orchestrator loops: plan a wave, run it here, deliver what cleared, plan again.
//
// args:
// {
//   tickets: [{ id, path, issue, module, blockedBy }],  // MUTUALLY INDEPENDENT — validated below
//   defaultBranch: 'main',   // optional, default 'main'
//   maxBounces: 2,           // optional, default 2
//   concurrency: 1,          // optional; >1 runs tickets in isolated git worktrees
//   waveNumber: 1,           // optional; label only
// }
//
// Returns { results: [...] } where each result's status is one of:
//   reviewed-clear  — CLEAR verdict, branch pushed nowhere, NOTHING delivered. The
//                     orchestrator delivers it; until then the ticket is not done.
//   escalated       — a human must decide (bounce cap, unmet acceptance, broken reviewer)
//   failed          — a stage did not produce its artifact
//
// Guarantees encoded here, each because prose alone failed before:
// - reviewer prompts carry ONLY artifact refs (ticket path, computed plan path/branch)
// - a reviewer infrastructure failure never consumes bounce budget or dispatches a fix
// - the Reviewer AUTHORS its own record; nothing in this file ever re-types a verdict
// - a CLEAR carrying an unmet [machine]/[fixture] acceptance row is rejected
// - a wave containing an edge between two of its own tickets is refused, not run

// args may arrive as a JSON string depending on the harness (catalog issue #23)
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {})
const cfg = Object.assign({ maxBounces: 2, defaultBranch: 'main', concurrency: 1, waveNumber: 1 }, parsedArgs)

if (!Array.isArray(cfg.tickets) || cfg.tickets.length === 0) {
  throw new Error('args.tickets must be a non-empty array of {id, path, issue}')
}
for (const t of cfg.tickets) {
  if (!t || typeof t.id !== 'string' || !t.id || typeof t.path !== 'string' || !t.path) {
    throw new Error('every ticket needs a non-empty string id and path; got: ' + JSON.stringify(t))
  }
  if (!/^[A-Za-z0-9._-]+$/.test(t.id)) {
    throw new Error('ticket id must match [A-Za-z0-9._-]+; got: ' + t.id)
  }
}
if (!Number.isInteger(cfg.maxBounces) || cfg.maxBounces < 0) throw new Error('args.maxBounces must be an integer >= 0')
if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1) throw new Error('args.concurrency must be an integer >= 1')
if (typeof cfg.defaultBranch !== 'string' || !cfg.defaultBranch) throw new Error('args.defaultBranch must be a non-empty string')

// A wave is independent BY CONSTRUCTION or it is not a wave. wave-plan.mjs guarantees this;
// the check is here because the guarantee is load-bearing and cheap to verify, and because
// a hand-assembled args (a human, a nightly sweep, a future caller) has no such guarantee.
// Running a dependent before its blocker merges builds it against a tree missing the work
// it depends on — and the tests would pass, because the dependency simply is not there yet.
{
  const inWave = new Set(cfg.tickets.map(function (t) { return t.id }))
  const edges = []
  for (const t of cfg.tickets) {
    for (const d of t.blockedBy || []) if (inWave.has(d)) edges.push(t.id + ' <- ' + d)
  }
  if (edges.length) {
    throw new Error(
      'this wave is not independent: ' + edges.join(', ') +
      '. A blocker must be DELIVERED before its dependent runs — split these across waves ' +
      '(wave-plan.mjs does this automatically).'
    )
  }
}

const ids = cfg.tickets.map(function (t) { return t.id })
if (new Set(ids).size !== ids.length) throw new Error('duplicate ticket id in the wave: ' + ids.join(', '))

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
    // The PATH the Reviewer wrote its own record to — not the record's text. Passing the
    // text would recreate the hand-off this design exists to remove (catalog issue #201):
    // the record's author and its writer must be the same agent.
    recordPath: { type: 'string' },
    // One entry per [machine]/[fixture] acceptance row (catalog issue #183). A CLEAR
    // carrying an unmet row is REJECTED below, which turns "did the Reviewer check
    // acceptance?" from a judgement into a check.
    machineChecks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { row: { type: 'string' }, met: { type: 'boolean' }, note: { type: 'string' } },
        required: ['row', 'met'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'number' }, scenario: { type: 'string' }, severity: { type: 'string' } },
        required: ['file', 'scenario'],
      },
    },
  },
  required: ['verdict'],
}

const normalizePath = function (p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim() }

const isolate = cfg.concurrency > 1

async function runTicket(t) {
  const P = 'Wave'
  const branch = 'ticket/' + t.id
  const planPath = 'docs/plans/' + t.id + '.md'
  const recordPath = '.claude/tmp/' + t.id + '-verdict.md'

  log('[' + t.id + '] architect: planning')
  const plan = await agent(
    'You are running as the Architect stage of the three-agent pattern. Ticket file: ' + t.path +
    '. Produce the implementation plan per your role definition and write it to EXACTLY ' + planPath +
    '. Return planPath (must be ' + planPath + ') and a one-paragraph summary.' +
    (isolate ? ' ALSO return the full plan text in the `content` field — the Builder runs in an isolated worktree and cannot read the plan file.' : ''),
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
    'and summary = one paragraph on WHAT you changed and why. That summary is quoted into the pull request body ' +
    'by the orchestrator, so write it for a human reviewer, and describe only what you actually did.',
    Object.assign({ agentType: 'builder', label: 'build:' + t.id, phase: P, schema: BUILD }, buildIsolation)
  )
  if (buildBad(build)) {
    return { id: t.id, status: 'failed', stage: 'builder', detail: !build ? 'builder agent returned nothing' : (String(build.branch).trim() !== branch ? 'worked on wrong branch: ' + build.branch : build.testOutput) }
  }

  // The Reviewer WRITES ITS OWN RECORD. Nothing downstream re-types it: the workflow
  // carries the path, the orchestrator verifies the file is non-empty, deliver-ticket.mjs
  // reads it. That is what makes the classifier objection disappear rather than be worked
  // around — the only agent that ever authors a verdict is the one that reached it.
  const reviewOnce = function (tag) {
    return agent(
      'Reviewer stage. Inputs (artifact refs only): ticket ' + t.path + ', plan ' + planPath +
      ', diff = branch ' + branch + ' vs ' + cfg.defaultBranch + '. ' +
      (isolate ? 'You are in a fresh isolated worktree: `git fetch` if needed, then `git checkout --detach ' + branch + '` (detached, so a busy branch elsewhere is fine) to get the code, and run the tests there. ' : '') +
      'Review per your role definition; run the tests yourself — no test results are provided on purpose. ' +
      'FIRST take every [machine] and [fixture] acceptance row in the ticket, run it, and report it in machineChecks with met true/false — one entry per row, a reason on any false. An unmet row is disqualifying: BOUNCE, or escalate where the ticket contradicts itself. A Builder-documented blocker is NOT grounds for CLEAR. ' +
      'THEN WRITE YOUR OWN REVIEW RECORD to EXACTLY ' + recordPath + ' — your findings, the commands you ran and their real output, and anything you could not verify. ' +
      (isolate
        ? 'That path is relative to the MAIN repository, not your worktree: get the main root with `git rev-parse --path-format=absolute --git-common-dir` and write to <that directory minus the trailing /.git>/' + recordPath + '. '
        : '') +
      'Nobody else will write this record and nobody will re-type it — it is quoted into the pull request as YOUR words, so a record you did not write is a review a human cannot audit. Return recordPath = the path you wrote. ' +
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
  if (!reviewValid(verdict)) { log('[' + t.id + '] reviewer returned no usable verdict — retrying once'); verdict = await reviewOnce('0-retry') }
  let reviewerBroken = !reviewValid(verdict)
  let fixBroken = false

  while (!reviewerBroken && verdict.verdict === 'BOUNCE' && bounces < cfg.maxBounces) {
    bounces += 1
    log('[' + t.id + '] bounce ' + bounces + '/' + cfg.maxBounces + ': back to builder with ' + verdict.findings.length + ' finding(s)')
    build = await agent(
      'Builder stage, bounce fix. Ticket: ' + t.path + '. ' + planForBuilder + 'Stay on branch ' + branch +
      ' — do NOT merge and do NOT touch the tracker. Reviewer findings — address ALL of them and add regression tests: ' +
      JSON.stringify(verdict.findings) + '. Run the tests. Return branch (must be ' + branch + '), testsPassed, testOutput, deviations, summary.',
      Object.assign({ agentType: 'builder', label: 'fix:' + t.id + '#' + bounces, phase: P, schema: BUILD }, buildIsolation)
    )
    if (buildBad(build)) { fixBroken = true; break }
    verdict = await reviewOnce(String(bounces))
    if (!reviewValid(verdict)) { log('[' + t.id + '] reviewer returned no usable verdict — retrying once'); verdict = await reviewOnce(bounces + '-retry') }
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
    log('[' + t.id + '] CLEAR REJECTED — ' + unmet.length + ' acceptance row(s) reported unmet')
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

  log('[' + t.id + '] CLEAR after ' + bounces + ' bounce(s) — NOT delivered; handing back to the orchestrator')
  return {
    id: t.id,
    status: 'reviewed-clear',
    branch: branch,
    issue: t.issue,
    path: t.path,
    planPath: planPath,
    bounces: bounces,
    // Everything the orchestrator needs to compose a PR body WITHOUT inferring anything
    // (catalog issue #193): every section of the template maps to one of these fields, and
    // a field that is absent is reported as unavailable rather than guessed.
    recordPath: normalizePath(verdict.recordPath) || recordPath,
    recordWritten: Boolean(verdict.recordPath),
    deviations: (build && build.deviations) || '',
    testOutput: (build && build.testOutput) || '',
    buildSummary: (build && build.summary) || '',
    machineChecks: verdict.machineChecks || [],
  }
}

// Bounded parallelism. Tickets in a wave are independent, so there is no ordering to
// preserve — only a cap, because each isolated lane is a real git worktree on disk.
const results = []
{
  const queue = cfg.tickets.slice()
  const workers = []
  const width = Math.min(cfg.concurrency, queue.length)
  log('wave ' + cfg.waveNumber + ': ' + cfg.tickets.length + ' independent ticket(s), concurrency=' + cfg.concurrency +
    (isolate ? ' (isolated worktrees)' : ''))
  for (let i = 0; i < width; i++) {
    workers.push((async function () {
      while (queue.length) {
        const t = queue.shift()
        try {
          results.push(await runTicket(t))
        } catch (e) {
          results.push({ id: t.id, status: 'failed', stage: 'lane', detail: 'lane threw: ' + (e && e.message ? e.message : String(e)) })
        }
      }
    })())
  }
  await Promise.all(workers)
}

// Stable order regardless of completion order, so two runs of the same wave produce
// comparable reports.
const order = new Map(cfg.tickets.map(function (t, i) { return [t.id, i] }))
results.sort(function (a, b) { return order.get(a.id) - order.get(b.id) })

const cleared = results.filter(function (r) { return r.status === 'reviewed-clear' }).length
log('wave ' + cfg.waveNumber + ' finished: ' + cleared + '/' + cfg.tickets.length + ' reviewed CLEAR and awaiting delivery')

return {
  waveNumber: cfg.waveNumber,
  concurrency: cfg.concurrency,
  isolated: isolate,
  // Named so a caller cannot mistake it for delivery. NOTHING here has been merged, pushed,
  // or closed — that is the orchestrator's next step, and a run that stops at this line has
  // delivered nothing at all.
  cleared: cleared,
  results: results,
}
