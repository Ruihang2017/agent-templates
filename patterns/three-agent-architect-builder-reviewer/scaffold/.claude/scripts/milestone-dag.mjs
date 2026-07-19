#!/usr/bin/env node
// milestone-dag.mjs — deterministic module-DAG computation for /start-all.
// Ground truth is ticket frontmatter (`blocked_by`), never prose: module A depends on
// module B when any ticket in A is blocked_by a ticket living in B.
//
// Usage: node .claude/scripts/milestone-dag.mjs [prd-root]     (default: docs/prd)
// Output: human-readable plan + a final machine-readable line:
//   DAG-JSON: {"order":[...],"modules":{"<name>":{"tickets":[ids],"dependsOn":[names]}}}
// Exit 1 on: missing root, a blocked_by referencing an unknown ticket id (zero-silence:
// a dangling dependency is a spec error, not a warning), or a dependency cycle.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] || 'docs/prd'
if (!existsSync(root)) {
  console.error(`no such prd root: ${root}`)
  process.exit(1)
}

const fmOf = (text) => (text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
const field = (fm, name) => ((fm.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'm')) || [])[1] || '').trim()
const listField = (fm, name) =>
  field(fm, name)
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const modules = {} // name -> { tickets: [{id, blockedBy}], dependsOn:Set }
const ticketModule = {} // ticket id -> module name
const errors = []

for (const d of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
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
    tickets.push({ id, blockedBy: listField(fm, 'blocked_by') })
  }
  if (tickets.length) modules[d] = { tickets, dependsOn: new Set() }
}

if (!Object.keys(modules).length) {
  console.error(`no modules with tickets under ${root}`)
  process.exit(1)
}

for (const [name, mod] of Object.entries(modules)) {
  for (const t of mod.tickets) {
    for (const dep of t.blockedBy) {
      const owner = ticketModule[dep]
      if (!owner) { errors.push(`${name}/${t.id}: blocked_by references unknown ticket '${dep}'`); continue }
      if (owner !== name) mod.dependsOn.add(owner)
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(`x ${e}`)
  process.exit(1)
}

// Kahn topological sort over `nodes`; `depsOf(n)` returns the nodes that must come
// before n (deps outside `nodes` are ignored by the caller). Deterministic tiebreak
// by string order — module names and ticket ids both sort with numeric prefixes
// naturally. Returns { order } or { cycle } (the nodes left when nothing is ready).
const topoSort = (nodes, depsOf) => {
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

// module order: a module depends on another via cross-module blocked_by edges
const modSort = topoSort(Object.keys(modules), (m) => [...modules[m].dependsOn])
if (modSort.cycle) {
  console.error(`x dependency cycle among: ${modSort.cycle.join(', ')}`)
  process.exit(1)
}
const order = modSort.order

// tickets WITHIN a module: order by intra-module blocked_by edges (cross-module edges
// are already satisfied by module ordering above), ID order only as tiebreak. Emitting
// bare ID order here dispatches a ticket before a sibling it is blocked_by whenever the
// declared order deviates from ID order — the run-milestone builder then stops at its
// precondition gate and the whole module fails (catalog issue #31).
const ticketOrder = {}
for (const m of order) {
  const ids = new Set(modules[m].tickets.map((t) => t.id))
  const blockedByOf = Object.fromEntries(modules[m].tickets.map((t) => [t.id, t.blockedBy.filter((d) => ids.has(d))]))
  const sorted = topoSort([...ids], (id) => blockedByOf[id])
  if (sorted.cycle) {
    console.error(`x intra-module dependency cycle in ${m} among: ${sorted.cycle.join(', ')}`)
    process.exit(1)
  }
  ticketOrder[m] = sorted.order
}

for (const m of order) {
  const deps = [...modules[m].dependsOn].sort()
  console.log(`${m}  (${modules[m].tickets.length} ticket(s))${deps.length ? '  <- depends on: ' + deps.join(', ') : ''}`)
}
const json = {
  order,
  modules: Object.fromEntries(order.map((m) => [m, { tickets: ticketOrder[m], dependsOn: [...modules[m].dependsOn].sort() }])),
}
console.log('DAG-JSON: ' + JSON.stringify(json))
