export const meta = {
  name: 'nightly-issues',
  description: 'Nightly sweep: triage open issues and run the fixable ones through the three-agent pipeline. Delivery and the morning report belong to the caller.',
  phases: [{ title: 'Triage' }, { title: 'Fix' }],
}

// Deterministic nightly orchestrator. The command (/nightly-issues) collects the
// issue list and date (Date is unavailable in workflow scripts) and passes:
//
// args:
// {
//   issues: [{ number, title, body, labels: [..], isNew: bool, url }],
//   maxIssues: 5,                 // optional cost cap per night
//   defaultBranch: 'main',        // optional
//   platform: 'gh' | 'glab',      // default 'gh'
//   reportDate: 'YYYY-MM-DD',     // required — stamped by the caller
// }
//
// Design: triage never touches the tracker; the pipeline (child run-wave workflow)
// plans, implements and reviews. Nothing here merges, closes or comments.
//
// Delivery and the morning report are the CALLER's (catalog issue #206). A workflow
// script has no filesystem and no exec, so the only actor inside one that could run
// deliver-ticket.mjs was an agent with no judgement to make — and the tracker writes
// were a second such agent. Both are gone: /nightly-issues delivers the cleared
// tickets with deliver-wave.mjs and posts the report itself, from the digest below.
//
// Nightly issues are INDEPENDENT of one another, so they form exactly one wave — the
// wave loop that /start-all runs collapses to a single pass here.

// args may arrive as a JSON string depending on the harness (catalog issue #23)
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {})
const cfg = Object.assign({ maxIssues: 5, defaultBranch: 'main', platform: 'gh' }, parsedArgs)
if (!Array.isArray(cfg.issues)) throw new Error('args.issues must be an array (may be empty)')
if (typeof cfg.reportDate !== 'string' || !cfg.reportDate) throw new Error('args.reportDate is required (the caller stamps the date)')
if (!Number.isInteger(cfg.maxIssues) || cfg.maxIssues < 1) throw new Error('args.maxIssues must be an integer >= 1')
if (cfg.platform !== 'gh' && cfg.platform !== 'glab') throw new Error("args.platform must be 'gh' or 'glab'")

const SKIP_LABELS = ['nightly:escalated', 'triage:invalid', 'needs-human']
const eligible = cfg.issues.filter(function (i) {
  return i && Number.isInteger(i.number) && !(i.labels || []).some(function (l) { return SKIP_LABELS.includes(l) })
})
const candidates = eligible.slice(0, cfg.maxIssues)
if (eligible.length > candidates.length) {
  log('cap: processing ' + candidates.length + '/' + eligible.length + ' eligible issues (maxIssues=' + cfg.maxIssues + '); the rest wait for the next night')
}

const TRIAGE = {
  type: 'object',
  properties: {
    classification: { enum: ['fixable', 'invalid', 'needs-human'] },
    reason: { type: 'string' },
    ticketPath: { type: 'string' },
  },
  required: ['classification', 'reason'],
}

// ---- Phase 1: triage (parallel, read-only + ticket synthesis) ----
const triaged = await parallel(candidates.map(function (issue) {
  return function () {
    return agent(
      'Triage this tracker issue per your role definition.\n' +
      'Issue #' + issue.number + ': ' + issue.title + '\n' +
      'Labels: ' + JSON.stringify(issue.labels || []) + '\n' +
      'Body:\n' + (issue.body || '(empty)') + '\n\n' +
      'If fixable, the ticket file MUST be docs/prd/99-nightly/tickets/ISS-' + issue.number + '-<slug>.md with id ISS-' + issue.number + '.',
      { agentType: 'triage', label: 'triage:#' + issue.number, phase: 'Triage', schema: TRIAGE }
    ).then(function (t) {
      return { issue: issue, triage: t || { classification: 'needs-human', reason: 'triage agent returned nothing' } }
    })
  }
}))
const outcomes = triaged.filter(Boolean)

