#!/usr/bin/env node
// wave-plan.mjs — compute the NEXT WAVE of tickets the orchestrator may run.
//
// A wave is a set of tickets that are mutually independent AND whose blockers are all
// already delivered. That is the unit a pipeline run can execute now: delivery happens
// between waves, in the orchestrator, so a ticket and its blocker can never share one.
//
// This script exists because the scheduling DECISIONS must stay deterministic. Delivery
// moved out of the workflow and into the orchestrator (catalog issue #206), which took the
// scheduler out of the workflow sandbox with it — but "which tickets may run now" is
// exactly the kind of control flow this catalog has already watched prose get wrong, so it
// lives in code here rather than in a command's instructions.
//
// Usage:
//   node .codex/scripts/wave-plan.mjs <prdRoot> [options]
//
//   --delivered <id,id,...>  ids known delivered (tracker mode: issues reported closed)
//   --ledger <path>          also read a local delivery ledger (default docs/delivered.json
//                            when present; pass `--ledger none` to ignore it)
//   --failed <id,id,...>     ids that failed or were escalated in this run — they never
//                            become ready, and their dependents are reported unreachable
//   --module <name>          restrict the WAVE to one module; blockers outside it still gate
//   --max <n>                refuse to emit a wave wider than n (default 25)
//
// Prints one machine-readable line last:
//   WAVE-PLAN-JSON: {"ready":[...],"blocked":[...],"unreachable":[...],"done":bool,...}
//
// Exit codes: 0 = plan produced (including `done`), 1 = the graph itself is broken
// (dangling blocked_by, duplicate id, cycle) — never start a run on a broken DAG.

import { existsSync, readFileSync } from 'node:fs'
import { buildGraph } from './dag-core.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1]
}
const idList = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
const root = positional[0] || 'docs/prd'
const onlyModule = flag('--module', '')
const max = Number(flag('--max', '25'))
if (!Number.isInteger(max) || max < 1) {
  console.error('--max must be an integer >= 1')
  process.exit(1)
}

if (!existsSync(root)) {
  console.error(`prd root not found: ${root}`)
  process.exit(1)
}

const { modules, ticketModule, errors } = buildGraph(root)
if (errors.length) {
  for (const e of errors) console.error(`spec error: ${e}`)
  console.error('refusing to plan a wave on a broken DAG — fix the tickets first')
  process.exit(1)
}

// A `--module` that matches nothing is a hard error, not an empty plan. The failure it
// prevents is the one this catalog keeps meeting: a mistyped name yields "nothing left to
// run", the loop exits on its first pass, and a run that executed zero tickets reports
// itself complete.
if (onlyModule && !Object.prototype.hasOwnProperty.call(modules, onlyModule)) {
  console.error(`--module ${onlyModule} matches no module under ${root}`)
  console.error(`modules present: ${Object.keys(modules).sort().join(', ') || '(none)'}`)
  process.exit(1)
}

const all = []
for (const [name, mod] of Object.entries(modules)) {
  for (const t of mod.tickets) all.push({ id: t.id, path: t.file, module: name, blockedBy: t.blockedBy.slice() })
}
all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const byId = new Map(all.map((t) => [t.id, t]))

// ---- what counts as already delivered -------------------------------------------------
// Two signals, deliberately unioned rather than chosen between: a repo can run with a
// tracker AND have local-delivery rows from an earlier offline run. Trusting only one
// would re-admit work that is already merged.
const delivered = new Set(idList(flag('--delivered', '')))
const ledgerArg = flag('--ledger', '')
const ledgerPath = ledgerArg === 'none' ? '' : ledgerArg || 'docs/delivered.json'
let ledgerRead = ''
if (ledgerPath) {
  if (existsSync(ledgerPath)) {
    try {
      const j = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      const rows = Array.isArray(j && j.delivered) ? j.delivered : []
      for (const r of rows) {
        const id = typeof r === 'string' ? r : r && r.id
        if (id) delivered.add(String(id))
      }
      ledgerRead = ledgerPath
    } catch {
      // Loud, not fatal: an unparseable ledger means the delivered set is UNKNOWN, and
      // treating unknown as "nothing delivered" re-runs merged work. The caller sees this
      // in `notes` and can stop; a silent empty set would look like a clean first run.
      console.error(`ledger ${ledgerPath} is present but unparseable — treating it as empty; fix or remove it`)
    }
  }
}

const failed = new Set(idList(flag('--failed', '')))

// An id the caller passed that this graph does not contain is not an error — it may come
// from a previous phase whose tickets were archived, or from outside this root. It is
// REPORTED anyway, because the other reading is a typo, and a typo'd `--delivered` id
// silently re-runs delivered work.
const unknownIds = [...delivered, ...failed].filter((id) => !byId.has(id)).sort()

