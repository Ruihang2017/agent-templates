// E2E for the main-session write guard: feeds the ACTUAL scaffold hook the four
// input shapes it must handle (main-session call, subagent call, garbage input,
// override switch) and asserts the deny/allow contract.

import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'guard'
const HOOK = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/hooks/guard-main-session-writes.mjs', import.meta.url))
const OVERRIDE = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/allow-main-writes', import.meta.url))

const runHook = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' })

export async function run() {
  // main-session Edit -> structured deny with dispatch instruction
  {
    const r = runHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/x.ts' } }))
    eq(S, 'main-session call exits 0', r.status, 0)
    let out = null
    try { out = JSON.parse(r.stdout) } catch {}
    check(S, 'main-session call denied', out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny')
    check(S, 'deny reason teaches dispatch', out && /plan-ticket|build-ticket/.test(out.hookSpecificOutput.permissionDecisionReason))
    check(S, 'deny reason names the blocked target', out && /src\/x\.ts/.test(out.hookSpecificOutput.permissionDecisionReason))
  }

  // subagent call (agent_id present) -> silent allow
  {
    const r = runHook(JSON.stringify({ agent_id: 'uuid-1', agent_type: 'builder', tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } }))
    eq(S, 'subagent call exits 0', r.status, 0)
    eq(S, 'subagent call passes silently', r.stdout.trim(), '')
  }

  // garbage input -> never blocks
  {
    const r = runHook('not-json-at-all')
    eq(S, 'garbage input exits 0', r.status, 0)
    eq(S, 'garbage input passes silently', r.stdout.trim(), '')
  }

  // override switch file -> main-session allow while present
  {
    writeFileSync(OVERRIDE, '')
    try {
      const r = runHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/x.ts' } }))
      eq(S, 'override: exits 0', r.status, 0)
      eq(S, 'override: main-session call allowed', r.stdout.trim(), '')
    } finally {
      rmSync(OVERRIDE, { force: true })
    }
    const r2 = runHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/x.ts' } }))
    check(S, 're-armed after override removal', /deny/.test(r2.stdout))
  }
}
