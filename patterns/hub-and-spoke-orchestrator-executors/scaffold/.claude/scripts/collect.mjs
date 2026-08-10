#!/usr/bin/env node
// collect.mjs — the hub's landing gate. Re-audits a spoke branch and, on request, merges
// it. Deterministic on purpose: in this pattern the hub reviews a diff produced against a
// contract the hub itself wrote, in the same session (pattern README section 4). Its
// judgement is therefore NOT independent, and the only checks that are independent of it
// are the ones in here, which have no opinion at all.
//
//   node .claude/scripts/collect.mjs --briefs docs/briefs [--id ID | --all] [--merge]
//
//   --briefs <dir>   directory of task briefs (required — the file-scope contract)
//   --id <ID>        collect one spoke; repeatable
//   --all            collect every spoke branch that exists
//   --base <ref>     branch to merge into (default: current HEAD)
//   --merge          actually merge the branches that clear the gate
//   --json           machine-readable report
//
// Exit codes: 0 every collected branch cleared (and merged, with --merge) · 1 at least
// one did not · 2 bad invocation / unusable inputs.
//
// Three states, deliberately distinct — collapsing them is how this repo has previously
// shipped a green gate over an artifact that never arrived:
//
//   clear        audit passed AND the test command was run here and exited 0
//   unverified   audit passed but the tests could NOT be run (no worktree to run them in)
//   blocked      audit failed, or the tests ran and failed
//
// `unverified` never merges. "I could not check" is not "it is fine", and a gate that
// treats it as such is not a gate.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPaths } from './firewall.mjs'
import { parseBrief } from './brief.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const WT_ROOT = join(REPO, '.claude', 'worktrees')

const gitTry = (args, opts = {}) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8', ...opts })
const gitOut = (args, opts = {}) => (gitTry(args, opts).stdout || '').trim()

function run(cmd, opts = {}) {
  return new Promise((res) => {
    const p = spawn(cmd, [], { shell: true, ...opts })
    let out = '', err = ''
    p.stdout?.on('data', (d) => { out += d })
    p.stderr?.on('data', (d) => { err += d })
    p.on('error', (e) => res({ status: null, log: err + String(e.message) }))
    p.on('close', (status) => res({ status, log: (out + '\n' + err).trim() }))
  })
}

// ---------------------------------------------------------------------------- args

const o = { ids: [] }
{
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--briefs') o.briefs = next()
    else if (a === '--id') o.ids.push(next())
    else if (a === '--all') o.all = true
    else if (a === '--base') o.base = next()
    else if (a === '--merge') o.merge = true
    else if (a === '--json') o.json = true
    else { console.error(`unknown argument: ${a}`); process.exit(2) }
  }
}
if (!o.briefs) { console.error('--briefs <dir> is required: the file-scope contract lives there'); process.exit(2) }
if (!o.ids.length && !o.all) { console.error('pass --id <ID> (repeatable) or --all'); process.exit(2) }

const briefsDir = resolve(REPO, o.briefs)
if (!existsSync(briefsDir)) { console.error(`briefs directory not found: ${briefsDir}`); process.exit(2) }
const briefs = new Map()
for (const f of readdirSync(briefsDir).filter((n) => n.endsWith('.md'))) {
  const b = parseBrief(readFileSync(join(briefsDir, f), 'utf8'), f)
  if (b.data.id) briefs.set(b.data.id, b)
}

const base = o.base || gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD'

const branches = gitOut(['for-each-ref', '--format=%(refname:short)', 'refs/heads/spoke'])
  .split('\n').map((s) => s.trim()).filter(Boolean)