// ---- classify -------------------------------------------------------------------------
// `blockedBy` edges to ids that exist NOWHERE in the graph are already rejected above by
// buildGraph, so every edge here points at a real ticket.
const pending = all.filter((t) => !delivered.has(t.id) && !failed.has(t.id))

// A ticket is unreachable when any blocker failed, or transitively depends on one.
const unreachable = new Map()
{
  let changed = true
  while (changed) {
    changed = false
    for (const t of pending) {
      if (unreachable.has(t.id)) continue
      for (const d of t.blockedBy) {
        if (failed.has(d)) { unreachable.set(t.id, `blocker ${d} did not deliver`); changed = true; break }
        if (unreachable.has(d)) { unreachable.set(t.id, `blocker ${d} is unreachable`); changed = true; break }
      }
    }
  }
}

const live = pending.filter((t) => !unreachable.has(t.id))
const liveIds = new Set(live.map((t) => t.id))
const unmetOf = (t) => t.blockedBy.filter((d) => liveIds.has(d))

// Cycle detection over what is left: peel tickets with no unmet blockers; whatever will
// not peel is a cycle. dag-scan rejects cycles in the WHOLE graph, but a cycle can also be
// introduced by a ticket added between waves, so this is checked every wave, not once.
const cycle = (() => {
  const remaining = new Set(liveIds)
  let changed = true
  while (changed) {
    changed = false
    for (const id of [...remaining]) {
      if (byId.get(id).blockedBy.some((d) => remaining.has(d))) continue
      remaining.delete(id)
      changed = true
    }
  }
  return [...remaining].sort()
})()

const cycleSet = new Set(cycle)
const readyAll = live.filter((t) => !cycleSet.has(t.id) && unmetOf(t).length === 0)
// Reporting is scoped the same way the wave is. Under `--module`, a ticket in ANOTHER
// module is not this caller's business — but a cross-module blocker still shows up, by id,
// in the `waitingOn` of the ticket it holds up. That is the fact the operator needs.
const inScope = (t) => !onlyModule || t.module === onlyModule
const blocked = live
  .filter((t) => !cycleSet.has(t.id) && unmetOf(t).length > 0 && inScope(t))
  .map((t) => ({ id: t.id, module: t.module, waitingOn: unmetOf(t) }))

// The wave is module-filtered LAST, on purpose: a blocker in another module still gates,
// it just never joins the wave. The old runner approximated this with a module barrier and
// could start a ticket whose cross-module blocker had not landed.
const scoped = onlyModule ? readyAll.filter((t) => t.module === onlyModule) : readyAll
const ready = scoped.slice(0, max)
const notes = []
if (scoped.length > ready.length) {
  notes.push(`wave truncated to --max ${max}: ${scoped.length - ready.length} ready ticket(s) held for the next wave`)
}
if (ledgerRead) notes.push(`local delivery ledger read: ${ledgerRead}`)
if (cycle.length) notes.push(`dependency cycle among: ${cycle.join(', ')}`)
if (unknownIds.length) {
  notes.push(`ignored — not tickets under ${root}: ${unknownIds.join(', ')} (check for a typo before trusting this wave)`)
}

// `done` means there is no more work this loop can ever dispatch — NOT merely "no wave
// right now". A caller that stopped on an empty wave while tickets were still blocked
// would report a complete run over unstarted work.
const done = ready.length === 0 && scoped.length === 0 && (onlyModule
  ? live.filter((t) => t.module === onlyModule).length === 0
  : blocked.length === 0 && cycle.length === 0)

const out = {
  root,
  module: onlyModule || null,
  ready: ready.map((t) => ({ id: t.id, path: t.path, module: t.module, blockedBy: t.blockedBy })),
  readyTotal: scoped.length,
  blocked,
  unreachable: [...unreachable.entries()]
    .filter(([id]) => inScope(byId.get(id)))
    .map(([id, reason]) => ({ id, reason }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)),
  cycle,
  delivered: [...delivered].filter((id) => byId.has(id)).sort(),
  failed: [...failed].filter((id) => byId.has(id)).sort(),
  ticketCount: all.length,
  done,
  unknownIds,
  notes,
}

for (const n of notes) console.log(`! ${n}`)
console.log(
  `wave: ${ready.length} ready, ${blocked.length} blocked, ${out.unreachable.length} unreachable, ` +
    `${out.delivered.length} delivered${done ? ' — nothing left to run' : ''}`
)
console.log('WAVE-PLAN-JSON: ' + JSON.stringify(out))

// A cycle is a spec defect: exit non-zero so a caller that ignores the JSON still stops.
process.exit(cycle.length ? 1 : 0)
