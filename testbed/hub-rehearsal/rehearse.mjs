#!/usr/bin/env node
// Level-1 rehearsal driver for `hub-and-spoke-orchestrator-executors`.
//
//   node testbed/hub-rehearsal/rehearse.mjs [--concurrency 2] [--keep] [--codex <bin>]
//
// SPENDS REAL TOKENS. It invokes the real Codex CLI once per brief (plus once per repair
// round). Nothing in `run-e2e.mjs` calls this — the Level-0 gate stays deterministic and
// free. Run it deliberately, when the executor integration itself needs proving.
//
// The rehearsal never touches this repository. The project under `testbed/hub-rehearsal/`
// is copied to a temp directory and git-initialised there, so the spoke branches and
// worktrees this creates land in a throwaway repo — the catalog repo never grows a
// `spoke/*` branch. That is the same rule the three-agent rehearsal follows: a rehearsal
// never writes a real default branch.
//
// What it proves that Level 0 cannot:
//   - the real executor accepts the driver's flags and returns a schema-conforming result
//   - a brief written by the hub is implementable by a LOW-effort executor
//   - wave scheduling works with real executors (wave 2 is gated on wave 1 merging)
//   - concurrent spokes in separate worktrees do not corrupt each other
//   - the whole project suite passes after every merge — the thing each brief's own
//     scoped test_cmd cannot check

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SCRIPTS = join(REPO, 'patterns', 'hub-and-spoke-orchestrator-executors', 'scaffold', '.claude', 'scripts')

const argv = process.argv.slice(2)
const opt = (name, dflt) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1] }
const CONCURRENCY = opt('--concurrency', '2')
const CODEX = opt('--codex', 'codex')
const KEEP = argv.includes('--keep')

const run = (cmd, args, opts = {}) => new Promise((res) => {
  const p = spawn(cmd, args, { encoding: 'utf8', ...opts })
  let out = '', err = ''
  p.stdout?.on('data', (d) => { out += d; process.stdout.write(d) })
  p.stderr?.on('data', (d) => { err += d; process.stderr.write(d) })
  p.on('error', (e) => res({ status: null, out, err: err + e.message }))
  p.on('close', (status) => res({ status, out, err }))
})
const quiet = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })

const dir = mkdtempSync(join(tmpdir(), 'hub-rehearsal-'))
console.log(`rehearsal workspace: ${dir}\n`)

