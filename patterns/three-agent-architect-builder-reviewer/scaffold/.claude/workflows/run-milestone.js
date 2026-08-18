export const meta = {
  name: 'run-milestone',
  description: 'Autonomous milestone runner: each ticket flows architect -> builder -> reviewer (bounce-capped in code) -> deliver; optional DAG-parallel lanes',
}

// Deterministic orchestrator for the three-agent pattern. Control flow that used to be
// prose ("max 2 bounces", "never merge without CLEAR") is enforced HERE, in code.
//
// args:
// {
//   tickets: [{ id, path, issue, blockedBy: ['OTHER-ID'] }],  // blockedBy: intra-run deps (optional)
//   mode: 'supervised' | 'autonomous',
//   defaultBranch: 'main',        // optional, default 'main'
//   integrationBranch: '',        // optional (issue #139). When set AND mode is autonomous,
//                                 // a merge the default branch refuses BECAUSE IT IS
//                                 // PROTECTED is retargeted here instead of stalling the
//                                 // run. Never used for an unmet gate (failing pipeline,
//                                 // missing approval) — that still escalates. Delivery
//                                 // here closes the issue but does NOT pass the DoD.
//   maxBounces: 2,                // optional, default 2
//   continueOnFailure: false,     // optional; default fail-fast (tickets may depend on earlier ones)
//   platform: 'gh' | 'glab',      // tracker CLI for the deliver step, default 'gh'
//   testCmd: 'npm test',          // optional; forwarded to deliver-ticket.mjs --test-cmd
//   concurrency: 1                // optional, default 1 = fully sequential (unchanged). >1 = DAG-parallel
//                                 // lanes (autonomous only): independent tickets run in isolated git
//                                 // worktrees; deliver (merge to the default branch) is serialized.
// }
//
// Guarantees encoded below (each one exists because prose alone failed before):
// - reviewer prompts carry ONLY artifact refs (ticket path, computed plan path/branch)
// - a reviewer infrastructure failure never consumes the bounce budget or dispatches a fix
// - nothing counts as delivered unless merged AND issueClosed AND dodPassed are all true
// - supervised STOPS after each CLEAR (later tickets may depend on the merge) — and is always
//   sequential (concurrency is forced to 1 in supervised mode)
// - concurrency=1 reproduces the sequential runner exactly (isolation off, no deliver lock)

// args may arrive as a JSON string depending on the harness (catalog issue #23)
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {})
const cfg = Object.assign(
  { maxBounces: 2, continueOnFailure: false, defaultBranch: 'main', platform: 'gh', concurrency: 1, integrationBranch: '' },
  parsedArgs
)
if (!Array.isArray(cfg.tickets) || cfg.tickets.length === 0) {
  throw new Error('args.tickets must be a non-empty array of {id, path, issue}')
}
const ticketIds = new Set(cfg.tickets.map(function (t) { return t && t.id }))
for (const t of cfg.tickets) {
  if (!t || typeof t.id !== 'string' || !t.id || typeof t.path !== 'string' || !t.path) {
    throw new Error('every ticket needs a non-empty string id and path; got: ' + JSON.stringify(t))
  }
  if (!/^[A-Za-z0-9._-]+$/.test(t.id)) {
    throw new Error('ticket id must match [A-Za-z0-9._-]+; got: ' + t.id)
  }
  if (t.blockedBy !== undefined) {
    if (!Array.isArray(t.blockedBy)) throw new Error('ticket ' + t.id + ' blockedBy must be an array')
    // deps outside this run are ignored (already delivered / other module) — only intra-run edges gate scheduling
  }
}
if (cfg.mode !== 'supervised' && cfg.mode !== 'autonomous') {
  throw new Error("args.mode must be 'supervised' or 'autonomous'")
}
if (cfg.testCmd !== undefined && (typeof cfg.testCmd !== 'string' || !cfg.testCmd || cfg.testCmd.includes('"'))) {
  throw new Error('args.testCmd must be a non-empty string without double quotes when provided')
}
// The Definition of Done includes "tests green". Without a test command that item cannot be
// EVALUATED, and an unevaluated item used to pass by default — on the adopter that
// reported catalog issue #205, across all 32 delivered tickets. Fail at launch instead of
// discovering it afterwards: the answer is known at Gate 1 and nowhere cheaper.
if (!cfg.testCmd && cfg.noTests !== true) {
  throw new Error(
    'args.testCmd is required: the Definition of Done certifies "tests green", and without a ' +
    'command that item cannot be evaluated. Declare the repository test command in CLAUDE.md ' +
    '(adopt.mjs detects it), or pass noTests: true to state deliberately that this repository ' +
    'has no test suite — which is recorded as a waiver, never as a pass.'
  )
}
if (!Number.isInteger(cfg.maxBounces) || cfg.maxBounces < 0) {
  throw new Error('args.maxBounces must be an integer >= 0')
}
if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1) {
  throw new Error('args.concurrency must be an integer >= 1')
}
if (typeof cfg.defaultBranch !== 'string' || !cfg.defaultBranch) throw new Error('args.defaultBranch must be a non-empty string')
if (cfg.platform !== 'gh' && cfg.platform !== 'glab') throw new Error("args.platform must be 'gh' or 'glab'")

