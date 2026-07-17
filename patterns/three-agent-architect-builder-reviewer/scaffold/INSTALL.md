# Installing the three-agent scaffold

Source pattern: `agent-templates/patterns/three-agent-architect-builder-reviewer` — read its [README](../README.md) (especially the expiry trigger) before installing.

## Steps

1. Copy `.claude/` from this scaffold into the target repo root. If the target already has `.claude/settings.json`, merge the `hooks.PreToolUse` entry instead of overwriting.
2. The write-guard hook needs Node.js ≥ 18 on PATH. It denies main-session Edit/Write with a dispatch instruction; subagent writes pass. Override switch for human-approved out-of-pipeline edits: create `.claude/allow-main-writes`, delete it afterwards — and add that path to `.gitignore`.
3. Append the content of `claude-md-snippet.md` to the target repo's `CLAUDE.md`, and set the **Operating mode** line (`supervised` for a fresh adoption; `autonomous` is the target).
4. Ensure the docs layout the pipeline assumes exists: `docs/PRD.md`, `docs/prd/<module>/tickets/`, `docs/adr/`, and an empty `docs/plans/`.
5. Check the pattern entry's expiry (README metadata table). If expired, re-verify the model/effort table against current official docs before adopting — do not copy an expired recommendation into a new project.

## Usage modes

- **Mode A — one orchestrator session (default):** run `/plan-ticket` → `/build-ticket` → `/review-ticket` → `/verify-delivery` from a single main session. Each stage executes in its own subagent, so stage contexts stay isolated. The orchestrator passes only artifacts between stages — ticket path, plan path, diff ref — never transcripts or agent self-assessments, and it never does stage work itself (see "Orchestrator discipline" in `claude-md-snippet.md`; role leakage is a recorded failure mode).
- **Mode B — three human-run sessions:** open a fresh Claude Code session per stage. Strongest isolation; use when the orchestrator session itself has grown long or has seen implementation detail.

## Config-key verification record

`model:` and `effort:` in `.claude/agents/*.md`, and command frontmatter (`description`, `argument-hint`, `$ARGUMENTS`/`$N` substitution), verified against the official Claude Code docs on **2026-07-17**:

- <https://code.claude.com/docs/en/sub-agents.md> — agent frontmatter keys incl. `model` (full IDs and aliases; omitted = inherit) and `effort` (`low`/`medium`/`high`/`xhigh`/`max`); omitted `tools` inherits all tools.
- <https://code.claude.com/docs/en/skills.md> — command/skill frontmatter incl. `model`, `effort`, `argument-hint`; argument substitution via `$ARGUMENTS` and `$N` (0-based).
- <https://code.claude.com/docs/en/model-config.md> — effort levels incl. `max`; note the `effortLevel` *setting* accepts `low`–`xhigh` only (`max` is session-only), while agent/command frontmatter `effort` accepts `max`.

Hook mechanism (the main-session write guard), verified **2026-07-17**:

- <https://code.claude.com/docs/en/hooks.md> — PreToolUse settings schema (regex `matcher`, `type: command`); hooks fire for subagent tool calls too; the hook input carries `agent_id`/`agent_type` **only** when the call comes from a subagent, so their absence identifies the main session; deny via stdout JSON `hookSpecificOutput.permissionDecision: "deny"` (the reason string is fed back to the model), or exit code 2.
- <https://code.claude.com/docs/en/permissions.md> — `permissions.deny` rules apply to subagents as well (subagents inherit the parent's permission stack); **no documented main-session-only permission scope exists**, which is why the guard is a hook rather than a deny rule.

Re-verify these keys when Claude Code major-versions, or when this record is more than 6 months old.