let failed = false
const step = (label, ok, detail = '') => {
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ' — ' + detail}`)
  if (!ok) failed = true
  return ok
}

try {
  // 1. copy the project template, minus this driver
  for (const entry of ['docs', 'test', 'package.json']) {
    cpSync(join(HERE, entry), join(dir, entry), { recursive: true })
  }
  cpSync(SCRIPTS, join(dir, '.claude', 'scripts'), { recursive: true })
  // adopt would write this; the rehearsal repo is built by hand, so do it here
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dir, '.gitignore'), '.claude/worktrees/\n')

  const git = (args, o = {}) => quiet('git', args, { cwd: dir, ...o })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'rehearsal@local'])
  git(['config', 'user.name', 'hub-rehearsal'])
  git(['add', '-A'])
  git(['commit', '-qm', 'seed: PRD, briefs and tests — no implementation'])

  // 2. the baseline must FAIL. A rehearsal that starts green proves nothing.
  const baseline = quiet(process.execPath, ['--test'], { cwd: dir })
  step('baseline suite fails before any spoke runs', baseline.status !== 0,
    `expected non-zero, got ${baseline.status}`)

  // 3. the brief set must clear the dispatch gate
  console.log('\n--- dry run ---')
  const dry = await run(process.execPath,
    [join(dir, '.claude', 'scripts', 'dispatch-spokes.mjs'), '--briefs', 'docs/briefs', '--dry-run', '--json'],
    { cwd: dir })
  step('brief set clears the dispatch gate', dry.status === 0)
  const plan = dry.status === 0 ? JSON.parse(dry.out) : { wave: [], blocked: [] }
  step('wave 1 holds the briefs with no dependencies', plan.wave.length >= 2,
    `wave = ${plan.wave.map((w) => w.id).join(',')}`)
  step('dependent briefs are held back', plan.blocked.length >= 1,
    `blocked = ${plan.blocked.join(',')}`)

  // 4. run the waves, collecting and merging between them — wave 2 can only start once
  //    wave 1 is on main, because its worktrees fork from main
  const done = []
  for (let wave = 1; wave <= 4; wave++) {
    const args = [join(dir, '.claude', 'scripts', 'dispatch-spokes.mjs'),
      '--briefs', 'docs/briefs', '--base', 'main', '--concurrency', CONCURRENCY, '--codex', CODEX]
    if (done.length) args.push('--done', done.join(','))
    const planned = await run(process.execPath, [...args, '--dry-run', '--json'], { cwd: dir })
    const ids = planned.status === 0 ? JSON.parse(planned.out).wave.map((w) => w.id) : []
    if (!ids.length) break

    console.log(`\n--- wave ${wave}: ${ids.join(', ')} (concurrency ${CONCURRENCY}) ---`)
    const d = await run(process.execPath, args, { cwd: dir })
    step(`wave ${wave} dispatched cleanly`, d.status === 0)

    console.log(`\n--- collecting wave ${wave} ---`)
    const c = await run(process.execPath,
      [join(dir, '.claude', 'scripts', 'collect.mjs'), '--briefs', 'docs/briefs', '--all', '--base', 'main', '--merge'],
      { cwd: dir })
    step(`wave ${wave} merged`, c.status === 0)

    // Only ids that actually LANDED count as done. Marking the whole wave done regardless
    // of outcome makes the next wave skip a brief that never delivered, and the run ends
    // looking merely incomplete instead of failed — the failure hides itself.
    const landed = new Set(
      quiet('git', ['log', '--oneline', 'main'], { cwd: dir }).stdout
        .split('\n').flatMap((l) => ids.filter((id) => l.includes(`merge spoke/${id}`))))
    for (const id of ids) {
      quiet('git', ['worktree', 'remove', '--force', join(dir, '.claude', 'worktrees', id)], { cwd: dir })
      quiet('git', ['branch', '-D', `spoke/${id}`], { cwd: dir })
      if (landed.has(id)) done.push(id)
    }
    const stalled = ids.filter((id) => !landed.has(id))
    if (stalled.length) {
      step(`wave ${wave} landed every brief it dispatched`, false, `did not land: ${stalled.join(', ')}`)
      break
    }
    // the whole suite after each wave: each brief's own test_cmd is scoped to its module,
    // so this is the only check that the modules actually compose
    const suite = quiet(process.execPath, ['--test'], { cwd: dir })
    console.log(`  full suite after wave ${wave}: ${suite.status === 0 ? 'green' : 'not yet green'}`)
  }

  // 5. the whole point: everything delivered, and main passes its own suite
  console.log('\n--- final verification on main ---')
  const final = await run(process.execPath, ['--test'], { cwd: dir })
  step('the full project suite passes on main', final.status === 0)

  const expected = ['money', 'categorize', 'report', 'cli']
  const missing = expected.filter((m) => !existsSync(join(dir, 'src', `${m}.mjs`)))
  step('every module was delivered', missing.length === 0, `missing: ${missing.join(', ')}`)

  const stray = quiet('git', ['diff', '--name-only', 'HEAD'], { cwd: dir }).stdout.trim()
  step('no uncommitted leftovers on main', stray === '', stray)

  console.log('\n--- what landed ---')
  console.log(quiet('git', ['log', '--oneline', '--graph', 'main'], { cwd: dir }).stdout)
} finally {
  if (KEEP) console.log(`\nworkspace kept: ${dir}`)
  else rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? '\nREHEARSAL FAILED' : '\nREHEARSAL PASSED')
process.exit(failed ? 1 : 0)
