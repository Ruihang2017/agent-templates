#!/usr/bin/env node
// dispatch-spokes.mjs — the deterministic driver. This is the whole middle of the
// pattern: it turns validated briefs into parallel headless executor runs and reports
// what actually happened. No model is in this loop.
//
//   node .claude/scripts/dispatch-spokes.mjs --briefs docs/briefs [options]
//
//   --briefs <dir>        directory of *.md task briefs (required)
//   --base <ref>          branch the spoke worktrees fork from (default: current HEAD's
//                         upstream default; pass explicitly in CI)
//   --concurrency <n>     spokes running at once (default 4)
//   --repair-cap <n>      self-repair rounds after a failing test_cmd (default 3)
//   --only <id,id>        dispatch only these brief ids
//   --done <id,id>        treat these ids as already delivered when computing the wave
//   --codex <bin>         executor binary (default `codex`) — overridable so the driver
//                         can be exercised without spending tokens
//   --effort <level>      model_reasoning_effort for the spokes (default `low`)
//   --model <name>        executor model override, passed through as `-m`
//   --dry-run             validate + plan + print, create nothing
//   --json                machine-readable report on stdout
//
// Exit codes: 0 all dispatched spokes passed their gate · 1 at least one spoke failed or
// was quarantined · 2 the briefs themselves are invalid (nothing was dispatched).
//
// THE EXECUTOR'S OWN EXIT CODE IS NOT A COMPLETION SIGNAL. `codex exec`'s exit codes are
// not documented (checked 2026-08-10), so this driver never infers success from them. A
// spoke counts as having finished only when it left a parseable result artifact at the
// path given to `--output-schema`/`-o`; anything else is a failure, however it exited.
// The exit code that IS load-bearing belongs to the project's own `test_cmd`, which is
// the project's contract, not the executor's.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPaths } from './firewall.mjs'
import { danglingDeps, findCycle, parseBrief, readyBriefs, scopeConflicts, validateBrief } from './brief.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const WT_ROOT = join(REPO, '.claude', 'worktrees')
const RESULT_FILE = '.spoke-result.json'
const TASK_FILE = 'TASK.md'
const TEST_CMD_FILE = '.test_cmd'

// The schema the executor's final message must conform to. Keeping it tiny is the point:
// the driver needs to know "did you finish, and what did you not do", nothing more. Rich
// self-reports invite the executor to grade its own work, which is exactly what the
// firewall audit exists to avoid depending on.
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    blocked_reason: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------- args

function parseArgs(argv) {
  const o = { concurrency: 4, repairCap: 3, codex: 'codex', effort: 'low' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--briefs') o.briefs = next()
    else if (a === '--base') o.base = next()
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number(next()) || 1)
    else if (a === '--repair-cap') o.repairCap = Math.max(0, Number(next()) || 0)
    else if (a === '--only') o.only = next().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--done') o.done = next().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--codex') o.codex = next()
    else if (a === '--effort') o.effort = next()
    else if (a === '--model') o.model = next()
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--json') o.json = true
    else if (a === '--help' || a === '-h') o.help = true
    else { console.error(`unknown argument: ${a}`); process.exit(2) }
  }
  return o
}

// ---------------------------------------------------------------------------- git

const git = (args, opts = {}) => {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', ...opts })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`)
  return (r.stdout || '').trim()
}
const gitTry = (args, opts = {}) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8', ...opts })

function defaultBase(explicit) {
  if (explicit) return explicit
  const head = gitTry(['rev-parse', '--abbrev-ref', 'HEAD'])
  return head.status === 0 ? (head.stdout || '').trim() : 'HEAD'
}

// ---------------------------------------------------------------------------- run

/**
 * Run a command, capturing output, without ever blocking the event loop.
 *
 * `opts.input`, when given, is written to the child's stdin and the stream is closed.
 * The executor prompt goes this way rather than as an argv element: a brief plus a tail
 * of test output can be tens of kilobytes, and Linux caps a single argument string at
 * about 128 KB (MAX_ARG_STRLEN), which fails as a confusing spawn error rather than as
 * anything resembling "your prompt was too long".
 */
