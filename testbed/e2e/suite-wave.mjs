// E2E for the wave runner: loads the ACTUAL scaffold run-wave.js, executes it with
// stubbed agent()/log() (the same wrapping the Workflow runtime applies), and asserts the
// orchestration guarantees the pattern documents — bounce cap, reviewer-failure handling,
// acceptance gating, prompt isolation, worktree isolation, and the two guarantees this
// file exists to protect (catalog issue #206):
//
//   1. the workflow DELIVERS NOTHING — no fourth agent, no merge, no tracker call;
//   2. the Reviewer AUTHORS its own record — no verdict text crosses a context boundary.
//
// Replaces suite-runner.mjs and suite-parallel.mjs, whose subjects (run-milestone.js,
// start-all.js) were retired. Their scheduling assertions moved to suite-waveplan.mjs and
// their delivery assertions to suite-deliverwave.mjs — deliberately, so that removing a
// scheduler did not quietly remove the checks that made it trustworthy.
//
// Zero tokens, zero network.

import { readFileSync } from 'node:fs'
import { check, eq } from './lib.mjs'

const S = 'wave'
const SRC_URL = new URL(
  '../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/workflows/run-wave.js',
  import.meta.url
)
const SRC = readFileSync(SRC_URL, 'utf8')
const body = SRC.replace('export const meta', 'const meta')

async function runWorkflow(args, respond) {
  const calls = []
  const logs = []
  let active = 0
  let maxActive = 0
  const agent = async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label || '' }
    calls.push(call)
    active++
    maxActive = Math.max(maxActive, active)
    // Yield so genuinely-parallel lanes can interleave; a synchronous return would make
    // every scheduler look sequential and the concurrency assertions vacuous.
    await new Promise((r) => setTimeout(r, 1))
    active--
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
  return { result, calls, logs, error, maxActive }
}

// Canned stage responses
const plan = (id) => ({ planPath: `docs/plans/${id}.md`, summary: 'ok', content: 'PLAN_CONTENT_SENTINEL' })
const goodBuild = (id) => ({
  branch: `ticket/${id}`,
  testsPassed: true,
  testOutput: 'SENTINEL_TEST_OUTPUT green',
  deviations: 'SENTINEL_DEVIATIONS none',
  summary: 'SENTINEL_BUILD_SUMMARY added the thing',
})
const clearFor = (id) => ({ verdict: 'CLEAR', recordPath: `.claude/tmp/${id}-verdict.md`, machineChecks: [{ row: '[machine] tests', met: true }] })
const BOUNCE = { verdict: 'BOUNCE', findings: [{ file: 'src/x.mjs', scenario: 'SENTINEL_FINDING edge missed', severity: 'major' }] }

const tickets2 = [
  { id: 'T-01', path: 'docs/prd/00-m/tickets/T-01.md', issue: 1 },
  { id: 'T-02', path: 'docs/prd/00-m/tickets/T-02.md', issue: 2 },
]
const baseArgs = { tickets: tickets2, defaultBranch: 'main' }
const kind = (label) => label.split(':')[0]
const tid = (label) => (label.split(':')[1] || '').split('#')[0]

const stages = ({ label }) => {
  if (kind(label) === 'plan') return plan(tid(label))
  if (kind(label) === 'build' || kind(label) === 'fix') return goodBuild(tid(label))
  if (kind(label) === 'review') return clearFor(tid(label))
  return null
}

