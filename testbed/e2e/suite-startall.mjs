// E2E for the start-all workflow: executes the ACTUAL start-all.js with a stubbed
// workflow() (standing in for run-milestone children) and asserts the module-level
// failure policy the maintainer decided in catalog issue #20: failed modules block
// dependents; independent branches continue in autonomous; anything short of a CLEAR
// stops everything in supervised; empty ticket lists resume as already-complete.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'startall'
const SRC = readFileSync(
  fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/workflows/start-all.js', import.meta.url)),
  'utf8'
).replace('export const meta', 'const meta')

async function runStartAll(args, childImpl) {
  const children = []
  const logs = []
  const workflow = async (name, childArgs) => {
    children.push({ name, args: childArgs })
    return childImpl(childArgs, children.length)
  }
  const fn = new Function(
    'agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget', 'workflow',
    `"use strict"; return (async () => { ${SRC}\n })()`
  )
  let result = null
  let error = null
  try {
    result = await fn(null, null, null, (m) => logs.push(m), () => {}, args, { total: null, spent: () => 0, remaining: () => Infinity }, workflow)
  } catch (e) {
    error = e
  }
  return { result, children, logs, error }
}

const tk = (id) => ({ id, path: `docs/prd/x/tickets/${id}.md`, issue: 1 })
const mod = (name, dependsOn, ids) => ({ name, dependsOn, tickets: ids.map(tk) })
const delivered = (childArgs) => ({ mode: childArgs.mode, results: childArgs.tickets.map((t) => ({ id: t.id, status: 'delivered' })), notStarted: 0 })

export async function run() {
  // SA1: autonomous happy chain — children called once per module, in order
  {
    const args = { modules: [mod('00-f', [], ['F-1']), mod('01-a', ['00-f'], ['A-1', 'A-2']), mod('02-b', ['01-a'], ['B-1'])], mode: 'autonomous' }
    const { result, children, error } = await runStartAll(args, delivered)
    check(S, 'SA1 no error', !error, error && error.message)
    eq(S, 'SA1 all modules completed', result && result.results.map((r) => r.state), ['completed', 'completed', 'completed'])
    eq(S, 'SA1 children in DAG order', children.map((c) => c.args.tickets[0].id), ['F-1', 'A-1', 'B-1'])
    check(S, 'SA1 composes run-milestone', children.every((c) => c.name === 'run-milestone'))
  }

  // SA2: autonomous diamond — a fails; b (independent) continues; c (depends on a) skipped
  {
    const args = {
      modules: [mod('00-f', [], ['F-1']), mod('01-a', ['00-f'], ['A-1']), mod('02-b', ['00-f'], ['B-1']), mod('03-c', ['01-a'], ['C-1'])],
      mode: 'autonomous',
    }
    const { result, children, error } = await runStartAll(args, (childArgs) => {
      if (childArgs.tickets[0].id === 'A-1') {
        return { mode: 'autonomous', results: [{ id: 'A-1', status: 'escalated', stage: 'review' }], notStarted: 0 }
      }
      return delivered(childArgs)
    })
    check(S, 'SA2 no error', !error, error && error.message)
    const states = Object.fromEntries(result.results.map((r) => [r.name, r.state]))
    eq(S, 'SA2 failed module marked', states['01-a'], 'failed')
    eq(S, 'SA2 independent branch continued', states['02-b'], 'completed')
    eq(S, 'SA2 dependent skipped', states['03-c'], 'skipped-dependency')
    eq(S, 'SA2 no child launched for the skipped module', children.length, 3)
    check(S, 'SA2 failure detail names ticket and stage', /A-1: escalated \(review\)/.test(result.results.find((r) => r.name === '01-a').detail))
  }

  // SA3: supervised — first pause stops the whole run
  {
    const args = { modules: [mod('00-f', [], ['F-1']), mod('01-a', ['00-f'], ['A-1'])], mode: 'supervised' }
    const { result, children, error } = await runStartAll(args, (childArgs) => ({
      mode: 'supervised',
      results: [{ id: childArgs.tickets[0].id, status: 'awaiting-human-merge', branch: 'ticket/x' }],
      notStarted: 0,
    }))
    check(S, 'SA3 no error', !error, error && error.message)
    eq(S, 'SA3 first module paused', result.results[0].state, 'paused-for-merge')
    eq(S, 'SA3 second module not started', result.results[1].state, 'not-started')
    eq(S, 'SA3 only one child launched', children.length, 1)
    check(S, 'SA3 stoppedEarly flagged', result.stoppedEarly === true)
  }

  // SA4: supervised — a failure (no CLEAR) also stops everything
  {
    const args = { modules: [mod('00-f', [], ['F-1']), mod('01-a', ['00-f'], ['A-1'])], mode: 'supervised' }
    const { result, error } = await runStartAll(args, (childArgs) => ({
      mode: 'supervised',
      results: [{ id: childArgs.tickets[0].id, status: 'failed', stage: 'builder' }],
      notStarted: 0,
    }))
    check(S, 'SA4 no error', !error, error && error.message)
    eq(S, 'SA4 module marked failed', result.results[0].state, 'failed')
    eq(S, 'SA4 run stopped', result.results[1].state, 'not-started')
  }

  // SA5: resume — empty ticket list means already-complete, no child call, deps satisfied
  {
    const args = { modules: [mod('00-f', [], []), mod('01-a', ['00-f'], ['A-1'])], mode: 'autonomous' }
    const { result, children, error } = await runStartAll(args, delivered)
    check(S, 'SA5 no error', !error, error && error.message)
    eq(S, 'SA5 empty module already-complete', result.results[0].state, 'already-complete')
    eq(S, 'SA5 dependent still ran', result.results[1].state, 'completed')
    eq(S, 'SA5 exactly one child launched', children.length, 1)
  }

  // SA6: a crashing child = failed module, dependents skipped, run survives
  {
    const args = { modules: [mod('00-f', [], ['F-1']), mod('01-a', ['00-f'], ['A-1'])], mode: 'autonomous' }
    const { result, error } = await runStartAll(args, (childArgs) => {
      if (childArgs.tickets[0].id === 'F-1') throw new Error('child exploded')
      return delivered(childArgs)
    })
    check(S, 'SA6 no error', !error, error && error.message)
    eq(S, 'SA6 crashed module failed', result.results[0].state, 'failed')
    check(S, 'SA6 detail carries the child error', /child exploded/.test(result.results[0].detail))
    eq(S, 'SA6 dependent skipped', result.results[1].state, 'skipped-dependency')
  }

  // SA7: validation — order violating the DAG throws; bad mode throws
  {
    const bad = await runStartAll({ modules: [mod('01-a', ['00-f'], ['A-1'])], mode: 'autonomous' }, delivered)
    check(S, 'SA7 order violation throws', bad.error && /violates the DAG/.test(bad.error.message))
    const badMode = await runStartAll({ modules: [mod('00-f', [], ['F-1'])], mode: 'yolo' }, delivered)
    check(S, 'SA7 bad mode throws', badMode.error && /mode/.test(badMode.error.message))
  }
}