function run(cmd, args, opts = {}) {
  const { input, ...rest } = opts
  return new Promise((res) => {
    const p = spawn(cmd, args, { encoding: 'utf8', ...rest })
    let out = '', err = ''
    p.stdout?.on('data', (d) => { out += d })
    p.stderr?.on('data', (d) => { err += d })
    p.on('error', (e) => res({ status: null, out, err: err + String(e.message) }))
    p.on('close', (status) => res({ status, out, err }))
    if (input !== undefined && p.stdin) {
      // A child that ignores stdin makes this EPIPE; that is not an error worth failing
      // the run over, so it is swallowed here rather than crashing the driver.
      p.stdin.on('error', () => {})
      p.stdin.end(input)
    }
  })
}

/**
 * How to actually invoke the executor.
 *
 * A `.mjs`/`.js` path is run through this Node binary. That exists so the driver can be
 * exercised against a stand-in executor in tests, with no tokens and no network — the
 * alternative is an untested driver, which is the more expensive option.
 *
 * On Windows an npm-installed CLI is usually a `.cmd` shim, which `spawn` will not
 * resolve without a shell; pass `--codex codex.cmd` there rather than making every
 * invocation go through a shell, which would require quoting paths that contain spaces.
 */
function executorCommand(bin, args) {
  return /\.(mjs|js)$/i.test(bin) ? { cmd: process.execPath, args: [bin, ...args] } : { cmd: bin, args }
}

/** Bounded-concurrency map. Preserves input order in the result array. */
async function pool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------- brief loading

function loadBriefs(dir) {
  const abs = resolve(REPO, dir)
  if (!existsSync(abs)) { console.error(`briefs directory not found: ${abs}`); process.exit(2) }
  const files = readdirSync(abs).filter((f) => f.endsWith('.md')).sort()
  if (!files.length) { console.error(`no *.md briefs in ${abs}`); process.exit(2) }
  return files.map((f) => parseBrief(readFileSync(join(abs, f), 'utf8'), f))
}

/**
 * Gate the whole brief set before creating a single worktree.
 *
 * Deliberately all-or-nothing: with one invalid brief the decomposition is suspect, and
 * dispatching the rest would burn N executor runs against a plan that is already known to
 * be wrong somewhere. Cheaper to send the hub back for one more pass.
 */