export async function run() {
  // ---- W1: happy path, and NOTHING is delivered --------------------------------------
  {
    const { result, calls, error } = await runWorkflow(baseArgs, stages)
    check(S, 'W1 no error', !error, error && error.message)
    eq(S, 'W1 both tickets reviewed CLEAR', result && result.results.map((r) => r.status), ['reviewed-clear', 'reviewed-clear'])
    eq(S, 'W1 cleared count', result && result.cleared, 2)
    eq(S, 'W1 per-ticket call sequence is plan -> build -> review', calls.slice(0, 3).map((c) => kind(c.label)), ['plan', 'build', 'review'])

    // The whole point of issue #206: there is no fourth stage. Asserted three ways,
    // because "the agent is gone" must not be satisfiable by renaming it.
    eq(S, 'W1 NO delivery agent is ever spawned', calls.filter((c) => kind(c.label) === 'deliver').length, 0)
    eq(S, 'W1 only architect/builder/reviewer agent types are used',
      [...new Set(calls.map((c) => c.opts.agentType))].sort(), ['architect', 'builder', 'reviewer'])
    check(S, 'W1 no agent call is left untyped (an untyped agent is how the old delivery stage hid)',
      calls.every((c) => typeof c.opts.agentType === 'string' && c.opts.agentType.length > 0))
  }

  // ---- W1b: the SOURCE cannot deliver either ------------------------------------------
  {
    // Comments are stripped first. The header EXPLAINS why delivery is absent and has to
    // name the script to do so; the assertion is that no CODE invokes it. Matching raw
    // source would fail on its own rationale, and the fix for that failure would be to
    // delete the explanation — which is the wrong direction.
    const code = SRC.replace(/^\s*\/\/.*$/gm, '')
    check(S, 'W1b the workflow never invokes the delivery script', !/deliver-ticket\.mjs/.test(code))
    check(S, 'W1b the workflow never merges, pushes or closes', !/\bgh (pr|issue)\b|\bglab (mr|issue)\b|git push/.test(code))
    check(S, 'W1b it says plainly that nothing has been delivered', /NOTHING here has been merged/.test(SRC))
    check(S, 'W1b the terminal success state is not named "delivered"',
      /reviewed-clear/.test(SRC) && !/status: 'delivered'/.test(SRC))
  }

  // ---- W2: bounce once, then clear -----------------------------------------------------
  {
    let reviews = 0
    const { result, calls, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, (call) => {
      const { label } = call
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build' || kind(label) === 'fix') return goodBuild(tid(label))
      if (kind(label) === 'review') return reviews++ === 0 ? BOUNCE : clearFor(tid(label))
      return null
    })
    check(S, 'W2 no error', !error, error && error.message)
    eq(S, 'W2 cleared with bounces=1', result && result.results[0] && [result.results[0].status, result.results[0].bounces], ['reviewed-clear', 1])
    const fix = calls.find((c) => kind(c.label) === 'fix')
    check(S, 'W2 fix dispatched with findings', fix && fix.prompt.includes('SENTINEL_FINDING'))
    check(S, 'W2 fix prompt keeps the no-merge guard', fix && fix.prompt.includes('do NOT merge'))
    const reviewCalls = calls.filter((c) => kind(c.label) === 'review')
    check(S, 'W2 reviewer isolation (no builder test output or deviations leak)',
      reviewCalls.every((c) => !c.prompt.includes('SENTINEL_TEST_OUTPUT') && !c.prompt.includes('SENTINEL_DEVIATIONS')))
    check(S, 'W2 reviewer isolation (no builder summary leaks either)',
      reviewCalls.every((c) => !c.prompt.includes('SENTINEL_BUILD_SUMMARY')))
  }

  // ---- W3: bounce cap, and one ticket failing does NOT strand the wave ------------------
  // A wave is independent by construction, so there is nothing for a failure to cascade to
  // WITHIN it. The old runner's fail-fast existed because a later ticket could depend on an
  // earlier one's merge; that cannot happen here, and stopping would be a false report.
  {
    const { result, calls, error } = await runWorkflow(baseArgs, (call) => {
      const { label } = call
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build' || kind(label) === 'fix') return goodBuild(tid(label))
      if (kind(label) === 'review') return tid(label) === 'T-01' ? BOUNCE : clearFor(tid(label))
      return null
    })
    check(S, 'W3 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    eq(S, 'W3 escalated at the bounce cap', r0 && [r0.status, r0.stage, r0.bounces], ['escalated', 'review', 2])
    eq(S, 'W3 exactly 2 fixes dispatched', calls.filter((c) => kind(c.label) === 'fix').length, 2)
    eq(S, 'W3 the OTHER ticket still ran to CLEAR', result && result.results[1] && result.results[1].status, 'reviewed-clear')
    eq(S, 'W3 every ticket in the wave is reported', result && result.results.length, 2)
  }

  // ---- W4: reviewer infrastructure failure ---------------------------------------------
  {
    const { result, calls, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, (call) => {
      const { label } = call
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      return null
    })
    check(S, 'W4 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    eq(S, 'W4 escalated reviewer-failed with zero bounces', r0 && [r0.status, r0.stage, r0.bounces], ['escalated', 'reviewer-failed', 0])
    eq(S, 'W4 review retried exactly once', calls.filter((c) => kind(c.label) === 'review').length, 2)
    eq(S, 'W4 no fix dispatched on a broken reviewer', calls.filter((c) => kind(c.label) === 'fix').length, 0)
  }

  // ---- W5: a CLEAR carrying an unmet acceptance row is not a CLEAR (issue #183) ---------
  {
    const { result, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, (call) => {
      const { label } = call
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'review') {
        return { verdict: 'CLEAR', recordPath: '.claude/tmp/T-01-verdict.md', machineChecks: [
          { row: '[machine] suite green', met: true },
          { row: '[machine] emits SENTINEL_ROW', met: false, note: 'SENTINEL_REASON contradictory deliverable' },
        ] }
      }
      return null
    })
    check(S, 'W5 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    eq(S, 'W5 the ticket did NOT clear', r0 && [r0.status, r0.stage], ['escalated', 'acceptance-unmet'])
    check(S, 'W5 the detail quotes the unmet row', r0 && r0.detail.includes('SENTINEL_ROW'))
    check(S, 'W5 and carries the reason the reviewer gave', r0 && r0.detail.includes('SENTINEL_REASON'))
  }

  // ---- W6/W7: stage artifacts that never arrived ---------------------------------------
  {
    const { result, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, (call) => {
      if (kind(call.label) === 'plan') return { planPath: 'docs/plans/WRONG.md', summary: 'x' }
      return null
    })
    check(S, 'W6 no error', !error, error && error.message)
    const r0 = result && result.results[0]
    eq(S, 'W6 failed at architect', r0 && [r0.status, r0.stage], ['failed', 'architect'])
    check(S, 'W6 the detail names the wrong path', r0 && r0.detail.includes('WRONG.md'))
  }
  {
    const { result, error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, (call) => {
      const { label } = call
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return { branch: 'ticket/SOMETHING-ELSE', testsPassed: true, testOutput: 'ok' }
      return null
    })
    const r0 = result && result.results[0]
    eq(S, 'W7 failed at builder on a wrong branch', r0 && [r0.status, r0.stage], ['failed', 'builder'])
    check(S, 'W7 the detail names the branch it actually used', r0 && r0.detail.includes('SOMETHING-ELSE'))
  }
  {
    const { result } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, (call) => {
      const { label } = call
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return { branch: 'ticket/T-01', testsPassed: false, testOutput: 'SENTINEL_FAILING_TESTS 3 failed' }
      return null
    })
    check(S, 'W7b a failing build carries its real test output into the detail',
      result && result.results[0] && result.results[0].detail.includes('SENTINEL_FAILING_TESTS'))
  }

  // ---- W8: argument validation ----------------------------------------------------------
  {
    const cases = [
      ['empty ticket list', { tickets: [] }],
      ['ticket with no path', { tickets: [{ id: 'T-01' }] }],
      ['ticket id with a slash', { tickets: [{ id: 'a/b', path: 'x.md' }] }],
      ['negative maxBounces', { tickets: tickets2, maxBounces: -1 }],
      ['zero concurrency', { tickets: tickets2, concurrency: 0 }],
      ['empty defaultBranch', { tickets: tickets2, defaultBranch: '' }],
    ]
    for (const [name, args] of cases) {
      const { error } = await runWorkflow(args, stages)
      check(S, `W8 rejects ${name}`, !!error, error ? '' : 'no error thrown')
    }
  }

  // ---- W9: the wave-independence guard ---------------------------------------------------
  // The single assumption the whole design rests on. If a dependent could share a wave with
  // its blocker it would be built against a tree that does not contain the work it depends
  // on — and the tests would PASS, because the dependency simply is not there to conflict.
  {
    const { error } = await runWorkflow({
      ...baseArgs,
      tickets: [
        { id: 'T-01', path: 'a.md', issue: 1, blockedBy: [] },
        { id: 'T-02', path: 'b.md', issue: 2, blockedBy: ['T-01'] },
      ],
    }, stages)
    check(S, 'W9 a wave containing an internal dependency is REFUSED', !!error)
    check(S, 'W9 the refusal names the offending edge', !!error && error.message.includes('T-02 <- T-01'))
    check(S, 'W9 and says a blocker must be delivered first', !!error && /DELIVERED before its dependent/.test(error.message))
  }
  {
    const { error } = await runWorkflow({
      ...baseArgs,
      tickets: [{ id: 'T-01', path: 'a.md', blockedBy: ['OUTSIDE-9'] }],
    }, stages)
    check(S, 'W9b a blocker OUTSIDE the wave does not block it (it is already delivered)', !error, error && error.message)
  }
  {
    const { error } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0], tickets2[0]] }, stages)
    check(S, 'W9c a duplicate ticket id in one wave is refused', !!error)
  }

  // ---- W10: the Reviewer authors its own record -------------------------------------------
  {
    const { result, calls } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, stages)
    const rev = calls.find((c) => kind(c.label) === 'review')
    check(S, 'W10 the reviewer is told to write its OWN record', rev && /WRITE YOUR OWN REVIEW RECORD/.test(rev.prompt))
    check(S, 'W10 with the exact path', rev && rev.prompt.includes('.claude/tmp/T-01-verdict.md'))
    check(S, 'W10 and told nobody will re-type it', rev && /nobody will re-type it/.test(rev.prompt))
    const r0 = result && result.results[0]
    eq(S, 'W10 the result carries the record PATH', r0 && r0.recordPath, '.claude/tmp/T-01-verdict.md')
    check(S, 'W10 the result carries no verdict TEXT to re-type',
      r0 && !('checkedNote' in r0) && !('verdictText' in r0))
    // The defect this replaces: a stub substituted for a missing record, which then got
    // written to disk as if the Reviewer had said it (catalog issue #201).
    check(S, 'W10 no "the reviewer returned no note text" stub exists anywhere in the source',
      !/returned no note text/.test(SRC))
    check(S, 'W10 the source never instructs anyone to write a verdict VERBATIM', !/verdict text VERBATIM/i.test(SRC))
  }
  {
    const { result } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, (call) => {
      const { label } = call
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'review') return { verdict: 'CLEAR' } // no recordPath returned
      return null
    })
    const r0 = result && result.results[0]
    eq(S, 'W10b a reviewer that returned no path is flagged, not papered over', r0 && r0.recordWritten, false)
    eq(S, 'W10b and the expected path is still reported so the refusal can name it', r0 && r0.recordPath, '.claude/tmp/T-01-verdict.md')
  }

  // ---- W11: the artifacts the orchestrator needs to compose a body (issue #193) ----------
  {
    const { result } = await runWorkflow({ ...baseArgs, tickets: [tickets2[0]] }, stages)
    const r0 = result && result.results[0]
    check(S, 'W11 the result carries the builder summary', r0 && r0.buildSummary.includes('SENTINEL_BUILD_SUMMARY'))
    check(S, 'W11 the result carries the declared deviations', r0 && r0.deviations.includes('SENTINEL_DEVIATIONS'))
    check(S, 'W11 the result carries the real test output', r0 && r0.testOutput.includes('SENTINEL_TEST_OUTPUT'))
    eq(S, 'W11 the result carries the bounce count', r0 && r0.bounces, 0)
    eq(S, 'W11 the result carries the branch and ticket path', r0 && [r0.branch, r0.path], ['ticket/T-01', 'docs/prd/00-m/tickets/T-01.md'])
    eq(S, 'W11 the result carries the issue number', r0 && r0.issue, 1)
    check(S, 'W11 the builder is told its summary is quoted into the PR body',
      true === /quoted into the pull request body/.test(SRC))
  }

  // ---- W12: worktree isolation ------------------------------------------------------------
  {
    const { calls, error } = await runWorkflow({ ...baseArgs, concurrency: 2 }, stages)
    check(S, 'W12 no error', !error, error && error.message)
    const build = calls.find((c) => kind(c.label) === 'build')
    const rev = calls.find((c) => kind(c.label) === 'review')
    eq(S, 'W12 the builder runs in an isolated worktree', build && build.opts.isolation, 'worktree')
    eq(S, 'W12 the reviewer runs in an isolated worktree', rev && rev.opts.isolation, 'worktree')
    check(S, 'W12 the plan CONTENT is embedded (a worktree cannot read the plan file)',
      build && build.prompt.includes('PLAN_CONTENT_SENTINEL'))
    check(S, 'W12 the reviewer is told how to reach the MAIN repo to write its record',
      rev && rev.prompt.includes('--git-common-dir'))
  }
  {
    const { calls } = await runWorkflow({ ...baseArgs, concurrency: 1 }, stages)
    const build = calls.find((c) => kind(c.label) === 'build')
    const rev = calls.find((c) => kind(c.label) === 'review')
    check(S, 'W12b concurrency=1 uses no worktree', build && !build.opts.isolation && rev && !rev.opts.isolation)
    check(S, 'W12b and the reviewer is not given worktree instructions it does not need',
      rev && !rev.prompt.includes('--git-common-dir'))
  }

  // ---- W13: concurrency ---------------------------------------------------------------------
  {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `T-1${i}`, path: `t${i}.md`, issue: i }))
    const { result, maxActive, error } = await runWorkflow({ tickets: many, defaultBranch: 'main', concurrency: 2 }, stages)
    check(S, 'W13 no error', !error, error && error.message)
    check(S, 'W13 lanes overlap', maxActive > 1, `maxActive=${maxActive}`)
    check(S, 'W13 and are capped at the configured concurrency', maxActive <= 2, `maxActive=${maxActive}`)
    eq(S, 'W13 every ticket is reported', result && result.results.length, 6)
    eq(S, 'W13 results keep the input order regardless of completion order',
      result && result.results.map((r) => r.id), many.map((t) => t.id))
  }
  {
    const { maxActive } = await runWorkflow({ tickets: tickets2, defaultBranch: 'main', concurrency: 1 }, stages)
    eq(S, 'W13b concurrency=1 never overlaps', maxActive, 1)
  }

  // ---- W14: harness quirks -------------------------------------------------------------------
  {
    const { result, error } = await runWorkflow(JSON.stringify(baseArgs), stages)
    check(S, 'W14 stringified args accepted (issue #23)', !error && result && result.results.length === 2, error && error.message)
  }
}
