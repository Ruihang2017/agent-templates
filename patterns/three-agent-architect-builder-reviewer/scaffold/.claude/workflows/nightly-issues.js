export const meta = {
  name: 'nightly-issues',
  description: 'Nightly sweep: triage open issues, run fixable ones through the three-agent pipeline, post the morning report',
  phases: [{ title: 'Triage' }, { title: 'Fix' }, { title: 'Report' }],
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
// Design: triage never touches the tracker; the pipeline (child run-milestone
// workflow) does the fixing with continueOnFailure=true (issues are independent,
// unlike milestone tickets); a single report step does ALL tracker writes at the
// end — comments, labels, and the "Nightly report <date>" issue the human reads
// over morning email (tracker notifications).

const cfg = Object.assign({ maxIssues: 5, defaultBranch: 'main', platform: 'gh' }, args)
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
const REPORT = {
  type: 'object',
  properties: { reportUrl: { type: 'string' }, notes: { type: 'string' } },
  required: ['reportUrl'],
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

// ---- Phase 2: fix via the milestone runner (child workflow, one nesting level) ----
let pipeline_results = []
if (fixable.length > 0) {
  const tickets = fixable.map(function (o) {
    return { id: 'ISS-' + o.issue.number, path: o.triage.ticketPath, issue: o.issue.number }
  })
  try {
    const child = await workflow('run-milestone', {
      tickets: tickets,
      mode: 'autonomous',
      defaultBranch: cfg.defaultBranch,
      platform: cfg.platform,
      continueOnFailure: true, // nightly issues are independent; one failure must not strand the rest
    })
    pipeline_results = (child && child.results) || []
  } catch (e) {
    log('pipeline failed to run: ' + (e && e.message ? e.message : String(e)))
    pipeline_results = tickets.map(function (t) { return { id: t.id, status: 'failed', stage: 'pipeline', detail: 'milestone runner did not run' } })
  }
}
const resultFor = function (issueNumber) {
  return pipeline_results.find(function (r) { return r.id === 'ISS-' + issueNumber }) || null
}

// ---- Phase 3: report (the ONLY tracker-writing step) ----
const digest = outcomes.map(function (o) {
  const r = resultFor(o.issue.number)
  return {
    number: o.issue.number,
    title: o.issue.title,
    isNew: Boolean(o.issue.isNew),
    classification: o.triage.classification,
    reason: o.triage.reason,
    pipeline: r ? { status: r.status, stage: r.stage || null, bounces: r.bounces || 0, detail: r.detail || null } : null,
  }
})

const report = await agent(
  'You are the nightly report step — the only step allowed to write to the tracker (' + cfg.platform + ' CLI via Bash). ' +
  'Process this digest of tonight\'s sweep (JSON): ' + JSON.stringify({ date: cfg.reportDate, digest: digest, notProcessed: eligible.length - candidates.length }) + '\n' +
  'Do, in order:\n' +
  '1. Per issue: post ONE comment stating the outcome — fixed (link the merge) / attempted-but-not-solved (why, findings) / needs-human (why) / invalid (why). Base every statement on the digest; fabricate nothing.\n' +
  '2. Labels: add `triage:invalid` to invalid issues (do NOT close them — the human decides in the morning); add `nightly:escalated` to attempted-but-not-solved and pipeline-failed issues; add `needs-human` to needs-human issues.\n' +
  '3. For issues whose pipeline status is `delivered`: verify the issue is actually closed; close it if the deliver step missed it.\n' +
  '4. Create a tracker issue titled exactly "Nightly report ' + cfg.reportDate + '" (search first; if it already exists, comment on it instead of duplicating) with sections: New overnight · Fixed & closed · Attempted, not solved · Needs human · Invalid (ignore) · Not processed (cap). Use issue references (#N) so the tracker links them.\n' +
  'Return reportUrl and notes (anything that went wrong).',
  { label: 'report:' + cfg.reportDate, phase: 'Report', schema: REPORT }
)

return {
  date: cfg.reportDate,
  processed: digest,
  notProcessed: eligible.length - candidates.length,
  fixed: digest.filter(function (d) { return d.pipeline && d.pipeline.status === 'delivered' }).length,
  reportUrl: report ? report.reportUrl : null,
  reportNotes: report ? report.notes : 'report step returned nothing',
}