function gateBriefs(briefs) {
  const errors = []
  for (const b of briefs) errors.push(...validateBrief(b))

  const seen = new Map()
  for (const b of briefs) {
    const id = b.data.id
    if (!id) continue
    if (seen.has(id)) errors.push(`duplicate id \`${id}\` in ${seen.get(id)} and ${b.source}`)
    else seen.set(id, b.source)
  }
  for (const d of danglingDeps(briefs)) errors.push(`${d.id}: blocked_by \`${d.missing}\` which no brief defines`)
  const cycle = findCycle(briefs)
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`)
  for (const c of scopeConflicts(briefs)) {
    errors.push(`${c.a} and ${c.b} are unordered but their file-scopes can overlap (${c.overlaps.join(', ')}) — they may run in the same wave`)
  }
  return errors
}

// ---------------------------------------------------------------------------- spoke

function briefPrompt(b) {
  return [
    `You are implementing exactly one task brief, in this worktree, alone.`,
    ``,
    `Rules that are not negotiable:`,
    `- Write ONLY inside the file-scope declared in the brief. Anything else is a failure.`,
    `- Never modify dependency, lock, build, CI, or agent-configuration files. If the task`,
    `  cannot be done without one, stop and return status "blocked" with the reason.`,
    `- The brief already fixes the interface contract. Implement it as written. Do not`,
    `  redesign it, and do not "improve" the contract.`,
    `- Do not commit; the driver commits for you.`,
    ``,
    `The brief follows.`,
    ``,
    b.raw,
  ].join('\n')
}

async function runExecutor(o, wt, prompt) {
  const args = [
    'exec',
    '--sandbox', 'workspace-write',
    '-C', wt,
    '--skip-git-repo-check',
    '-c', `model_reasoning_effort=${o.effort}`,
    '--output-schema', join(wt, '.spoke-schema.json'),
    '-o', join(wt, RESULT_FILE),
  ]
  if (o.model) args.push('-m', o.model)
  // `codex exec -` reads the prompt from stdin — documented, and the only form that is
  // safe for a prompt of arbitrary length (see run()'s note on MAX_ARG_STRLEN).
  args.push('-')
  const { cmd, args: full } = executorCommand(o.codex, args)
  const r = await run(cmd, full, { cwd: wt, input: prompt })

  // Completion is read from the artifact, never from r.status — see the header note.
  let result = null
  const path = join(wt, RESULT_FILE)
  if (existsSync(path)) {
    try { result = JSON.parse(readFileSync(path, 'utf8')) } catch { result = null }
  }
  return { result, raw: r }
}

async function runTestCmd(wt, cmd) {
  // shell: true because test_cmd is a shell one-liner supplied by the project, which is
  // the whole point of .test_cmd — the driver must never know the test framework.
  const r = await run(cmd, [], { cwd: wt, shell: true })
  return { pass: r.status === 0, status: r.status, log: (r.out + '\n' + r.err).trim() }
}

async function runSpoke(o, b, base) {
  const id = b.data.id
  const branch = `spoke/${id}`
  const wt = join(WT_ROOT, id)
  const rec = { id, branch, worktree: wt, repairs: 0, status: 'failed', reason: '', audit: null }

  // A stale worktree from an aborted run would silently be reused with the previous
  // spoke's edits still in it, and the audit would then blame this brief for them.
  if (existsSync(wt)) { gitTry(['worktree', 'remove', '--force', wt]); rmSync(wt, { recursive: true, force: true }) }
  gitTry(['branch', '-D', branch])
  mkdirSync(WT_ROOT, { recursive: true })
  try { git(['worktree', 'add', '-b', branch, wt, base]) }
  catch (e) { rec.reason = `worktree creation failed: ${e.message}`; return rec }

  writeFileSync(join(wt, TASK_FILE), b.raw)
  writeFileSync(join(wt, TEST_CMD_FILE), String(b.data.test_cmd).trim() + '\n')
  writeFileSync(join(wt, '.spoke-schema.json'), JSON.stringify(RESULT_SCHEMA, null, 2))
  // Driver scratch is removed before the commit rather than excluded via a gitignore
  // rule. A linked worktree does not get its own effective `info/exclude` — git resolves
  // that from the common git dir — so an exclude written per worktree silently does
  // nothing, and every spoke's audit then reports the DRIVER's own files as out-of-scope
  // changes. Deleting them is unconditional and behaves identically on every platform.
  const SCRATCH = [TASK_FILE, TEST_CMD_FILE, RESULT_FILE, '.spoke-schema.json']

  let prompt = briefPrompt(b)
  let last = null
  for (let round = 0; round <= o.repairCap; round++) {
    rec.repairs = round
    const exec = await runExecutor(o, wt, prompt)
    if (!exec.result) {
      rec.reason = `executor produced no parseable result artifact (${RESULT_FILE}) — treating as failure regardless of its exit code (${exec.raw.status})`
      break
    }
    if (exec.result.status === 'blocked') {
      rec.status = 'blocked'
      rec.reason = exec.result.blocked_reason || exec.result.summary || 'executor reported blocked'
      break
    }
    last = await runTestCmd(wt, String(b.data.test_cmd).trim())
    if (last.pass) { rec.status = 'passed'; rec.reason = exec.result.summary || ''; break }
    if (round === o.repairCap) {
      rec.status = 'failed'
      rec.reason = `test_cmd still failing after ${o.repairCap} self-repair round(s) — escalating to the hub`
      break
    }
    prompt = [
      briefPrompt(b),
      ``,
      `Your previous attempt left the project's test command failing.`,
      `Command: ${String(b.data.test_cmd).trim()}`,
      `Exit code: ${last.status}`,
      `Output (tail):`,
      last.log.split('\n').slice(-120).join('\n'),
      ``,
      `Fix it, still inside the declared file-scope. Do not change the test command, and`,
      `do not weaken or delete tests to make them pass.`,
    ].join('\n')
  }
  rec.testLog = last ? last.log.split('\n').slice(-40).join('\n') : ''

  // Commit whatever the spoke produced, then audit the committed diff. Committing first
  // matters: the audit must see the same thing the hub will later merge, not a working
  // tree that still has uncommitted edits in it.
  for (const f of SCRATCH) rmSync(join(wt, f), { force: true })
  const add = gitTry(['add', '-A'], { cwd: wt })
  if (add.status === 0) {
    gitTry(['-c', 'user.name=spoke', '-c', 'user.email=spoke@local', 'commit', '-m', `${id}: ${b.data.title}`, '--allow-empty'], { cwd: wt })
  }
  const diff = gitTry(['diff', '--name-only', `${base}...${branch}`])
  const changed = diff.status === 0 ? (diff.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean) : []
  rec.audit = auditPaths(changed, { scope: b.data.file_scope })
  rec.changed = changed
  if (!rec.audit.ok) {
    // Quarantine outranks a green test run. A spoke that passed its tests while writing
    // outside its scope is the more dangerous outcome, not the safer one: the tests
    // passing is exactly what would otherwise wave it through.
    rec.status = 'quarantined'
    rec.reason = [
      rec.audit.denied.length ? `wrote firewall-denied path(s): ${rec.audit.denied.join(', ')}` : '',
      rec.audit.outOfScope.length ? `wrote outside its declared file-scope: ${rec.audit.outOfScope.join(', ')}` : '',
    ].filter(Boolean).join('; ')
  }
  return rec
}

