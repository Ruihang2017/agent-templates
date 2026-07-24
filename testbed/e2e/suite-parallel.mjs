// E2E for run-milestone's concurrency>1 DAG scheduler: loads the ACTUAL run-milestone.js
// and drives it with an ASYNC stubbed agent() that tracks lane overlap and deliver
// serialization. Zero tokens, zero network. (concurrency=1 is covered by suite-runner.)

import { readFileSync } from 'node:fs'
import { check, eq } from './lib.mjs'

const S = 'parallel'
const body = readFileSync(
  new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/workflows/run-milestone.js', import.meta.url),
  'utf8'
).replace('export const meta', 'const meta')

async function drive(args, respond) {
  const events = []
  let active = 0, maxActive = 0, activeDeliver = 0, maxDeliver = 0
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    active++; maxActive = Math.max(maxActive, active)
    const isDeliver = label.startsWith('deliver')
    if (isDeliver) { activeDeliver++; maxDeliver = Math.max(maxDeliver, activeDeliver) }
    events.push({ ev: 'start', label, isolation: opts.isolation || null, prompt })
    await new Promise((r) => setTimeout(r, 3)) // let sibling lanes interleave
    const res = respond({ prompt, opts, label })
    events.push({ ev: 'end', label })
    active--; if (isDeliver) activeDeliver--
    return res
  }
  const fn = new Function(
    'agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget',
    `"use strict"; return (async () => { ${body}\n })()`
  )
  let result = null, error = null
  try {
    result = await fn(agent, null, null, () => {}, () => {}, args, { total: null, spent: () => 0, remaining: () => Infinity })
  } catch (e) { error = e }
  return { result, error, events, maxActive, maxDeliver }
}

const kind = (l) => l.split(':')[0]
const tid = (l) => (l.split(':')[1] || '').split('#')[0]
const plan = (id) => ({ planPath: `docs/plans/${id}.md`, summary: 'ok', content: 'PLAN_BODY_' + id })
const goodBuild = (id) => ({ branch: `ticket/${id}`, testsPassed: true, testOutput: 'green', deviations: '' })
const CLEAR = { verdict: 'CLEAR', checkedNote: 'ok' }
const goodDelivery = { merged: true, issueClosed: true, dodPassed: true }
const stdRespond = ({ label }) => {
  if (kind(label) === 'plan') return plan(tid(label))
  if (kind(label) === 'build' || kind(label) === 'fix') return goodBuild(tid(label))
  if (kind(label) === 'review') return CLEAR
  if (kind(label) === 'deliver') return goodDelivery
  return null
}
const tk = (id, blockedBy) => ({ id, path: `docs/prd/x/tickets/${id}.md`, issue: 1, ...(blockedBy ? { blockedBy } : {}) })