// supervised delivery opens a PR and stops for a human merge — it cannot run parallel lanes
let concurrency = cfg.concurrency
if (cfg.mode === 'supervised' && concurrency > 1) {
  log('supervised mode is sequential — forcing concurrency=1 (parallel lanes are autonomous-only)')
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
    verdict: { enum: ['CLEAR', 'BOUNCE'] },
    checkedNote: { type: 'string' },
    // The PATH the Reviewer wrote its own record to — never the record's text.
    // Carrying the text is what forced a third party to re-type a verdict, which a
    // safety classifier correctly read as one agent authoring another agent's approval
    // and blocked, stranding CLEAR tickets (catalog issue #201).
    recordPath: { type: 'string' },
    // One entry per [machine]/[fixture] acceptance row (catalog issue #183). A CLEAR
    // carrying an unmet row is REJECTED below, which is what turns 'did the Reviewer
    // check acceptance?' from a judgement into a check.
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
        properties: { file: { type: 'string' }, line: { type: 'integer' }, scenario: { type: 'string' }, severity: { enum: ['blocker', 'major', 'minor'] } },
        required: ['file', 'scenario', 'severity'],
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

const normalizePath = function (p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim() }

// deliver serialization: merges to the default branch on the MAIN working tree must never
// overlap. A tiny promise-chain mutex; sequential runs pass no lock (direct call).
const makeLock = function () {
  let tail = Promise.resolve()
  return function (fn) { const run = tail.then(fn); tail = run.then(function () {}, function () {}); return run }
}

// Run one ticket end to end and RETURN its result (never pushes/breaks — the caller schedules).
// opts.isolate: build/review run in their own git worktrees (parallel-safe); the plan CONTENT is
// passed to the builder because an isolated worktree can't see the gitignored plan on the main tree.
// opts.deliverLock: serializes the deliver step across concurrent lanes.
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
    'and summary = one paragraph on WHAT you changed and why, written for a human reviewer and describing only what you actually did — it is quoted into the pull request body.',
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
      'Review per your role definition; run the tests yourself — no test results are provided on purpose. ' +
      'FIRST take every [machine] and [fixture] acceptance row in the ticket, run it, and report it in machineChecks with met true/false -- one entry per row, a reason on any false. An unmet row is disqualifying: BOUNCE, or escalate where the ticket contradicts itself. A Builder-documented blocker is NOT grounds for CLEAR. ' +
      'THEN WRITE YOUR OWN REVIEW RECORD to EXACTLY .claude/tmp/' + t.id + '-verdict.md — your findings, the commands you ran with their real output, and anything you could not verify. ' +
      (isolate ? 'That path is relative to the MAIN repository, not your worktree: get the main root with `git rev-parse --path-format=absolute --git-common-dir` and write under <that directory minus the trailing /.git>. A record written inside a throwaway worktree disappears with it. ' : '') +
      'Nobody else writes this file and nobody re-types it — it is posted on the pull request as YOUR words, and a verdict with no record is refused at delivery. Write it on BOUNCE as well as CLEAR, and return recordPath. ' +
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
      JSON.stringify(verdict.findings) + '. Run the tests. Return branch (must be ' + branch + '), testsPassed, testOutput, deviations.',
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

  // Delivery is a deterministic script, not agent judgment (catalog issues #26, #50, #58). The
  // agent only (1) writes the verdict, (2) composes the PR/MR body from the repo template, (3)
  // runs the one command. It never merges, pushes, opens PRs, or closes issues.
  const recordPath = '.claude/tmp/' + t.id + '-verdict.md'
  const bodyFile = '.claude/tmp/' + t.id + '-mrbody.md'
  const deliverCmd = 'node .claude/scripts/deliver-ticket.mjs --id ' + t.id + ' --branch ' + branch +
    ' --default-branch ' + cfg.defaultBranch + ' --platform ' + cfg.platform + (t.issue ? ' --issue ' + t.issue : '') +
    (cfg.testCmd ? ' --test-cmd "' + cfg.testCmd + '"' : ' --no-tests') + ' --verdict-file ' + recordPath + ' --body-file ' + bodyFile +
    // supervised already stops for a human merge, so the fallback is autonomous-only
    (cfg.mode !== 'supervised' && cfg.integrationBranch ? ' --integration-branch ' + cfg.integrationBranch : '') +
    (cfg.mode === 'supervised' ? ' --no-merge' : '')
  // The Reviewer wrote its own record. This stage VERIFIES it and points the script at
  // it; it never writes or summarises a verdict (catalog issues #201, #206). Delivery is
  // an executor here for a MECHANICAL reason — a workflow script has no filesystem and no
  // exec, so an agent is the only actor inside a run that can invoke a command — which is
  // the same reason the Codex pattern keeps its own delivery actuator.
  const deliverPrompt =
    'Delivery step. You are an EXECUTOR, not a judge: you (1) verify the Reviewer wrote its record, (2) compose the PR/MR body from the artifacts below, and (3) run one command. Never merge, push, open PRs/MRs, or close issues yourself. ' +
    'FIRST verify ' + recordPath + ' exists and is NOT empty. If it is missing or empty, STOP: return merged/issueClosed/dodPassed = false with that as the reason. Do NOT write it, do NOT summarise the verdict, do NOT substitute anything — the Reviewer authors that file and an unevidenced review must not become a merge. ' +
    'Next compose the PR/MR body and write it to ' + bodyFile + ': START from the repo\'s MR/PR template ' +
    '(.gitlab/merge_request_templates/default.md on GitLab, else .github/pull_request_template.md; if neither exists, write nothing and skip this file) and FILL its sections from the ticket ' + t.path +
    ', the diff (`git diff ' + cfg.defaultBranch + '...' + branch + '` — summarize, do not paste it whole), the Reviewer\'s record above (quote it; do not paraphrase it into an approval), and the repo CLAUDE.md non-negotiables for the **Constraint check** section (tick what the diff touches, mark the rest N/A). ' +
    'These facts are supplied because only this run holds them, and a body that reads complete but is partly invented is worse than one that admits a gap: BOUNCE cycles = ' + bounces + '; Builder-declared deviations = ' + JSON.stringify((build && build.deviations) || 'none declared') + '; Builder summary = ' + JSON.stringify((build && build.summary) || '(none returned)') + '. ' +
    'Any section you cannot fill from an artifact must say it is unavailable and why — never infer one. Include `Closes #' + (t.issue || '<n>') + '`. Do not invent spec the ticket lacks. ' +
    'Then, from the repo root, run EXACTLY this command and let it do all git and tracker work: ' + deliverCmd +
    ' — this is the only sanctioned delivery path. Parse the DELIVER-SUMMARY-JSON line it prints last and return ' +
    'merged, issueClosed, dodPassed, awaitingMerge, outcome, deliveredTo, and prUrl EXACTLY as reported there, with notes = its notes field plus anything unusual. ' +
    'If the command cannot run or prints no DELIVER-SUMMARY-JSON, return merged/issueClosed/dodPassed = false with the output tail in notes.'

  if (cfg.mode === 'supervised') {
    log('[' + t.id + '] CLEAR — supervised: opening a PR/MR for human review (deterministic deliver, --no-merge)')
    const delivery = await agent(deliverPrompt, { label: 'deliver:' + t.id, phase: P, schema: DELIVERY })
    if (delivery && delivery.awaitingMerge) {
      log('[' + t.id + '] PR/MR open for review: ' + (delivery.prUrl || '(url not reported)') + ' — merge it, then re-run to continue (closed issues are filtered out).')
      return { id: t.id, status: 'awaiting-human-merge', branch: branch, prUrl: delivery.prUrl || '', bounces: bounces, note: verdict.checkedNote || '' }
    }
    return { id: t.id, status: 'delivery-incomplete', detail: 'supervised PR/MR creation did not complete' + (delivery && delivery.notes ? ' — ' + delivery.notes : '') }
  }

  log('[' + t.id + '] deliver: PR/MR + forge-merge + close + DoD (deterministic script, serialized)')
  // deliver mutates the MAIN working tree (merge) — serialize it across concurrent lanes.
  const delivery = await deliverLock(function () { return agent(deliverPrompt, { label: 'deliver:' + t.id, phase: P, schema: DELIVERY }) })
  if (!delivery || !(delivery.merged && delivery.issueClosed && delivery.dodPassed)) {
    const missing = !delivery ? 'delivery agent returned nothing' : ['merged', 'issueClosed', 'dodPassed'].filter(function (k) { return !delivery[k] }).join(', ') + ' = false'
    return { id: t.id, status: 'delivery-incomplete', detail: missing + (delivery && delivery.notes ? ' — ' + delivery.notes : '') }
  }
  return { id: t.id, status: 'delivered', bounces: bounces, prUrl: delivery.prUrl || '' }
}