const fixable = outcomes.filter(function (o) { return o.triage.classification === 'fixable' && o.triage.ticketPath })
for (const o of outcomes) {
  if (o.triage.classification === 'fixable' && !o.triage.ticketPath) {
    o.triage.classification = 'needs-human'
    o.triage.reason = 'classified fixable but returned no ticket path — ' + o.triage.reason
  }
}
log('triage: ' + fixable.length + ' fixable, ' +
  outcomes.filter(function (o) { return o.triage.classification === 'invalid' }).length + ' invalid, ' +
  outcomes.filter(function (o) { return o.triage.classification === 'needs-human' }).length + ' needs-human')

// ---- Phase 2: fix via the wave runner (child workflow, one nesting level) ----
let pipeline_results = []
if (fixable.length > 0) {
  const tickets = fixable.map(function (o) {
    return { id: 'ISS-' + o.issue.number, path: o.triage.ticketPath, issue: o.issue.number }
  })
  try {
    // One wave: every nightly ticket is independent, so none blocks another and a
    // single failure cannot strand the rest. `blockedBy` is deliberately absent — a
    // triage-synthesised ticket that declared a dependency would be refused by the
    // wave guard, which is the correct outcome rather than a silent reorder.
    const child = await workflow('run-wave', {
      tickets: tickets,
      defaultBranch: cfg.defaultBranch,
      concurrency: 1,
      waveNumber: 1,
    })
    pipeline_results = (child && child.results) || []
  } catch (e) {
    log('pipeline failed to run: ' + (e && e.message ? e.message : String(e)))
    pipeline_results = tickets.map(function (t) { return { id: t.id, status: 'failed', stage: 'pipeline', detail: 'the wave runner did not run' } })
  }
}
const resultFor = function (issueNumber) {
  return pipeline_results.find(function (r) { return r.id === 'ISS-' + issueNumber }) || null
}

// ---- Phase 3: hand the digest back. NOTHING here writes to the tracker ----
// The report used to be an agent inside this workflow, running AFTER delivery. Both moved
// out together and for the same reason: the caller is the only actor that can deliver, so
// it is also the only actor that knows what actually landed. A report composed here would
// be describing merges that had not happened yet.
const digest = outcomes.map(function (o) {
  const r = resultFor(o.issue.number)
  return {
    number: o.issue.number,
    title: o.issue.title,
    url: o.issue.url || '',
    isNew: Boolean(o.issue.isNew),
    classification: o.triage.classification,
    reason: o.triage.reason,
    ticketPath: o.triage.ticketPath || null,
    // `reviewed-clear` is NOT `fixed`. It means a Reviewer cleared the work and nothing has
    // been merged or closed — the caller decides that after deliver-wave.mjs reports.
    pipeline: r
      ? {
          status: r.status,
          stage: r.stage || null,
          bounces: r.bounces || 0,
          detail: r.detail || null,
          branch: r.branch || null,
          recordPath: r.recordPath || null,
          issue: r.issue || o.issue.number,
          path: r.path || null,
          buildSummary: r.buildSummary || '',
          deviations: r.deviations || '',
          testOutput: r.testOutput || '',
        }
      : null,
  }
})

const clearedCount = digest.filter(function (d) { return d.pipeline && d.pipeline.status === 'reviewed-clear' }).length
log('sweep finished: ' + clearedCount + ' ticket(s) reviewed CLEAR and awaiting delivery by the caller')

return {
  date: cfg.reportDate,
  processed: digest,
  notProcessed: eligible.length - candidates.length,
  // Named so it cannot be mistaken for a delivery count. Nothing merged, nothing closed,
  // no comment posted — the caller must run deliver-wave.mjs and then report.
  reviewedClear: clearedCount,
  // Ready to hand straight to deliver-wave.mjs once the caller adds each bodyFile.
  waveResults: pipeline_results,
}
