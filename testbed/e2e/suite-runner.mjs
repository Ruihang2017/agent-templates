// E2E for the deterministic milestone runner: loads the ACTUAL scaffold
// run-milestone.js, executes it with stubbed agent()/log() (the same wrapping the
// Workflow runtime applies), and asserts the orchestration guarantees the pattern
// documents — bounce cap, reviewer-failure handling, delivery gating, supervised
// stop, prompt isolation. Zero tokens, zero network.

import { readFileSync } from 'node:fs'
import { check, eq } from './lib.mjs'

const S = 'runner'
const SRC_URL = new URL(
  '../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/workflows/run-milestone.js',
  import.meta.url
)
const body = readFileSync(SRC_URL, 'utf8').replace('export const meta', 'const meta')

async function runWorkflow(args, respond) {
  const calls = []
  const logs = []
  const agent = async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label || '' }
    calls.push(call)
    return respond(call, calls)
  }
  const parallel = async (thunks) => Promise.all(thunks.map((f) => f().catch(() => null)))
  const fn = new Function(
    'agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget',
    `"use strict"; return (async () => { ${body}\n })()`
  )
  let result = null
  let error = null
  try {
    result = await fn(agent, parallel, null, (m) => logs.push(m), () => {}, args, {
      total: null, spent: () => 0, remaining: () => Infinity,
    })
  } catch (e) {
    error = e
  }
  return { result, calls, logs, error }
}

// Canned stage responses
const plan = (id) => ({ planPath: `docs/plans/${id}.md`, summary: 'ok' })
const goodBuild = (id) => ({ branch: `ticket/${id}`, testsPassed: true, testOutput: 'SENTINEL_TEST_OUTPUT green', deviations: 'SENTINEL_DEVIATIONS none' })
const CLEAR = { verdict: 'CLEAR', checkedNote: 'checked edge cases' }
const BOUNCE = { verdict: 'BOUNCE', findings: [{ file: 'src/x.mjs', scenario: 'SENTINEL_FINDING edge missed', severity: 'major' }] }
const goodDelivery = { merged: true, issueClosed: true, dodPassed: true, notes: '' }

const tickets2 = [
  { id: 'T-01', path: 'docs/prd/00-m/tickets/T-01.md', issue: 1 },
  { id: 'T-02', path: 'docs/prd/00-m/tickets/T-02.md', issue: 2 },
]
// noTests: this suite is about ORCHESTRATION, not the test policy. Since catalog issue
// #205 a run must declare one or refuse to start, so saying so keeps the subject under
// test the subject under test. S13 covers testCmd itself.
const baseArgs = { tickets: tickets2, mode: 'autonomous', defaultBranch: 'main', platform: 'gh', noTests: true }
const kind = (label) => label.split(':')[0]
const tid = (label) => (label.split(':')[1] || '').split('#')[0]

