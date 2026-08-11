// dag-core.mjs — shared, side-effect-free core for the PRD ticket graph.
//
// Ground truth is ticket frontmatter (`blocked_by`), never prose. Both
// milestone-dag.mjs (runner input) and dag-report.mjs (human view) import this, so
// there is exactly ONE parser: a second copy would drift, and a DAG that disagrees
// with itself dispatches tickets in the wrong order (see catalog issue #31).
//
// Nothing here reads argv, writes files, prints, or exits — callers own all of that,
// which is what lets milestone-dag.mjs keep its exact stdout contract.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const fmOf = (text) => (text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
const field = (fm, name) => ((fm.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'm')) || [])[1] || '').trim()
const listField = (fm, name) =>
  field(fm, name)
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

// Read <root>/<module>/tickets/*.md into a module graph.
// Returns { modules, ticketModule, errors } — errors are COLLECTED, never thrown, so
// the caller can report every spec defect in one pass instead of one per run.
//   modules: name -> { tickets: [{ id, title, lane, size, blockedBy }], dependsOn: Set }
export function buildGraph(root) {
  const modules = {}
  const ticketModule = {}
  const errors = []

  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  for (const d of dirs) {
    const tdir = join(root, d, 'tickets')
    let ok = false
    try { ok = statSync(tdir).isDirectory() } catch {}
    if (!ok) continue
    const tickets = []
    for (const f of readdirSync(tdir).filter((n) => n.endsWith('.md')).sort()) {
      const fm = fmOf(readFileSync(join(tdir, f), 'utf8'))
      const id = field(fm, 'id')
      if (!id) { errors.push(`${join(tdir, f)}: missing frontmatter id`); continue }
      if (ticketModule[id]) { errors.push(`duplicate ticket id ${id} (${ticketModule[id]} and ${d})`); continue }
      ticketModule[id] = d
      tickets.push({
        id,
        title: field(fm, 'title'),
        lane: field(fm, 'lane'),
        size: field(fm, 'size'),
        blockedBy: listField(fm, 'blocked_by'),
        // forward slashes: this path is handed to agents and embedded in JSON that the
        // E2E matrix compares across ubuntu and windows
        file: join(tdir, f).replace(/\\/g, '/'),
        module: d,
      })
    }
    if (tickets.length) modules[d] = { tickets, dependsOn: new Set() }
  }

  // A module depends on another when any of its tickets is blocked_by a ticket living
  // there. A blocked_by pointing at nothing is a spec error, not a warning — silently
  // dropping it would produce a DAG that looks satisfiable and is not.
  for (const [name, mod] of Object.entries(modules)) {
    for (const t of mod.tickets) {
      for (const dep of t.blockedBy) {
        const owner = ticketModule[dep]
        if (!owner) { errors.push(`${name}/${t.id}: blocked_by references unknown ticket '${dep}'`); continue }
        if (owner !== name) mod.dependsOn.add(owner)
      }
    }
  }

  return { modules, ticketModule, errors }
}

// Kahn topological sort over `nodes`; `depsOf(n)` returns the nodes that must come
// before n (deps outside `nodes` are ignored by the caller). Deterministic tiebreak by
// string order — module names and ticket ids both sort with numeric prefixes naturally.
// Returns { order } or { cycle } (the nodes left when nothing is ready).
export function topoSort(nodes, depsOf) {
  const remaining = new Set(nodes)
  const order = []
  while (remaining.size) {
    const ready = [...remaining].filter((n) => depsOf(n).every((d) => !remaining.has(d))).sort()
    if (!ready.length) return { cycle: [...remaining].sort() }
    order.push(ready[0])
    remaining.delete(ready[0])
  }
  return { order }
}

// Intra-module dependency edges for one module: blocked_by filtered to siblings.
// Cross-module edges are already satisfied by module ordering, so they must NOT gate
// ticket scheduling within the module.
export function intraModuleDeps(mod) {
  const ids = new Set(mod.tickets.map((t) => t.id))
  return Object.fromEntries(mod.tickets.map((t) => [t.id, t.blockedBy.filter((d) => ids.has(d))]))
}

// Replay run-milestone's scheduler: each round, dispatch every ready ticket up to
// `cap`. Returns rounds as arrays of ids, or null if the graph has a cycle (callers
// validate with topoSort first, so null means a caller bug rather than a spec defect).
//
// Uniform-duration model: every ticket takes one round, and a round ends when all its
// lanes finish. Real lanes finish at different times and the real scheduler refills a
// free lane immediately, so actual wall-clock is at most this many rounds. This is the
// standard wave model; the assumption is stated in the report rather than hidden.
export function simulate(ids, depsOf, cap) {
  const pending = new Set(ids)
  const rounds = []
  while (pending.size) {
    const ready = [...pending].filter((n) => depsOf(n).every((d) => !pending.has(d))).sort()
    if (!ready.length) return null
    const batch = ready.slice(0, cap)
    rounds.push(batch)
    for (const b of batch) pending.delete(b)
  }
  return rounds
}

