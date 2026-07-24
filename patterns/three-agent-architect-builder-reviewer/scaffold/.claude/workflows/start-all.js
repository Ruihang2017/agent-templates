export const meta = {
  name: 'start-all',
  description: 'Whole-PRD driver: runs every module through the milestone pipeline in DAG order, composing run-milestone per module',
}

// Module-level driver above run-milestone (which is unchanged: per ticket it still runs
// architect plan -> builder execute -> fresh-context reviewer, bounce-capped in code).
//
// args:
// {
//   modules: [{ name: '01-foundation', dependsOn: ['00-x'], tickets: [{id,path,issue}] }],
//     // in DAG order (from milestone-dag.mjs); tickets pre-filtered of closed issues,
//     // so an [] tickets list means "module already complete" (resume semantics)
//   mode: 'supervised' | 'autonomous',
//   defaultBranch: 'main',      // optional
//   platform: 'gh' | 'glab',    // optional, default 'gh'
//   testCmd: 'npm test'         // optional; passed through to run-milestone (deliver DoD test run)
// }
//
// Failure policy (maintainer decisions, catalog issue #20, 2026-07-18):
// - a failed module blocks its dependents;
// - autonomous: independent DAG branches CONTINUE past a failure;
// - supervised: ANY pause or failure stops the whole run (re-run to resume — closed
//   issues are filtered upstream, so completed modules arrive as already-complete);
// - no cost ceiling.

// args may arrive as a JSON string depending on the harness (catalog issue #23)
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {})
const cfg = Object.assign({ defaultBranch: 'main', platform: 'gh', concurrency: 1 }, parsedArgs)
if (!Array.isArray(cfg.modules) || cfg.modules.length === 0) {
  throw new Error('args.modules must be a non-empty array of {name, dependsOn, tickets}')
}
if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1) {
  throw new Error('args.concurrency must be an integer >= 1')
}
for (const m of cfg.modules) {
  if (!m || typeof m.name !== 'string' || !m.name || !Array.isArray(m.tickets) || !Array.isArray(m.dependsOn || [])) {
    throw new Error('every module needs a name, a tickets array, and a dependsOn array; got: ' + JSON.stringify(m))
  }
}
if (cfg.mode !== 'supervised' && cfg.mode !== 'autonomous') {
  throw new Error("args.mode must be 'supervised' or 'autonomous'")
}
if (cfg.platform !== 'gh' && cfg.platform !== 'glab') throw new Error("args.platform must be 'gh' or 'glab'")
if (cfg.testCmd !== undefined && (typeof cfg.testCmd !== 'string' || !cfg.testCmd || cfg.testCmd.includes('"'))) {
  throw new Error('args.testCmd must be a non-empty string without double quotes when provided')
}

const state = {} // name -> 'completed' | 'failed' | 'skipped' | 'paused'
const results = []
let stopped = false

for (const m of cfg.modules) {
  const deps = m.dependsOn || []
  if (stopped) {
    results.push({ name: m.name, state: 'not-started', detail: 'run stopped before this module' })
    continue
  }
  for (const d of deps) {
    if (!(d in state)) throw new Error('module order violates the DAG: ' + m.name + ' scheduled before its dependency ' + d)
  }
  const badDep = deps.find(function (d) { return state[d] !== 'completed' })
  if (badDep) {
    state[m.name] = 'skipped'
    results.push({ name: m.name, state: 'skipped-dependency', detail: 'dependency ' + badDep + ' did not complete' })
    log('module ' + m.name + ': skipped (dependency ' + badDep + ' did not complete)')
    continue
  }
  if (m.tickets.length === 0) {
    state[m.name] = 'completed'
    results.push({ name: m.name, state: 'already-complete', detail: 'all tickets already closed (resume)' })
    log('module ' + m.name + ': already complete')
    continue
  }

  log('module ' + m.name + ': running ' + m.tickets.length + ' ticket(s) through run-milestone')
  let child = null
  let err = null
  try {
    child = await workflow('run-milestone', {
      tickets: m.tickets,
      mode: cfg.mode,
      defaultBranch: cfg.defaultBranch,
      platform: cfg.platform,
      concurrency: cfg.concurrency, // ticket-level parallelism WITHIN each module (modules stay sequential)
      ...(cfg.testCmd ? { testCmd: cfg.testCmd } : {}),
    })
  } catch (e) {
    err = e && e.message ? e.message : String(e)
  }
  const rs = (child && child.results) || []

  if (cfg.mode === 'supervised') {
    // supervised run-milestone stops after each CLEAR; a module "completes" only via
    // resume (its issues close, its ticket list arrives empty next run)
    const paused = !err && rs.some(function (r) { return r.status === 'awaiting-human-merge' })
    state[m.name] = 'paused'
    results.push({
      name: m.name,
      state: paused ? 'paused-for-merge' : 'failed',
      detail: err || (paused ? 'CLEAR reached — merge it, then re-run /start-all to continue' : 'module stopped without reaching a CLEAR'),
      ticketResults: rs,
    })
    stopped = true
    continue
  }

  const allDelivered = !err && rs.length === m.tickets.length && rs.every(function (r) { return r.status === 'delivered' })
  if (allDelivered) {
    state[m.name] = 'completed'
    results.push({ name: m.name, state: 'completed', detail: rs.length + ' ticket(s) delivered', ticketResults: rs })
    log('module ' + m.name + ': completed')
  } else {
    state[m.name] = 'failed'
    const firstBad = rs.find(function (r) { return r.status !== 'delivered' })
    results.push({
      name: m.name,
      state: 'failed',
      detail: err || (firstBad ? firstBad.id + ': ' + firstBad.status + (firstBad.stage ? ' (' + firstBad.stage + ')' : '') : 'incomplete results'),
      ticketResults: rs,
    })
    log('module ' + m.name + ': FAILED — dependents will be skipped; independent branches continue')
  }
}

const done = results.filter(function (r) { return r.state === 'completed' || r.state === 'already-complete' }).length
log('start-all finished: ' + done + '/' + cfg.modules.length + ' modules complete')

return { mode: cfg.mode, results: results, stoppedEarly: stopped }
