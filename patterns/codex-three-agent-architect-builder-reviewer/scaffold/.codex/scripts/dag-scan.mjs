#!/usr/bin/env node
// dag-scan.mjs — the flat ticket graph, for /start-all's scheduler.
//
// milestone-dag.mjs answers "what MODULE order should the runner use". start-all no
// longer needs that: it schedules every ticket from one graph gated only by blocked_by.
// This emits exactly that graph — one flat list, cross-module edges intact.
//
// It is also what makes the DAG dynamic. A running start-all workflow re-executes this
// script after each settled ticket and diffs the stable JSON output.
//
// Usage: node .codex/scripts/dag-scan.mjs [prd-root]     (default: docs/prd)
// Output: a short human summary + a final machine-readable line:
//   SCAN-JSON: {"count":N,"modules":[...],"tickets":[{id,module,path,blockedBy}]}
// Exit 1 on: missing root, no modules, a blocked_by referencing an unknown ticket id,
// or a dependency cycle — the same loud failures milestone-dag.mjs enforces. A caller
// mid-run should treat a non-zero exit as "keep the graph I already have", never as
// "the run is over": a half-written ticket must not kill work already in flight.

import { existsSync } from 'node:fs'
import { buildPlan } from './dag-core.mjs'

const root = process.argv[2] || 'docs/prd'
if (!existsSync(root)) {
  console.error(`no such prd root: ${root}`)
  process.exit(1)
}

const plan = buildPlan(root)
if (plan.empty) {
  console.error(`no modules with tickets under ${root}`)
  process.exit(1)
}
if (plan.errors && plan.errors.length) {
  for (const e of plan.errors) console.error(`x ${e}`)
  process.exit(1)
}
if (plan.moduleCycle) {
  console.error(`x dependency cycle among: ${plan.moduleCycle.join(', ')}`)
  process.exit(1)
}
if (plan.ticketCycle) {
  console.error(`x intra-module dependency cycle in ${plan.ticketCycle.module} among: ${plan.ticketCycle.cycle.join(', ')}`)
  process.exit(1)
}

// Emit in module-DAG order then intra-module topological order. The scheduler does not
// depend on this (blocked_by gates it), but a deterministic order keeps the scheduler's
// tiebreak stable and makes two runs over an unchanged tree byte-comparable.
const byId = {}
for (const mod of Object.values(plan.modules)) for (const t of mod.tickets) byId[t.id] = t

const tickets = []
for (const m of plan.order) {
  for (const id of plan.ticketOrder[m]) {
    const t = byId[id]
    tickets.push({ id: t.id, module: m, path: t.file, blockedBy: t.blockedBy })
  }
}

console.log(`scanned ${root}: ${plan.order.length} module(s), ${tickets.length} ticket(s)`)
console.log('SCAN-JSON: ' + JSON.stringify({ count: tickets.length, modules: plan.order, tickets }))
