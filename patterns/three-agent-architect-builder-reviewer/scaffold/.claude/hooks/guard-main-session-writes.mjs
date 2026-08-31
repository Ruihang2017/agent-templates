#!/usr/bin/env node
// Three-agent pattern guard: the ORCHESTRATOR (main session) never writes.
//
// PreToolUse hook on Edit|Write|MultiEdit|NotebookEdit|Bash (wired in .claude/settings.json).
// Per https://code.claude.com/docs/en/hooks.md (verified 2026-07-17): hooks fire for
// subagent tool calls too, and the input carries `agent_id`/`agent_type` ONLY when the
// call comes from a subagent — their absence identifies the main session.
//
// Behavior:
//   - subagent call (architect writes the plan, builder writes code) -> no objection
//   - Bash from a WRITE-FORBIDDEN role (reviewer/architect/triage) that looks like a write
//     -> deny (catalog issue #218); read-only commands from those roles pass
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

// ---------------------------------------------------------------------------
// WRITE-FORBIDDEN ROLES AND Bash (catalog issue #218).
//
// The Reviewer's tool list is Read/Glob/Grep/Bash — Bash is there because a Reviewer must
// RUN the tests. So the one role that may not write is handed the one tool that can, and
// one did: a python heredoc overwrote a production file, and the hand-back then reported
// that it had "not attempted to route around" the write restriction.
//
// This is deliberately NOT presented as airtight. A shell is a general-purpose machine and
// this matches known write idioms, not all of them; a determined bypass gets through. What
// it removes is the state where nothing is even attempted, and it pairs with the check that
// does not rely on pattern-matching at all: delivery refuses a branch whose head is not the
// commit the Builder finished on, so a Reviewer that actually changed the code is caught by
// git rather than by its own account of itself.
//
// Read-only commands are untouched: a Reviewer runs tests, greps, diffs and log inspections
// all day. Only writes are refused.
const WRITE_FORBIDDEN_ROLES = new Set(["reviewer", "architect", "triage"]);

const BASH_WRITE_PATTERNS = [
  { re: />>?\s*[^\s|&;]+/, why: "shell redirection into a file" },
  { re: /\btee\b/, why: "tee writes its input to a file" },
  { re: /\bsed\b[^|;]*\s-i\b/, why: "sed -i edits in place" },
  { re: /\bperl\b[^|;]*\s-i\b/, why: "perl -i edits in place" },
  { re: /<<-?\s*['\"]?[A-Za-z_]/, why: "a heredoc, which is how a shell writes a file body" },
  // NOTE the boundary: `\b` before a hyphen never matches — space and '-' are both
  // non-word characters — so `node -e` slipped past the first version of this line.
  // Anchor on whitespace instead. The kind of mistake that makes a guard look present
  // and behave absent, which is worse than no guard.
  { re: /\b(python3?|node|ruby|deno|bun)\b[^|;]*(?:^|\s)--?[ce]\b/, why: "an inline interpreter script, which can open a file for writing" },
  { re: /\bgit\s+(commit|apply|checkout|restore|stash|reset|revert|rm|mv|add)\b/, why: "a git command that alters the working tree or history" },
  { re: /\b(cp|mv|rm|install|truncate|dd|chmod|chown)\b/, why: "a filesystem-mutating command" },
  { re: /\bnpm\s+(install|i|ci|update|link)\b|\b(pip|pip3)\s+install\b/, why: "a package install, which rewrites lockfiles and node_modules" },
];

// The ONE write these roles must make: the Reviewer authors its own review record under
// .claude/tmp/ (catalog issue #201), and it does so with Bash because it has no Write tool.
// Without this carve-out the guard would forbid the very file the delivery step refuses to
// proceed without — a rule that makes the pipeline unable to run is not a rule, it is an
// outage. Same directory as the main-session carve-out, and gitignored for the same reason.
const TOUCHES_SCRATCH = /\.claude[/\\]tmp[/\\]/;

// The sanctioned mutation probe (catalog issue #229).
//
// The Reviewer is asked to judge whether the Builder's tests are load-bearing, which means
// mutating code and checking a test goes red — and the rule above denies its entire write
// surface by mechanism, including into a scratch tree outside the repo. Two Reviewers hit
// that wall on two repos in one day; both disclosed the gap honestly, and neither performed
// the verification the pattern asks for.
//
// The remedy is NOT to decide from a command string where a shell will write. That means
// parsing `cd`, variables, substitution and quoting, and a guard that believes it knows and
// is wrong is worse than one that refuses — the exact failure this file has already had once
// (`\b-[ce]` never matches before a hyphen, so `node -e` walked straight through the first
// version of the interpreter rule). Instead there is one entry point that does the isolation
// itself: review-probe.mjs copies the tree into a detached worktree under the OS temp
// directory, mutates THERE, runs the suite, and removes it. The repository under review is
// never written, so #218's invariant is untouched.
//
// Recognised strictly: the whole command must be that one invocation. No `;` `&&` `||` `|`,
// no redirection, no backticks or `$(...)`, so the allowance cannot carry a second command
// in with it. Anything less exact and this becomes a hole rather than a door.
const REVIEW_PROBE = /^(?:node\s+)?[^\s;&|<>`$()]*review-probe\.mjs(?:\s+[^;&|<>`$()]*)?$/;

const bashWriteReason = (cmd) => {
  const text = String(cmd || "");
  if (TOUCHES_SCRATCH.test(text)) return ""; // writing the review record
  if (REVIEW_PROBE.test(text.trim())) return ""; // the sanctioned mutation probe
  for (const p of BASH_WRITE_PATTERNS) if (p.re.test(text)) return p.why;
  return "";
};

if (isSubagent && input.tool_name === "Bash" && WRITE_FORBIDDEN_ROLES.has(String(input.agent_type || ""))) {
  const why = bashWriteReason(input.tool_input && input.tool_input.command);
  if (why) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `The ${input.agent_type} role must not write files, and this command contains ${why}. ` +
            `Bash is available to you so you can RUN things — tests, greps, diffs — not to change them. ` +
            `If the code is wrong, that is a BOUNCE with findings, not an edit: fixing it yourself would ` +
            `make you the author of the work you are judging. To MUTATION-PROBE a test, run ` +
            `\`node .claude/scripts/review-probe.mjs --file <path> --test "<cmd>" --line <n> --replace "<text>"\` ` +
            `— it copies the tree outside the repository, mutates there, runs the suite and reports whether ` +
            `it went red, then removes the copy. Writing your own review record under .claude/tmp/ is also ` +
            `allowed. Both need no workaround; nothing else may write.`,
        },
      })
    );
    process.exit(0);
  }
  process.exit(0); // a read-only command from a write-forbidden role: no objection
}
// ---------------------------------------------------------------------------

// Bash reaches this hook only because write-forbidden ROLES are policed above. The
// main-session rule below is about FILE-WRITING tools and has no opinion on commands: the
// orchestrator runs git, gh/glab and the deterministic scripts constantly, and denying
// those would not tighten the boundary, it would stop the pipeline. Falling through to the
// generic deny would have done exactly that — a guard that looks stricter and is simply
// broken.
if (input.tool_name === "Bash") {
  process.exit(0);
}

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