export async function run() {
  // S1: happy path, autonomous, 2 tickets
  {
    const { result, calls, error } = await runWorkflow(baseArgs, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'review') return CLEAR
      if (kind(label) === 'deliver') return goodDelivery
      return null
    })
    check(S, 'S1 no error', !error, error && error.message)
    eq(S, 'S1 statuses', result && result.results.map((r) => r.status), ['delivered', 'delivered'])
    eq(S, 'S1 notStarted', result && result.notStarted, 0)
    eq(S, 'S1 per-ticket call sequence', calls.slice(0, 4).map((c) => kind(c.label)), ['plan', 'build', 'review', 'deliver'])
    // issue #26: delivery is a deterministic script; the agent only executes it
    const dcall = calls.find((c) => kind(c.label) === 'deliver')
    check(S, 'S1 deliver prompt invokes deliver-ticket.mjs with exact args', !!dcall && dcall.prompt.includes('node .claude/scripts/deliver-ticket.mjs --id T-01 --branch ticket/T-01 --default-branch main --platform gh --issue 1'))
    // issue #50: the verdict is forwarded to the script (for the PR/MR comment); autonomous never passes --no-merge
    check(S, 'S1 deliver forwards the verdict file', !!dcall && dcall.prompt.includes('--verdict-file .claude/tmp/T-01-verdict.md'))
    // #201: nothing may re-type a verdict. The Reviewer writes its own record; this stage
    // VERIFIES it. The previous assertion here required the opposite and therefore pinned
    // the defect in place — an assertion that locks in a bug is part of the bug.
    check(S, 'S1 deliver is NOT told to write the verdict', !!dcall && !/VERBATIM/.test(dcall.prompt))
    check(S, 'S1 deliver verifies the record instead', !!dcall && /verify .*-verdict\.md exists and is NOT empty/i.test(dcall.prompt))
    check(S, 'S1 deliver is forbidden from substituting for a missing record',
      !!dcall && /Do NOT write it, do NOT summarise the verdict/.test(dcall.prompt))
    check(S, 'S1 deliver stops rather than delivering an unevidenced review',
      !!dcall && /unevidenced review must not become a merge/.test(dcall.prompt))
    // #193: the body needs facts only the run holds. They are SUPPLIED, and anything not
    // supplied must be declared unavailable rather than guessed.
    check(S, 'S1 deliver is given the bounce count', !!dcall && /BOUNCE cycles = 0/.test(dcall.prompt))
    check(S, 'S1 deliver is given the declared deviations', !!dcall && dcall.prompt.includes('SENTINEL_DEVIATIONS'))
    check(S, 'S1 deliver must not infer a missing fact', !!dcall && /never infer one/.test(dcall.prompt))
    check(S, 'S1 autonomous deliver does NOT pass --no-merge', !!dcall && !dcall.prompt.includes('--no-merge'))
    // issue #58: the deliver agent composes the MR/PR body from the repo template + fills Constraint check
    check(S, 'S1 deliver forwards a composed --body-file', !!dcall && dcall.prompt.includes('--body-file .claude/tmp/T-01-mrbody.md'))
    check(S, 'S1 deliver composes body from the repo template + Constraint check', !!dcall && /merge_request_templates|pull_request_template/.test(dcall.prompt) && dcall.prompt.includes('Constraint check'))
  }

  // S1b: the Reviewer AUTHORS its own record (catalog issues #201, #206, #208).
  // This is the whole fix for #201 — the reported harm was a verdict crossing a context
  // boundary and being re-typed, not the existence of a delivery stage.
  {
    const { result, calls } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'review') return CLEAR
      if (kind(label) === 'deliver') return goodDelivery
      return null
    })
    const rev = calls.find((c) => kind(c.label) === 'review')
    check(S, 'S1b the reviewer is told to write its OWN record', !!rev && /WRITE YOUR OWN REVIEW RECORD/.test(rev.prompt))
    check(S, 'S1b at the exact path delivery will read', !!rev && rev.prompt.includes('.claude/tmp/T-01-verdict.md'))
    check(S, 'S1b told nobody re-types it', !!rev && /nobody re-types it/.test(rev.prompt))
    check(S, 'S1b told to write it on BOUNCE too', !!rev && /on BOUNCE as well as CLEAR/.test(rev.prompt))
    // The stub is what made the transcription possible at all: a missing note became
    // 'CLEAR (the reviewer returned no note text)', written to disk as if the Reviewer
    // had said it. It must not exist anywhere in either scheduler.
    const src = readFileSync(SRC_URL, 'utf8')
    check(S, 'S1b no "returned no note text" stub survives', !/returned no note text/.test(src))
    check(S, 'S1b the schema carries a record PATH, not verdict text', /recordPath: \{ type: 'string' \}/.test(src))
    check(S, 'S1b delivery is documented as an executor, not a judge',
      /You are an EXECUTOR, not a judge/.test(calls.find((c) => kind(c.label) === 'deliver').prompt))
    eq(S, 'S1b the ticket still delivers', result && result.results[0].status, 'delivered')
  }

  // S2: bounce once, then clear; fix prompt carries findings + no-merge guard
  {
    let reviews = 0
    const { result, calls, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build' || kind(label) === 'fix') return goodBuild(tid(label))
      if (kind(label) === 'review') return reviews++ === 0 ? BOUNCE : CLEAR
      if (kind(label) === 'deliver') return goodDelivery
      return null
    })
    check(S, 'S2 no error', !error, error && error.message)
    eq(S, 'S2 delivered with bounces=1', result && result.results[0] && [result.results[0].status, result.results[0].bounces], ['delivered', 1])
    const fix = calls.find((c) => kind(c.label) === 'fix')
    check(S, 'S2 fix dispatched with findings', fix && fix.prompt.includes('SENTINEL_FINDING'))
    check(S, 'S2 fix prompt keeps no-merge guard', fix && fix.prompt.includes('do NOT merge'))
    // prompt isolation: no reviewer prompt may carry builder output
    const reviewsCalls = calls.filter((c) => kind(c.label) === 'review')
    check(S, 'S2 reviewer isolation (no test output/deviations leak)', reviewsCalls.every((c) => !c.prompt.includes('SENTINEL_TEST_OUTPUT') && !c.prompt.includes('SENTINEL_DEVIATIONS')))
  }

  // S3: bounce cap exhausted -> escalated stage review; fail-fast stops ticket 2
  {
    const { result, calls, error } = await runWorkflow(baseArgs, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build' || kind(label) === 'fix') return goodBuild(tid(label))
      if (kind(label) === 'review') return BOUNCE
      return null
    })
    check(S, 'S3 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    eq(S, 'S3 escalated at cap', r0 && [r0.status, r0.stage, r0.bounces], ['escalated', 'review', 2])
    eq(S, 'S3 fail-fast leaves ticket 2 unstarted', result && result.notStarted, 1)
    eq(S, 'S3 exactly 2 fixes dispatched', calls.filter((c) => kind(c.label) === 'fix').length, 2)
  }

  // S4: reviewer returns null twice -> reviewer-failed, no fix dispatched
  {
    const { result, calls, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'review') return null
      return null
    })
    check(S, 'S4 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    eq(S, 'S4 escalated reviewer-failed, zero bounces', r0 && [r0.status, r0.stage, r0.bounces], ['escalated', 'reviewer-failed', 0])
    eq(S, 'S4 review retried exactly once', calls.filter((c) => kind(c.label) === 'review').length, 2)
    eq(S, 'S4 no fix dispatched', calls.filter((c) => kind(c.label) === 'fix').length, 0)
  }

  // S5: hallucinated DoD (dodPassed true but merged/issueClosed false) must not count
  {
    const { result, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'review') return CLEAR
      if (kind(label) === 'deliver') return { merged: false, issueClosed: false, dodPassed: true, notes: 'looks fine' }
      return null
    })
    check(S, 'S5 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    check(S, 'S5 delivery-incomplete despite dodPassed', r0 && r0.status === 'delivery-incomplete')
    check(S, 'S5 detail names the false flags', r0 && /merged/.test(r0.detail) && /issueClosed/.test(r0.detail))
  }

  // S6: supervised opens a PR/MR (deliver --no-merge) then stops the run (issue #50)
  {
    const { result, calls, error } = await runWorkflow({ ...baseArgs, mode: 'supervised' }, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'review') return CLEAR
      if (kind(label) === 'deliver') return { merged: false, issueClosed: false, dodPassed: false, awaitingMerge: true, prUrl: 'https://github.com/acme/repo/pull/7' }
      return null
    })
    check(S, 'S6 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    eq(S, 'S6 awaiting-human-merge', r0 && r0.status, 'awaiting-human-merge')
    eq(S, 'S6 prUrl passed through to the report', r0 && r0.prUrl, 'https://github.com/acme/repo/pull/7')
    eq(S, 'S6 run stopped (ticket 2 unstarted)', result && result.notStarted, 1)
    const dcalls = calls.filter((c) => kind(c.label) === 'deliver')
    eq(S, 'S6 supervised calls deliver exactly once', dcalls.length, 1)
    check(S, 'S6 supervised deliver passes --no-merge', dcalls[0] && dcalls[0].prompt.includes('--no-merge'))
  }

  // S7: builder on the wrong branch = builder failure
  {
    const { result, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return { branch: 'oops/wrong', testsPassed: true, testOutput: 'green', deviations: '' }
      return null
    })
    check(S, 'S7 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    check(S, 'S7 failed at builder with wrong-branch detail', r0 && r0.status === 'failed' && r0.stage === 'builder' && /wrong branch/.test(r0.detail))
  }

  // S8: config validation throws
  {
    const bad = await runWorkflow({ ...baseArgs, mode: 'yolo' }, () => null)
    // catalog issue #205: a run whose Definition of Done cannot certify tests must not
    // START. The reporting adopter discovered this after 32 tickets had delivered with the
    // "tests green" item never evaluated — the answer was knowable at Gate 1 and nowhere
    // cheaper. Both the omission and the explicit waiver are asserted, because a guard that
    // cannot be satisfied is just an outage.
    {
      const { error } = await runWorkflow({ tickets: tickets2, mode: 'autonomous', defaultBranch: 'main', platform: 'gh' }, ({ label }) => { if (kind(label) === 'plan') return plan(tid(label)); if (kind(label) === 'build' || kind(label) === 'fix') return goodBuild(tid(label)); if (kind(label) === 'review') return CLEAR; if (kind(label) === 'deliver') return goodDelivery; return null })
      check(S, 'S8b a run with neither testCmd nor noTests REFUSES to start', !!error)
      check(S, 'S8b and the error says how to satisfy it', !!error && /noTests: true/.test(error.message) && /CLAUDE.md/.test(error.message))
    }
    {
      const { error } = await runWorkflow({ tickets: tickets2, mode: 'autonomous', defaultBranch: 'main', platform: 'gh', noTests: true }, ({ label }) => { if (kind(label) === 'plan') return plan(tid(label)); if (kind(label) === 'build' || kind(label) === 'fix') return goodBuild(tid(label)); if (kind(label) === 'review') return CLEAR; if (kind(label) === 'deliver') return goodDelivery; return null })
      check(S, 'S8b an explicit waiver starts normally', !error, error && error.message)
    }
    {
      const { calls, error } = await runWorkflow({ ...baseArgs, noTests: true }, ({ label }) => { if (kind(label) === 'plan') return plan(tid(label)); if (kind(label) === 'build' || kind(label) === 'fix') return goodBuild(tid(label)); if (kind(label) === 'review') return CLEAR; if (kind(label) === 'deliver') return goodDelivery; return null })
      const d = calls.find((c) => kind(c.label) === 'deliver')
      check(S, 'S8b the waiver is FORWARDED to the delivery script', !error && !!d && d.prompt.includes('--no-tests'))
    }

    check(S, 'S8 bad mode throws', bad.error && /mode/.test(bad.error.message))
    const badBounce = await runWorkflow({ ...baseArgs, maxBounces: undefined }, () => null)
    check(S, 'S8 explicit undefined maxBounces throws', badBounce.error && /maxBounces/.test(badBounce.error.message))
    const badTicket = await runWorkflow({ ...baseArgs, tickets: [{ id: 'X' }] }, () => null)
    check(S, 'S8 ticket without path throws', badTicket.error && /ticket/.test(badTicket.error.message))
  }

  // S9: architect writing to an unexpected path = architect failure
  {
    const { result, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, ({ label }) => {
      if (kind(label) === 'plan') return { planPath: 'somewhere/else.md', summary: 'ok' }
      return null
    })
    check(S, 'S9 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    check(S, 'S9 failed at architect with path detail', r0 && r0.status === 'failed' && r0.stage === 'architect' && /unexpected path/.test(r0.detail))
  }

  // S10: BOUNCE with zero findings = reviewer failure (never a zero-guidance fix cycle)
  {
    const { result, calls, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'review') return { verdict: 'BOUNCE' }
      return null
    })
    check(S, 'S10 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    eq(S, 'S10 escalated reviewer-failed', r0 && [r0.status, r0.stage], ['escalated', 'reviewer-failed'])
    eq(S, 'S10 no fix dispatched', calls.filter((c) => kind(c.label) === 'fix').length, 0)
  }

  // S11: fix build fails -> escalated with bounce-fix-build stage and real detail
  {
    let builds = 0
    const { result, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'fix') return { branch: 'ticket/T-01', testsPassed: false, testOutput: 'SENTINEL_FIX_FAILURE 2 tests red', deviations: '' }
      if (kind(label) === 'review') return BOUNCE
      return null
    })
    check(S, 'S11 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    eq(S, 'S11 escalated at bounce-fix-build', r0 && [r0.status, r0.stage], ['escalated', 'bounce-fix-build'])
    check(S, 'S11 detail carries the failing test output', r0 && /SENTINEL_FIX_FAILURE/.test(r0.detail))
  }

  // S12: args delivered as a JSON string (issue #23) — parsed, run completes
  {
    const { result, error } = await runWorkflow(JSON.stringify(baseArgs), ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'review') return CLEAR
      if (kind(label) === 'deliver') return goodDelivery
      return null
    })
    check(S, 'S12 stringified args accepted (issue #23)', !error, error && error.message)
    eq(S, 'S12 statuses', result && result.results.map((r) => r.status), ['delivered', 'delivered'])
  }

  // S13: testCmd is forwarded to the deliver script (issue #26 DoD test run)
  {
    const { calls, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]], testCmd: 'npm test' }, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'review') return CLEAR
      if (kind(label) === 'deliver') return goodDelivery
      return null
    })
    check(S, 'S13 no error', !error, error && error.message)
    const dcall = calls.find((c) => kind(c.label) === 'deliver')
    check(S, 'S13 deliver prompt carries --test-cmd', !!dcall && dcall.prompt.includes('--test-cmd "npm test"'))
    const bad = await runWorkflow({ ...baseArgs, testCmd: 'echo "quoted"' }, () => null)
    check(S, 'S13 testCmd with double quotes rejected', bad.error && /testCmd/.test(bad.error.message))
  }
}
