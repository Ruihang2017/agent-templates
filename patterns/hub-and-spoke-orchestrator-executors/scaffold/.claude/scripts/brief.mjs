// Task-brief parsing, validation, and scheduling.
//
// The brief is this pattern's single load-bearing artifact. A spoke runs at LOW reasoning
// effort and is explicitly NOT asked to design anything — which is only safe if the design
// is already fixed in the brief. So "is this brief complete enough to dispatch?" is not a
// matter of taste, and it is not left to the hub to remember: it is a check that runs
// before any worktree is created, and a brief that fails it is never dispatched.
//
// This is the mechanical counterpart to the pattern's largest risk. If decomposition is
// wrong, everything downstream is wrong and the low-effort executors will not notice —
// they were told not to think. Catching an under-specified brief here costs one rerun of
// the hub; catching it after dispatch costs N wasted spoke runs and a bad merge.

import { isDenied } from './firewall.mjs'

const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/

/**
 * Parse the frontmatter block plus the section headings of a brief.
 *
 * A deliberately small YAML subset — `key: scalar`, `key: []`, and `-` block lists.
 * Anything outside that subset is reported as a parse error rather than guessed at: a
 * brief is a contract, and a contract that had to be guessed at is not one.
 */
export function parseBrief(md, source = '<brief>') {
  const text = String(md).replace(/\r\n/g, '\n')
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { source, errors: [`${source}: no frontmatter block`], data: {}, body: '' }

  const errors = []
  const data = {}
  let key = null
  for (const raw of m[1].split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const item = raw.match(/^\s+-\s*(.*)$/)
    if (item) {
      if (!key || !Array.isArray(data[key])) { errors.push(`${source}: list item with no list key: ${raw.trim()}`); continue }
      data[key].push(item[1].trim().replace(/^['"]|['"]$/g, ''))
      continue
    }
    const kv = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!kv) { errors.push(`${source}: unparseable frontmatter line: ${raw.trim()}`); continue }
    key = kv[1]
    const value = kv[2].trim()
    if (value === '' ) data[key] = []
    else if (value === '[]') data[key] = []
    else if (/^\[.*\]$/.test(value)) {
      data[key] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    } else data[key] = value.replace(/^['"]|['"]$/g, '')
  }

  const body = m[2]
  const sections = {}
  let current = null
  for (const line of body.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) { current = h[1].toLowerCase(); sections[current] = []; continue }
    if (current) sections[current].push(line)
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].join('\n').trim()

  return { source, errors, data, body, sections }
}

/**
 * Required brief sections. Each one exists because a spoke cannot supply it:
 *
 *  - contract   — the interface/type/signature the spoke transcribes. Without it the
 *                 spoke is designing, which is the one thing low effort cannot do.
 *  - deliverables — what to produce, at code-level precision.
 *  - done when  — the observable outcome, so `test_cmd` passing is not the only signal.
 */
export const REQUIRED_SECTIONS = ['contract', 'deliverables', 'done when']

/**
 * Validate one parsed brief. Returns a list of human-readable errors; empty means
 * dispatchable.
 *
 * Every rule here can fail against a plausible brief — none of them is decoration:
 *  - a scope granting `**` passes a naive "scope is non-empty" check and disables the
 *    whole out-of-scope audit, so it is rejected by name;
 *  - a scope naming a denied path would be silently overridden by the firewall at audit
 *    time, producing a confusing late failure, so it is rejected at decomposition time;
 *  - a missing `test_cmd` would make the exit-code gate vacuous rather than failing.
 */
export function validateBrief(parsed) {
  const errors = [...(parsed.errors || [])]
  const d = parsed.data || {}
  const at = parsed.source || '<brief>'
  const fail = (msg) => errors.push(`${at}: ${msg}`)

  if (!d.id) fail('missing `id`')
  else if (!ID_RE.test(d.id)) fail(`id \`${d.id}\` is not of the form MOD-NN`)
  if (!d.title || !String(d.title).trim()) fail('missing `title`')

  const scope = Array.isArray(d.file_scope) ? d.file_scope.filter(Boolean) : []
  if (!scope.length) fail('`file_scope` is empty — a brief with no declared write-set can never pass the scope audit')
  for (const g of scope) {
    if (g === '**' || g === '*' || g === '.') fail(`file_scope entry \`${g}\` grants the whole repo, which disables the out-of-scope audit`)
    else if (isDenied(g)) fail(`file_scope entry \`${g}\` is on the firewall deny list — only the hub may change it`)
  }

  const testCmd = String(d.test_cmd || '').trim()
  if (!testCmd) fail('missing `test_cmd` — the exit-code gate has nothing to run')
  else if (testCmd.includes('\n')) fail('`test_cmd` must be a single line')

  const blocked = d.blocked_by === undefined ? [] : d.blocked_by
  if (!Array.isArray(blocked)) fail('`blocked_by` must be a list')

  const sections = parsed.sections || {}
  for (const s of REQUIRED_SECTIONS) {
    if (!(s in sections)) fail(`missing section \`## ${s}\``)
    else if (!sections[s]) fail(`section \`## ${s}\` is empty`)
  }
  return errors
}

/**
 * Conservative glob-intersection test: does a path exist that both globs could match?
 *
 * Deliberately OVER-approximates — when a segment on either side contains a wildcard it
 * is treated as compatible with anything. So this reports some conflicts that could not
 * actually occur, and reports no conflict that could. That is the correct direction to be
 * wrong in: a false conflict costs the hub one re-cut of a brief, a missed one costs two
 * spokes writing the same file concurrently.
 */
export function globsIntersect(a, b) {
  const A = a.split('/')
  const B = b.split('/')
  const walk = (i, j) => {
    if (i === A.length && j === B.length) return true
    if (i < A.length && A[i] === '**') return walk(i + 1, j) || (j < B.length && walk(i, j + 1))
    if (j < B.length && B[j] === '**') return walk(i, j + 1) || (i < A.length && walk(i + 1, j))
    if (i === A.length || j === B.length) return false
    const compatible = A[i].includes('*') || B[j].includes('*') || A[i] === B[j]
    return compatible && walk(i + 1, j + 1)
  }
  return walk(0, 0)
}

/**
 * Find pairs of briefs that could write the same path and are NOT ordered by blocked_by.
 * Those are the pairs that may run in the same wave, so an overlap is a real race.
 *
 * Ordering is checked TRANSITIVELY: A→B→C means A and C are ordered even though neither
 * names the other. Checking only direct edges would flag safe pairs as conflicts and
 * teach the operator to ignore the report.
 */
export function scopeConflicts(briefs) {
  const byId = new Map(briefs.map((b) => [b.data.id, b]))
  const reach = new Map()
  const reaches = (from, to, seen = new Set()) => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    const b = byId.get(from)
    if (!b) return false
    for (const dep of b.data.blocked_by || []) if (reaches(dep, to, seen)) return true
    return false
  }
  reach.clear()
  const out = []
  for (let i = 0; i < briefs.length; i++) {
    for (let j = i + 1; j < briefs.length; j++) {
      const a = briefs[i], b = briefs[j]
      if (reaches(a.data.id, b.data.id) || reaches(b.data.id, a.data.id)) continue
      const paths = []
      for (const ga of a.data.file_scope || []) {
        for (const gb of b.data.file_scope || []) if (globsIntersect(ga, gb)) paths.push(`${ga} ~ ${gb}`)
      }
      if (paths.length) out.push({ a: a.data.id, b: b.data.id, overlaps: paths })
    }
  }
  return out
}

/** Ids in `blocked_by` that no brief defines — a dangling edge deadlocks the run. */
export function danglingDeps(briefs) {
  const ids = new Set(briefs.map((b) => b.data.id))
  const out = []
  for (const b of briefs) for (const dep of b.data.blocked_by || []) if (!ids.has(dep)) out.push({ id: b.data.id, missing: dep })
  return out
}

/** The first dependency cycle found, as an id list, or null. A cycle hangs the driver. */
export function findCycle(briefs) {
  const deps = new Map(briefs.map((b) => [b.data.id, (b.data.blocked_by || []).slice()]))
  const state = new Map()
  const stack = []
  const visit = (id) => {
    if (state.get(id) === 'done') return null
    if (state.get(id) === 'open') return stack.slice(stack.indexOf(id)).concat(id)
    if (!deps.has(id)) return null
    state.set(id, 'open')
    stack.push(id)
    for (const d of deps.get(id)) { const c = visit(d); if (c) return c }
    stack.pop()
    state.set(id, 'done')
    return null
  }
  for (const id of deps.keys()) { const c = visit(id); if (c) return c }
  return null
}

/** Briefs whose dependencies are all in `doneIds` — the next wave to dispatch. */
export function readyBriefs(briefs, doneIds = []) {
  const done = new Set(doneIds)
  return briefs.filter((b) => !done.has(b.data.id) && (b.data.blocked_by || []).every((d) => done.has(d)))
}
