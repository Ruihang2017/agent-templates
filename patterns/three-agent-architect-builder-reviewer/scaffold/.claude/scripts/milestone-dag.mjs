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

// Kahn topological sort; deterministic tiebreak by module name (numeric prefixes sort naturally)
const order = []
const remaining = new Set(Object.keys(modules))
while (remaining.size) {
  const ready = [...remaining].filter((m) => [...modules[m].dependsOn].every((d) => !remaining.has(d))).sort()
  if (!ready.length) {
    console.error(`x dependency cycle among: ${[...remaining].sort().join(', ')}`)
    process.exit(1)
  }
  const next = ready[0]
  order.push(next)
  remaining.delete(next)
}

for (const m of order) {
  const deps = [...modules[m].dependsOn].sort()
  console.log(`${m}  (${modules[m].tickets.length} ticket(s))${deps.length ? '  <- depends on: ' + deps.join(', ') : ''}`)
}
const json = {
  order,
  modules: Object.fromEntries(order.map((m) => [m, { tickets: modules[m].tickets.map((t) => t.id), dependsOn: [...modules[m].dependsOn].sort() }])),
}
console.log('DAG-JSON: ' + JSON.stringify(json))