const ids = o.all ? branches.map((b) => b.replace(/^spoke\//, '')) : o.ids

// ---------------------------------------------------------------------------- collect

const records = []
for (const id of ids) {
  const branch = `spoke/${id}`
  const rec = { id, branch, state: 'blocked', reasons: [], changed: [], audit: null, tested: false }
  records.push(rec)

  if (!branches.includes(branch)) { rec.reasons.push(`no branch ${branch}`); continue }
  const brief = briefs.get(id)
  if (!brief) { rec.reasons.push(`no brief defines ${id} — cannot check its file-scope, so it cannot be cleared`); continue }

  const diff = gitTry(['diff', '--name-only', `${base}...${branch}`])
  if (diff.status !== 0) { rec.reasons.push(`cannot diff ${base}...${branch}: ${(diff.stderr || '').trim()}`); continue }
  rec.changed = (diff.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)

  rec.audit = auditPaths(rec.changed, { scope: brief.data.file_scope })
  if (rec.audit.denied.length) rec.reasons.push(`firewall: ${rec.audit.denied.join(', ')}`)
  if (rec.audit.outOfScope.length) rec.reasons.push(`out of declared file-scope: ${rec.audit.outOfScope.join(', ')}`)

  if (!rec.changed.length) rec.reasons.push('branch changes nothing — an empty delivery is not a delivery')

  const wt = join(WT_ROOT, id)
  const testCmd = String(brief.data.test_cmd || '').trim()
  if (!testCmd) rec.reasons.push('brief declares no test_cmd')
  else if (!existsSync(wt)) {
    // Deliberately NOT silently skipped, and deliberately not merged either.
    rec.tested = false
    rec.reasons.push(`worktree ${wt} is gone — the tests could not be re-run here`)
  } else {
    const t = await run(testCmd, { cwd: wt })
    rec.tested = true
    rec.testStatus = t.status
    rec.testLog = t.log.split('\n').slice(-40).join('\n')
    if (t.status !== 0) rec.reasons.push(`test_cmd exited ${t.status}`)
  }

  const auditClean = rec.audit.ok && rec.changed.length > 0
  if (!auditClean || (rec.tested && rec.testStatus !== 0)) rec.state = 'blocked'
  else if (!rec.tested) rec.state = 'unverified'
  else rec.state = 'clear'
}

// ---------------------------------------------------------------------------- merge

if (o.merge) {
  const dirty = gitOut(['status', '--porcelain', '-uall'])
    .split('\n').filter((l) => l.trim() && !/\.claude\/worktrees\//.test(l))
  if (dirty.length) {
    console.error('refusing to merge: the working tree has uncommitted changes:\n' + dirty.join('\n'))
    process.exit(2)
  }
  const onBase = gitOut(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (onBase !== base) {
    const co = gitTry(['checkout', base])
    if (co.status !== 0) { console.error(`cannot check out ${base}: ${(co.stderr || '').trim()}`); process.exit(2) }
  }
  for (const rec of records) {
    if (rec.state !== 'clear') { rec.merged = false; continue }
    const m = gitTry(['merge', '--no-ff', '-m', `merge ${rec.branch}`, rec.branch])
    if (m.status === 0) { rec.merged = true; continue }
    // A conflict here means two spokes wrote the same path despite the scope audit — i.e.
    // the decomposition was wrong, not the code. Abort rather than resolve: resolving it
    // would hide the decomposition error that produced it.
    gitTry(['merge', '--abort'])
    rec.merged = false
    rec.state = 'blocked'
    rec.reasons.push(`merge into ${base} conflicted — two spokes contend for the same paths; re-cut the briefs rather than resolving by hand`)
  }
}

// ---------------------------------------------------------------------------- report

const summary = {
  base,
  merged: o.merge === true,
  clear: records.filter((r) => r.state === 'clear').map((r) => r.id),
  unverified: records.filter((r) => r.state === 'unverified').map((r) => r.id),
  blocked: records.filter((r) => r.state === 'blocked').map((r) => r.id),
  records,
}

if (o.json) console.log(JSON.stringify(summary, null, 2))
else {
  const lines = [`collect against ${base}${o.merge ? ' (merging)' : ''}`, '']
  for (const r of records) {
    lines.push(`  ${r.state.toUpperCase().padEnd(11)} ${r.id}  ${r.changed.length} file(s)${o.merge ? (r.merged ? '  merged' : '  not merged') : ''}`)
    for (const reason of r.reasons) lines.push(`              - ${reason}`)
  }
  lines.push('')
  lines.push(`  clear ${summary.clear.length} · unverified ${summary.unverified.length} · blocked ${summary.blocked.length}`)
  if (summary.unverified.length) lines.push(`  UNVERIFIED is not a pass: those branches were audited but their tests were never run here.`)
  console.log(lines.join('\n'))
}

const ok = records.length > 0 && records.every((r) => r.state === 'clear' && (!o.merge || r.merged))
process.exit(ok ? 0 : 1)