const results = []

if (concurrency === 1) {
  // ---- sequential path (default; behavior unchanged) ----
  let stopRun = false
  for (const t of cfg.tickets) {
    if (stopRun) continue
    const r = await runTicket(t, { isolate: false })
    results.push(r)
    if (r.status === 'awaiting-human-merge') { stopRun = true; continue } // supervised stop
    if (r.status !== 'delivered' && !cfg.continueOnFailure) { stopRun = true }
  }
} else {
  // ---- DAG-parallel path (autonomous): dispatch ready tickets up to `concurrency`,
  // each in isolated worktrees; deliver serialized; a failed ticket blocks its dependents.
  const deliverLock = makeLock()
  const state = new Map(cfg.tickets.map(function (t) { return [t.id, 'pending'] })) // pending|running|done|failed|skipped
  const resultById = new Map()
  const depsOf = function (t) { return (t.blockedBy || []).filter(function (d) { return ticketIds.has(d) }) } // only intra-run edges gate
  let active = 0

  await new Promise(function (resolve) {
    const settle = function (id, r) {
      resultById.set(id, r)
      state.set(id, r.status === 'delivered' ? 'done' : 'failed')
      active -= 1
      pump()
    }
    const pump = function () {
      // cascade: any pending ticket whose blocker failed/was skipped is skipped
      let changed = true
      while (changed) {
        changed = false
        for (const t of cfg.tickets) {
          if (state.get(t.id) !== 'pending') continue
          if (depsOf(t).some(function (d) { return state.get(d) === 'failed' || state.get(d) === 'skipped' })) {
            state.set(t.id, 'skipped')
            resultById.set(t.id, { id: t.id, status: 'skipped-dependency', detail: 'a blocker did not deliver' })
            changed = true
          }
        }
      }
      // dispatch ready pendings up to the concurrency cap
      for (const t of cfg.tickets) {
        if (active >= concurrency) break
        if (state.get(t.id) !== 'pending') continue
        if (!depsOf(t).every(function (d) { return state.get(d) === 'done' })) continue
        state.set(t.id, 'running')
        active += 1
        runTicket(t, { isolate: true, deliverLock: deliverLock }).then(
          function (r) { settle(t.id, r) },
          function (e) { settle(t.id, { id: t.id, status: 'failed', stage: 'lane', detail: 'lane threw: ' + (e && e.message ? e.message : String(e)) }) }
        )
      }
      if (active === 0) {
        // deadlock guard: pending tickets with no running lane to unblock them are unsatisfiable
        // (in-run cycle or a blocker missing from this run) — fail them loudly rather than hang.
        const stuck = cfg.tickets.filter(function (t) { return state.get(t.id) === 'pending' })
        for (const t of stuck) {
          state.set(t.id, 'failed')
          resultById.set(t.id, { id: t.id, status: 'failed', stage: 'schedule', detail: 'unsatisfiable in-run dependency (cycle or missing blocker)' })
        }
      }
      if (active === 0 && !Array.from(state.values()).some(function (s) { return s === 'pending' || s === 'running' })) {
        resolve()
      }
    }
    pump()
  })

  for (const t of cfg.tickets) if (resultById.has(t.id)) results.push(resultById.get(t.id))
}

const throughPipeline = results.filter(function (r) { return r.status === 'delivered' || r.status === 'awaiting-human-merge' }).length
log('milestone run finished: ' + throughPipeline + '/' + cfg.tickets.length + ' tickets through the pipeline (concurrency=' + concurrency + ')')

return {
  mode: cfg.mode,
  concurrency: concurrency,
  results: results,
  notStarted: cfg.tickets.length - results.length,
}
