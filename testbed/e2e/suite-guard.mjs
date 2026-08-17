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

  // ---- the .claude/tmp/ carve-out (catalog issues #206, #208) ------------------------
  // /deliver-ticket composes the PR/MR body from artifacts that already exist, in the main
  // session. That is reporting, not stage work, so one directory is carved out. It is a
  // SECURITY boundary, so it is tested by behaviour rather than by reading the source: the
  // interesting cases are the ones a naive prefix test would wave through.
  {
    const TMP = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/tmp/', import.meta.url))
    const decide = (p) => {
      const r = runHook(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: p } }))
      return r.stdout.trim() === '' ? 'allow' : 'deny'
    }
    eq(S, 'carve-out: main session may write its PR body', decide(TMP + 'T-01-mrbody.md'), 'allow')
    eq(S, 'carve-out: and the verdict scratch path', decide(TMP + 'T-01-verdict.md'), 'allow')
    // A prefix test would pass BOTH of these. path.relative does not.
    eq(S, 'carve-out: a .. escape out of tmp is DENIED', decide(TMP + '../../src/app.ts'), 'deny')
    eq(S, 'carve-out: a sibling directory sharing the prefix is DENIED',
      decide(TMP.slice(0, -1) + 'evil' + TMP.slice(-1) + 'x.md'), 'deny')
    eq(S, 'carve-out: the rest of .claude/ is still denied', decide(TMP + '../settings.json'), 'deny')
    eq(S, 'carve-out: source files are still denied', decide('src/app.ts'), 'deny')
    // The deny message must mention the carve-out, or a model that hits the guard while
    // delivering will conclude it may not deliver at all.
    const r = runHook(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } }))
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
    check(S, 'carve-out: the deny message says delivery scratch is allowed',
      reason.includes('.claude/tmp/ is allowed'))
    check(S, 'carve-out: and still forbids planning/implementing/reviewing inline',
      /never plans, implements or reviews inline/.test(reason))
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
