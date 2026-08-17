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
//   - main-session call under .claude/tmp/ -> no objection (see the carve-out below)
//   - any other main-session call -> deny, with the dispatch instruction fed back
//   - override switch for a human-approved out-of-pipeline edit: create the file
//     .claude/allow-main-writes (and delete it afterwards to re-arm the guard)
//
// THE .claude/tmp/ CARVE-OUT (catalog issues #206, #208). The pipeline delivers through
// its own executor stage, but the MANUAL path — /deliver-ticket, after a /review-ticket
// CLEAR — is the main session's, and delivering means writing one ephemeral file: the
// PR/MR body, composed from artifacts that already exist. Before this, that path did not
// exist at all: /review-ticket ended at the verdict and an operator had to run the
// delivery script by hand, outside anything the pattern described.
//
// The guard used to match Edit|Write globally, which is blunter than the rule it enforces:
// the rule is that the main session must not PLAN, IMPLEMENT or REVIEW a ticket inline,
// and composing a report out of artifacts that already exist is none of those three.
//
// Scoped as narrowly as the need: one directory, already gitignored, already the
// `--body-file` destination. The alternative was the existing .claude/allow-main-writes
// switch, which disarms the guard WHOLESALE — a run that toggled it around every delivery
// would leave the orchestrator unguarded during exactly the window where a reflexive
// inline edit is most tempting.
//
// Containment is checked with path.relative against the resolved directory, not a string
// prefix: `.claude/tmp/../../src/app.ts` is a write to src/, and a prefix test would pass
// it. A relative target is resolved against the process cwd, so a hook invoked from
// somewhere other than the repo root fails CLOSED (denied) rather than open.
//
// Only the main session is constrained here; each subagent is governed by its own
// tools/disallowedTools frontmatter (e.g. the reviewer has no Write/Edit at all).

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const inDeliveryScratch = (() => {
  if (typeof target !== "string" || !target || target === "(unknown target)") return false;
  try {
    const tmpDir = resolve(fileURLToPath(new URL("../tmp/", import.meta.url)));
    const rel = relative(tmpDir, resolve(target));
    // '' means the directory itself; a leading '..' or an absolute result means outside it
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false; // unresolvable path: deny, same as any other unknown
  }
})();

if (inDeliveryScratch) {
  process.exit(0); // delivery scratch — the orchestrator composes its PR/MR body here
}

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Three-agent pattern: the main session orchestrates and delivers, but never plans, ` +
        `implements or reviews inline (blocked ${input.tool_name} on ${target}). Dispatch ` +
        `the work to its stage instead: /plan-ticket (architect) or /build-ticket (builder). ` +
        `Delivery scratch under .claude/tmp/ is allowed and needs no override. For a ` +
        `human-approved out-of-pipeline edit, create .claude/allow-main-writes and retry ` +
        `— then delete it.`,
    },
  })
);
process.exit(0);