// ---------------------------------------------------------------------------- main

const o = parseArgs(process.argv.slice(2))
if (o.help || !o.briefs) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'))
  process.exit(o.briefs ? 0 : 2)
}

const all = loadBriefs(o.briefs)
// The prompt payload is the brief's ORIGINAL text, re-read from disk. Re-serialising the
// parsed object would hand the executor a paraphrase, and the entire premise of the
// pattern is that the executor implements exactly what the hub wrote.
{
  const abs = resolve(REPO, o.briefs)
  for (const b of all) b.raw = readFileSync(join(abs, b.source), 'utf8')
}

const gateErrors = gateBriefs(all)
if (gateErrors.length) {
  console.error('briefs did not pass the dispatch gate — nothing was dispatched:\n')
  for (const e of gateErrors) console.error(`  - ${e}`)
  console.error('\nFix the briefs (this is a hub task, not a spoke task) and re-run.')
  process.exit(2)
}

let wave = readyBriefs(all, o.done || [])
if (o.only) wave = wave.filter((b) => o.only.includes(b.data.id))
const base = defaultBase(o.base)

if (o.dryRun) {
  const report = {
    base,
    concurrency: o.concurrency,
    briefs: all.length,
    wave: wave.map((b) => ({ id: b.data.id, title: b.data.title, scope: b.data.file_scope, test_cmd: b.data.test_cmd })),
    blocked: all.filter((b) => !wave.includes(b)).map((b) => b.data.id),
  }
  console.log(o.json ? JSON.stringify(report, null, 2) : renderDry(report))
  process.exit(0)
}

if (!wave.length) { console.error('no brief is ready to dispatch (check --done / --only)'); process.exit(2) }

const records = await pool(wave, o.concurrency, (b) => runSpoke(o, b, base))
const summary = {
  base,
  dispatched: records.length,
  passed: records.filter((r) => r.status === 'passed').map((r) => r.id),
  failed: records.filter((r) => r.status === 'failed').map((r) => r.id),
  blocked: records.filter((r) => r.status === 'blocked').map((r) => r.id),
  quarantined: records.filter((r) => r.status === 'quarantined').map((r) => r.id),
  records,
}
console.log(o.json ? JSON.stringify(summary, null, 2) : renderRun(summary))
process.exit(summary.passed.length === records.length ? 0 : 1)

// ---------------------------------------------------------------------------- render

function renderDry(r) {
  const lines = [`dispatch plan (dry run) — base ${r.base}, concurrency ${r.concurrency}`, '']
  for (const w of r.wave) lines.push(`  READY  ${w.id}  ${w.title}\n         scope: ${(w.scope || []).join(' ')}\n         test:  ${w.test_cmd}`)
  if (r.blocked.length) lines.push('', `  waiting on dependencies: ${r.blocked.join(', ')}`)
  return lines.join('\n')
}

function renderRun(s) {
  const lines = [`dispatched ${s.dispatched} spoke(s) from ${s.base}`, '']
  for (const r of s.records) {
    lines.push(`  ${r.status.toUpperCase().padEnd(12)} ${r.id}  (${r.repairs} repair round(s))  ${r.branch}`)
    if (r.reason) lines.push(`               ${r.reason}`)
  }
  lines.push('')
  lines.push(`  passed ${s.passed.length} · failed ${s.failed.length} · blocked ${s.blocked.length} · quarantined ${s.quarantined.length}`)
  if (s.quarantined.length) lines.push(`  QUARANTINED branches are NOT mergeable — a scope or firewall violation is a hub decision.`)
  return lines.join('\n')
}