export async function run() {
  // PAR1: two independent tickets at concurrency 2 -> both delivered, lanes overlapped
  {
    const { result, error, maxActive } = await drive({ tickets: [tk('A'), tk('B')], mode: 'autonomous', concurrency: 2 }, stdRespond)
    check(S, 'PAR1 no error', !error, error && error.message)
    eq(S, 'PAR1 both delivered', result && result.results.map((r) => r.status).sort(), ['delivered', 'delivered'])
    check(S, 'PAR1 lanes overlapped (maxActive>1)', maxActive > 1, 'maxActive=' + maxActive)
    eq(S, 'PAR1 concurrency reported', result && result.concurrency, 2)
    eq(S, 'PAR1 notStarted 0', result && result.notStarted, 0)
  }

  // PAR2: B blocked_by A -> B's build must not start before A delivered
  {
    const { result, events, error } = await drive({ tickets: [tk('A'), tk('B', ['A'])], mode: 'autonomous', concurrency: 3 }, stdRespond)
    check(S, 'PAR2 no error', !error, error && error.message)
    eq(S, 'PAR2 both delivered', result && result.results.map((r) => r.status).sort(), ['delivered', 'delivered'])
    const aDeliverEnd = events.findIndex((e) => e.ev === 'end' && e.label.startsWith('deliver:A'))
    const bBuildStart = events.findIndex((e) => e.ev === 'start' && e.label.startsWith('build:B'))
    check(S, 'PAR2 B builds only after A delivered', aDeliverEnd !== -1 && bBuildStart > aDeliverEnd, `aDeliverEnd=${aDeliverEnd} bBuildStart=${bBuildStart}`)
  }

  // PAR3: A fails at build; B depends on A -> B skipped; independent C still delivered
  {
    const { result, error } = await drive({ tickets: [tk('A'), tk('B', ['A']), tk('C')], mode: 'autonomous', concurrency: 3 }, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return tid(label) === 'A' ? { branch: 'ticket/A', testsPassed: false, testOutput: 'red' } : goodBuild(tid(label))
      if (kind(label) === 'review') return CLEAR
      if (kind(label) === 'deliver') return goodDelivery
      return null
    })
    check(S, 'PAR3 no error', !error, error && error.message)
    const byId = Object.fromEntries(result.results.map((r) => [r.id, r.status]))
    eq(S, 'PAR3 A failed', byId.A, 'failed')
    eq(S, 'PAR3 B skipped (blocker failed)', byId.B, 'skipped-dependency')
    eq(S, 'PAR3 C delivered (independent)', byId.C, 'delivered')
  }

  // PAR4: deliver is serialized across lanes -> never more than one deliver at once
  {
    const { maxDeliver, error } = await drive({ tickets: [tk('A'), tk('B'), tk('C')], mode: 'autonomous', concurrency: 3 }, stdRespond)
    check(S, 'PAR4 no error', !error, error && error.message)
    eq(S, 'PAR4 deliver never overlaps (serialized merge)', maxDeliver, 1)
  }

  // PAR5: supervised forces concurrency=1 and stops after the first CLEAR
  {
    const { result, error } = await drive({ tickets: [tk('A'), tk('B')], mode: 'supervised', concurrency: 5 }, ({ label }) => {
      if (kind(label) === 'plan') return plan(tid(label))
      if (kind(label) === 'build') return goodBuild(tid(label))
      if (kind(label) === 'review') return CLEAR
      if (kind(label) === 'deliver') return { merged: false, issueClosed: false, dodPassed: false, awaitingMerge: true, prUrl: 'u' }
      return null
    })
    check(S, 'PAR5 no error', !error, error && error.message)
    eq(S, 'PAR5 supervised forced to concurrency 1', result && result.concurrency, 1)
    eq(S, 'PAR5 supervised stops after first CLEAR', result && result.results.map((r) => r.status), ['awaiting-human-merge'])
  }

  // PAR6: parallel builders/reviewers are isolated; architect returns plan content used in the builder prompt
  {
    const { events, error } = await drive({ tickets: [tk('A')], mode: 'autonomous', concurrency: 2 }, stdRespond)
    check(S, 'PAR6 no error', !error, error && error.message)
    const bs = events.find((e) => e.ev === 'start' && e.label.startsWith('build:A'))
    const rs = events.find((e) => e.ev === 'start' && e.label.startsWith('review:A'))
    check(S, 'PAR6 builder runs in an isolated worktree', bs && bs.isolation === 'worktree')
    check(S, 'PAR6 reviewer runs in an isolated worktree', rs && rs.isolation === 'worktree')
    check(S, 'PAR6 plan CONTENT embedded in builder prompt (worktree cannot read the plan file)', bs && bs.prompt.includes('PLAN_BODY_A'))
  }

  // PAR7: an in-run dependency cycle is failed by the deadlock guard, never hangs
  {
    const { result, error } = await drive({ tickets: [tk('A', ['B']), tk('B', ['A'])], mode: 'autonomous', concurrency: 2 }, stdRespond)
    check(S, 'PAR7 no error / no hang', !error, error && error.message)
    check(S, 'PAR7 cycle failed by the schedule guard', result && result.results.length === 2 && result.results.every((r) => r.status === 'failed' && r.stage === 'schedule'))
  }

  // PAR8: concurrency caps in-flight lanes (5 independent tickets, concurrency 2 -> maxActive <= 2*stages-ish; assert never all 5 at once)
  {
    const { result, error, maxActive } = await drive({ tickets: ['A', 'B', 'C', 'D', 'E'].map((id) => tk(id)), mode: 'autonomous', concurrency: 2 }, stdRespond)
    check(S, 'PAR8 no error', !error, error && error.message)
    eq(S, 'PAR8 all five delivered', result && result.results.filter((r) => r.status === 'delivered').length, 5)
    check(S, 'PAR8 concurrency=2 caps in-flight lanes (maxActive well below 5 lanes)', maxActive <= 2, 'maxActive=' + maxActive)
  }
}