// Lane profile for one module: how the run behaves at every concurrency from 1 to the
// ticket count.
//   roundsByCap[i]   — the wave breakdown at concurrency i+1
//   minWaves         — waves with unlimited lanes (the critical-path length)
//   maxUsefulLanes   — the LOWEST concurrency that reaches minWaves; above it, lanes
//                      sit idle, so it is the honest "how many lanes" answer
//   peakLanes        — the widest single wave at maxUsefulLanes
export function laneProfile(ids, depsOf) {
  const n = ids.length
  if (!n) return { roundsByCap: [], minWaves: 0, maxUsefulLanes: 0, peakLanes: 0 }
  const roundsByCap = []
  for (let cap = 1; cap <= n; cap++) {
    const r = simulate(ids, depsOf, cap)
    if (!r) return null
    roundsByCap.push(r)
  }
  const minWaves = roundsByCap[n - 1].length
  let maxUsefulLanes = n
  for (let i = 0; i < n; i++) {
    if (roundsByCap[i].length === minWaves) { maxUsefulLanes = i + 1; break }
  }
  const peakLanes = roundsByCap[maxUsefulLanes - 1].reduce((m, w) => Math.max(m, w.length), 0)
  return { roundsByCap, minWaves, maxUsefulLanes, peakLanes }
}

// Every ticket's dependencies across the WHOLE prd, cross-module edges included,
// filtered to ids that exist. This is the real dependency graph; intraModuleDeps is a
// projection of it that exists only because the runner happens to serialize modules.
export function allDeps(modules) {
  const known = new Set()
  for (const mod of Object.values(modules)) for (const t of mod.tickets) known.add(t.id)
  const deps = {}
  for (const mod of Object.values(modules)) {
    for (const t of mod.tickets) deps[t.id] = t.blockedBy.filter((d) => known.has(d))
  }
  return deps
}

// The two schedules the report contrasts. Both return rounds as arrays of ticket ids
// over the whole PRD, so one renderer draws either.
//
// runnerSchedule — what /start-all does TODAY: start-all.js awaits each run-milestone,
// so a module barrier sits between every pair of modules and `cap` only fans out
// within the module currently running. Rounds are each module's waves, concatenated.
//
// globalSchedule — what the dependency graph alone would permit, module boundaries
// ignored. The runner cannot do this yet; the report shows the gap rather than
// presenting it as achievable.
export function runnerSchedule(order, modules, ticketOrder, cap) {
  let rounds = []
  for (const m of order) {
    const deps = intraModuleDeps(modules[m])
    const r = simulate(ticketOrder[m], (id) => deps[id], cap)
    if (!r) return null
    rounds = rounds.concat(r)
  }
  return rounds
}

export function globalSchedule(order, modules, ticketOrder, cap) {
  const deps = allDeps(modules)
  const ids = order.flatMap((m) => ticketOrder[m])
  return simulate(ids, (id) => deps[id], cap)
}

// Round counts at every concurrency from 1..n for a schedule function, plus the
// lowest concurrency that already reaches the minimum round count. Above it lanes sit
// idle; below it, work that could run in parallel is serialized.
export function scheduleProfile(scheduleFn, n) {
  if (!n) return { roundsByCap: [], minRounds: 0, maxUsefulLanes: 0 }
  const roundsByCap = []
  for (let cap = 1; cap <= n; cap++) {
    const r = scheduleFn(cap)
    if (!r) return null
    roundsByCap.push(r)
  }
  const minRounds = roundsByCap[n - 1].length
  let maxUsefulLanes = n
  for (let i = 0; i < n; i++) {
    if (roundsByCap[i].length === minRounds) { maxUsefulLanes = i + 1; break }
  }
  return { roundsByCap, minRounds, maxUsefulLanes }
}

// Full plan: module order + per-module ticket order. Returns { ok: false, ... } for
// every failure mode so the caller decides how to report and exit.
export function buildPlan(root) {
  const { modules, ticketModule, errors } = buildGraph(root)
  if (!Object.keys(modules).length) return { ok: false, empty: true, modules, ticketModule, errors }
  if (errors.length) return { ok: false, errors, modules, ticketModule }

  const modSort = topoSort(Object.keys(modules), (m) => [...modules[m].dependsOn])
  if (modSort.cycle) return { ok: false, moduleCycle: modSort.cycle, modules, ticketModule, errors }

  const ticketOrder = {}
  for (const m of modSort.order) {
    const deps = intraModuleDeps(modules[m])
    const sorted = topoSort(Object.keys(deps), (id) => deps[id])
    if (sorted.cycle) return { ok: false, ticketCycle: { module: m, cycle: sorted.cycle }, modules, ticketModule, errors }
    ticketOrder[m] = sorted.order
  }

  return { ok: true, order: modSort.order, modules, ticketModule, ticketOrder, errors }
}
