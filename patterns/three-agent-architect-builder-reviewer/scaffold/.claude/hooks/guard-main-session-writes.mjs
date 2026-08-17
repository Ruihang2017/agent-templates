#!/usr/bin/env node
// Three-agent pattern guard: the ORCHESTRATOR (main session) never writes.
//
// PreToolUse hook on Edit|Write|MultiEdit|NotebookEdit (wired in .claude/settings.json).
// Per https://code.claude.com/docs/en/hooks.md (verified 2026-07-17): hooks fire for
// subagent tool calls too, and the input carries `agent_id`/`agent_type` ONLY when the
// call comes from a subagent — their absence identifies the main session.
//
// Behavior:
//   - subagent call (architect writes the plan, builder writes code) -> no objection
//   - main-session call -> deny, with the dispatch instruction fed back to the model
//   - override switch for a human-approved out-of-pipeline edit: create the file
//     .claude/allow-main-writes (and delete it afterwards to re-arm the guard)
//
// Only the main session is constrained here; each subagent is governed by its own
// tools/disallowedTools frontmatter (e.g. the reviewer has no Write/Edit at all).

import { existsSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let input = {};
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  process.exit(0); // unparsable input: stay out of the way rather than block blindly
}

const isSubagent = typeof input.agent_id === "string" && input.agent_id.length > 0;
const overrideSwitch = new URL("../allow-main-writes", import.meta.url);

if (isSubagent || existsSync(overrideSwitch)) {
  process.exit(0); // no objection; normal permission flow applies
}

const target =
  input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "(unknown target)";

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Three-agent pattern: the main session orchestrates only and never writes ` +
        `(blocked ${input.tool_name} on ${target}). Dispatch the work to its stage instead: ` +
        `/plan-ticket (architect) or /build-ticket (builder). For a human-approved ` +
        `out-of-pipeline edit, create .claude/allow-main-writes and retry — then delete it.`,
    },
  })
);
process.exit(0);
