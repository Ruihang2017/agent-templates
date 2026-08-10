#!/usr/bin/env node
// A stand-in for the Codex CLI, so suite-hub can drive dispatch-spokes.mjs end to end
// with zero tokens and zero network.
//
// It reads its behaviour from FAKE_CODEX_SCRIPT — a JSON file mapping brief id to a
// scenario — which lets one suite exercise the good path, the out-of-scope path, the
// firewall path, the repair loop, the "blocked" report, and the case that matters most:
// an executor that exits 0 while leaving NO result artifact.
//
// It deliberately parses the same flags the driver passes, and asserts nothing itself —
// the suite asserts. Its job is only to be a controllable executor.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

const cwd = flag('-C') || process.cwd()
const outPath = flag('-o')
const schemaPath = flag('--output-schema')
const effort = (argv.find((a) => a.startsWith('model_reasoning_effort=')) || '').split('=')[1]
const sandbox = flag('--sandbox')

// Record every invocation so the suite can assert on the flags the driver actually used
// — an executor contract that is only described in a comment is not a contract.
if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ cwd, outPath, schemaPath, effort, sandbox, argv }) + '\n')
}

const id = (readFileSync(join(cwd, 'TASK.md'), 'utf8').match(/^id:\s*(\S+)/m) || [])[1]
const script = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCRIPT, 'utf8'))
const plan = script[id] || script.default || { write: {}, status: 'done' }

// A repair round is the SECOND (and later) invocation for the same id. The scenario can
// give a different behaviour per round, which is how the suite proves the repair loop
// both runs and terminates.
// Kept OUTSIDE the worktree: a counter file inside it would show up in the spoke's diff
// and every audit assertion would then be measuring the test harness, not the driver.
const counterFile = (process.env.FAKE_CODEX_LOG || join(cwd, 'x')) + '.round.' + id
const round = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0
writeFileSync(counterFile, String(round + 1))
const step = Array.isArray(plan.rounds) ? plan.rounds[Math.min(round, plan.rounds.length - 1)] : plan

for (const [rel, content] of Object.entries(step.write || {})) {
  const abs = resolve(cwd, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

// The load-bearing case: `noResult` writes nothing to -o but still exits 0. A driver that
// trusted the exit code would call this a success.
if (!step.noResult && outPath) {
  writeFileSync(outPath, JSON.stringify({
    status: step.status || 'done',
    summary: step.summary || `fake executor handled ${id}`,
    ...(step.blocked_reason ? { blocked_reason: step.blocked_reason } : {}),
  }))
}

process.exit(step.exit === undefined ? 0 : step.exit)
