#!/usr/bin/env node
// milestone-dag.mjs — deterministic module-DAG computation for /start-all.
// Ground truth is ticket frontmatter (`blocked_by`), never prose: module A depends on
// module B when any ticket in A is blocked_by a ticket living in B.
//
// Usage: node .codex/scripts/milestone-dag.mjs [prd-root]     (default: docs/prd)
// Output: human-readable plan + a final machine-readable line:
//   DAG-JSON: {"order":[...],"modules":{"<name>":{"tickets":[ids],"dependsOn":[names]}}}
// Exit 1 on: missing root, a blocked_by referencing an unknown ticket id (zero-silence:
// a dangling dependency is a spec error, not a warning), or a dependency cycle.
//
// Parsing, topological sort, and intra-module ordering live in dag-core.mjs, shared
// with dag-report.mjs — one parser, so the runner's DAG and the human-facing view can
// never disagree. This file owns the stdout contract; keep it byte-stable.

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

const { order, modules, ticketOrder } = plan

for (const m of order) {
  const deps = [...modules[m].dependsOn].sort()
  console.log(`${m}  (${modules[m].tickets.length} ticket(s))${deps.length ? '  <- depends on: ' + deps.join(', ') : ''}`)
}
const json = {
  order,
  modules: Object.fromEntries(order.map((m) => [m, { tickets: ticketOrder[m], dependsOn: [...modules[m].dependsOn].sort() }])),
}
console.log('DAG-JSON: ' + JSON.stringify(json))
