export const meta = {
  name: 'run-milestone',
  description: 'Autonomous milestone runner: each ticket flows architect -> builder -> reviewer (bounce-capped in code) -> deliver',
}

// Deterministic orchestrator for the three-agent pattern. Control flow that used to be
// prose ("max 2 bounces", "never merge without CLEAR") is enforced HERE, in code.
//
// args:
// {
//   tickets: [{ id: 'FND-01', path: 'docs/prd/01-foo/tickets/FND-01-x.md', issue: 12 }],
//   mode: 'supervised' | 'autonomous',
//   defaultBranch: 'main',        // optional, default 'main'
//   maxBounces: 2,                // optional, default 2
//   continueOnFailure: false,     // optional; default fail-fast (tickets may depend on earlier ones)
//   platform: 'gh' | 'glab',      // tracker CLI for the deliver step, default 'gh'
//   testCmd: 'npm test'           // optional; forwarded to deliver-ticket.mjs --test-cmd so the
//                                 // deterministic DoD re-runs tests on the merged default branch
// }
//
// Guarantees encoded below (each one exists because prose alone failed before):
// - reviewer prompts carry ONLY artifact refs (ticket path, computed plan path, branch name)
// - a reviewer infrastructure failure never consumes the bounce budget or dispatches a fix
// - nothing counts as delivered unless merged AND issueClosed AND dodPassed are all true
// - supervised mode STOPS the run after each CLEAR (later tickets may depend on the merge);
//   re-running /start-milestone continues — already-closed issues are filtered out upstream

// args may arrive as a JSON string depending on the harness (catalog issue #23)
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {})
const cfg = Object.assign(
  { maxBounces: 2, continueOnFailure: false, defaultBranch: 'main', platform: 'gh' },
  parsedArgs
)
if (!Array.isArray(cfg.tickets) || cfg.tickets.length === 0) {
  throw new Error('args.tickets must be a non-empty array of {id, path, issue}')
}
for (const t of cfg.tickets) {
  if (!t || typeof t.id !== 'string' || !t.id || typeof t.path !== 'string' || !t.path) {
    throw new Error('every ticket needs a non-empty string id and path; got: ' + JSON.stringify(t))
  }
  // the id is composed into branch names and the deliver command — keep it boring
  if (!/^[A-Za-z0-9._-]+$/.test(t.id)) {
    throw new Error('ticket id must match [A-Za-z0-9._-]+; got: ' + t.id)
  }
}
if (cfg.mode !== 'supervised' && cfg.mode !== 'autonomous') {
  throw new Error("args.mode must be 'supervised' or 'autonomous'")
}
if (cfg.testCmd !== undefined && (typeof cfg.testCmd !== 'string' || !cfg.testCmd || cfg.testCmd.includes('"'))) {
  throw new Error('args.testCmd must be a non-empty string without double quotes when provided')
}
if (!Number.isInteger(cfg.maxBounces) || cfg.maxBounces < 0) {
  throw new Error('args.maxBounces must be an integer >= 0')
}
if (typeof cfg.defaultBranch !== 'string' || !cfg.defaultBranch) throw new Error('args.defaultBranch must be a non-empty string')
if (cfg.platform !== 'gh' && cfg.platform !== 'glab') throw new Error("args.platform must be 'gh' or 'glab'")

const PLAN = {
  type: 'object',
  properties: { planPath: { type: 'string' }, summary: { type: 'string' } },
  required: ['planPath', 'summary'],
}
const BUILD = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    testsPassed: { type: 'boolean' },
    testOutput: { type: 'string' },
    deviations: { type: 'string' },
  },
  required: ['branch', 'testsPassed', 'testOutput'],
}
const VERDICT = {
  type: 'object',
  properties: {
    verdict: { enum: ['CLEAR', 'BOUNCE'] },
    checkedNote: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          scenario: { type: 'string' },
          severity: { enum: ['blocker', 'major', 'minor'] },
        },
        required: ['file', 'scenario', 'severity'],
      },
    },
  },
  required: ['verdict'],
}
const DELIVERY = {
  type: 'object',
  properties: {
    merged: { type: 'boolean' },
    issueClosed: { type: 'boolean' },
    dodPassed: { type: 'boolean' },
    awaitingMerge: { type: 'boolean' },
    prUrl: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['merged', 'issueClosed', 'dodPassed'],
}

const normalizePath = function (p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

const results = []
let stopRun = false

for (const t of cfg.tickets) {
  if (stopRun) break
  const P = 'T:' + t.id
  const branch = 'ticket/' + t.id
  const planPath = 'docs/plans/' + t.id + '.md' // computed in code; agent-returned paths are verified, never trusted

  log('[' + t.id + '] architect: planning')
  const plan = await agent(
    'You are running as the Architect stage of the three-agent pattern. Ticket file: ' + t.path +
    '. Produce the implementation plan per your role definition and write it to EXACTLY ' + planPath +
    '. Return planPath (must be ' + planPath + ') and a one-paragraph summary.',
    { agentType: 'architect', label: 'plan:' + t.id, phase: P, schema: PLAN }
  )
  if (!plan || normalizePath(plan.planPath) !== planPath) {
    results.push({ id: t.id, status: 'failed', stage: 'architect', detail: plan ? 'plan written to unexpected path: ' + plan.planPath : 'architect agent returned nothing' })
    if (!cfg.continueOnFailure) break
    continue
  }

  log('[' + t.id + '] builder: implementing on ' + branch)
  let build = await agent(
    'Builder stage. Ticket: ' + t.path + '. Plan: ' + planPath + '. Create branch ' + branch +
    ' from ' + cfg.defaultBranch + ', implement the plan there, commit, run the tests. Do NOT merge and do NOT touch the tracker. ' +
    'Return branch (must be ' + branch + '), testsPassed, testOutput (paste real output), deviations.',
    { agentType: 'builder', label: 'build:' + t.id, phase: P, schema: BUILD }
  )
  const buildBad = function (b) { return !b || !b.testsPassed || String(b.branch).trim() !== branch }
  if (buildBad(build)) {
    results.push({
      id: t.id, status: 'failed', stage: 'builder',
      detail: !build ? 'builder agent returned nothing' : (String(build.branch).trim() !== branch ? 'worked on wrong branch: ' + build.branch : build.testOutput),
    })
    if (!cfg.continueOnFailure) break
    continue
  }

  // Review loop — the bounce cap lives here, in code, not in prose.
  const reviewOnce = function (tag) {
    return agent(
      'Reviewer stage. Inputs (artifact refs only): ticket ' + t.path + ', plan ' + planPath +
      ', diff = branch ' + branch + ' vs ' + cfg.defaultBranch + '. Review per your role definition; ' +
      'run the tests yourself — no test results are provided on purpose. Return verdict CLEAR or BOUNCE with findings ' +
      '(a BOUNCE with zero findings is invalid).',
      { agentType: 'reviewer', label: 'review:' + t.id + '#' + tag, phase: P, schema: VERDICT }
    )
  }
  // A null/invalid reviewer result is an infrastructure failure, not a code finding:
  // retry once (not counted against the bounce budget), then escalate — never sent to the builder.
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
      'Builder stage, bounce fix. Ticket: ' + t.path + '. Plan: ' + planPath + '. Stay on branch ' + branch +
      ' — do NOT merge and do NOT touch the tracker. Reviewer findings — address ALL of them and add regression tests: ' +
      JSON.stringify(verdict.findings) + '. Run the tests. Return branch (must be ' + branch + '), testsPassed, testOutput, deviations.',
      { agentType: 'builder', label: 'fix:' + t.id + '#' + bounces, phase: P, schema: BUILD }
    )
    if (buildBad(build)) { fixBroken = true; break }
    verdict = await reviewOnce(String(bounces))
    if (!reviewValid(verdict)) { log('[' + t.id + '] reviewer returned no usable verdict — retrying once'); verdict = await reviewOnce(bounces + '-retry') }
    reviewerBroken = !reviewValid(verdict)
  }

  if (reviewerBroken || fixBroken || verdict.verdict !== 'CLEAR') {
    const stage = reviewerBroken ? 'reviewer-failed' : (fixBroken ? 'bounce-fix-build' : 'review')
    results.push({
      id: t.id, status: 'escalated', stage: stage, bounces: bounces,
      findings: reviewValid(verdict) ? (verdict.findings || []) : [],
      detail: fixBroken ? (!build ? 'fix builder returned nothing' : (String(build.branch).trim() !== branch ? 'fix worked on wrong branch: ' + build.branch : build.testOutput)) : (reviewerBroken ? 'reviewer produced no usable verdict after one retry' : 'bounce cap exhausted'),
    })
    log('[' + t.id + '] escalated to a human (stage: ' + stage + ', after ' + bounces + ' bounce(s))')
    if (!cfg.continueOnFailure) break
    continue
  }

  // Delivery is a deterministic script, not agent judgment (catalog issues #26, #50):
  // harness safety classifiers blocked agent-run merges even after a journaled CLEAR.
  // The agent below only (1) writes the Reviewer's verdict to a file so the script can
  // post it as the PR/MR comment (the durable review trail #50 asked for), and (2) runs
  // the one sanctioned command. It never merges, pushes, opens PRs, or closes issues.
  const verdictNote = verdict && verdict.checkedNote ? verdict.checkedNote : 'CLEAR (the reviewer returned no note text)'
  const verdictFile = '.claude/tmp/' + t.id + '-verdict.md'
  const bodyFile = '.claude/tmp/' + t.id + '-mrbody.md'
  const deliverCmd = 'node .claude/scripts/deliver-ticket.mjs --id ' + t.id + ' --branch ' + branch +
    ' --default-branch ' + cfg.defaultBranch + ' --platform ' + cfg.platform + (t.issue ? ' --issue ' + t.issue : '') +
    (cfg.testCmd ? ' --test-cmd "' + cfg.testCmd + '"' : '') + ' --verdict-file ' + verdictFile + ' --body-file ' + bodyFile +
    (cfg.mode === 'supervised' ? ' --no-merge' : '')
  const deliverPrompt =
    'Delivery step. Delivery is DETERMINISTIC — you only (1) record the verdict, (2) compose the PR/MR body, and (3) run one command; never merge, push, open PRs/MRs, or close issues yourself. ' +
    'First write the following Reviewer CLEAR verdict text VERBATIM to ' + verdictFile + ' (create the .claude/tmp directory if needed):\n' +
    '<<<VERDICT\n' + verdictNote + '\nVERDICT\n' +
    'Next compose the PR/MR body and write it to ' + bodyFile + ': START from the repo\'s MR/PR template ' +
    '(.gitlab/merge_request_templates/default.md on GitLab, else .github/pull_request_template.md; if neither exists, write nothing and skip this file) and FILL its sections from the ticket ' + t.path +
    ', the diff (`git diff ' + cfg.defaultBranch + '...' + branch + '` — summarize, do not paste it whole), the CLEAR verdict above, and the repo CLAUDE.md non-negotiables for the **Constraint check** section (tick what the diff touches, mark the rest N/A). Include `Closes #' + (t.issue || '<n>') + '`. Do not invent spec the ticket lacks. ' +
    'Then, from the repo root, run EXACTLY this command and let it do all git and tracker work: ' + deliverCmd +
    ' — this is the only sanctioned delivery path. Parse the DELIVER-SUMMARY-JSON line it prints last and return ' +
    'merged, issueClosed, dodPassed, awaitingMerge, and prUrl EXACTLY as reported there, with notes = its notes field plus anything unusual. ' +
    'If the command cannot run or prints no DELIVER-SUMMARY-JSON, return merged/issueClosed/dodPassed = false with the output tail in notes.'

  if (cfg.mode === 'supervised') {
    log('[' + t.id + '] CLEAR — supervised: opening a PR/MR for human review (deterministic deliver, --no-merge)')
    const delivery = await agent(deliverPrompt, { label: 'deliver:' + t.id, phase: P, schema: DELIVERY })
    if (delivery && delivery.awaitingMerge) {
      results.push({ id: t.id, status: 'awaiting-human-merge', branch: branch, prUrl: delivery.prUrl || '', bounces: bounces, note: verdict.checkedNote || '' })
      log('[' + t.id + '] PR/MR open for review: ' + (delivery.prUrl || '(url not reported)') + ' — merge it, then re-run to continue (closed issues are filtered out).')
    } else {
      results.push({ id: t.id, status: 'delivery-incomplete', detail: 'supervised PR/MR creation did not complete' + (delivery && delivery.notes ? ' — ' + delivery.notes : '') })
    }
    stopRun = true
    continue
  }

  log('[' + t.id + '] deliver: PR/MR + forge-merge + close + DoD (deterministic script)')
  const delivery = await agent(deliverPrompt, { label: 'deliver:' + t.id, phase: P, schema: DELIVERY })
  // Delivered requires ALL THREE flags — a hallucinated dodPassed alone must not count.
  if (!delivery || !(delivery.merged && delivery.issueClosed && delivery.dodPassed)) {
    const missing = !delivery ? 'delivery agent returned nothing' : ['merged', 'issueClosed', 'dodPassed'].filter(function (k) { return !delivery[k] }).join(', ') + ' = false'
    results.push({ id: t.id, status: 'delivery-incomplete', detail: missing + (delivery && delivery.notes ? ' — ' + delivery.notes : '') })
    if (!cfg.continueOnFailure) break
    continue
  }
  results.push({ id: t.id, status: 'delivered', bounces: bounces, prUrl: delivery.prUrl || '' })
}

const throughPipeline = results.filter(function (r) { return r.status === 'delivered' || r.status === 'awaiting-human-merge' }).length
log('milestone run finished: ' + throughPipeline + '/' + cfg.tickets.length + ' tickets through the pipeline')

return {
  mode: cfg.mode,
  results: results,
  notStarted: cfg.tickets.length - results.length, // > 0 means the run stopped early (fail-fast or supervised pause)
}
