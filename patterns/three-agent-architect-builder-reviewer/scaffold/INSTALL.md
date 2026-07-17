# Installing the three-agent scaffold

Source pattern: `agent-templates/patterns/three-agent-architect-builder-reviewer` — read its [README](../README.md) (especially the expiry trigger) before installing.

## Steps

1. Copy `.claude/` from this scaffold into the target repo root (merge into any existing `.claude/`).
2. Append the content of `claude-md-snippet.md` to the target repo's `CLAUDE.md`.
3. Ensure the docs layout the pipeline assumes exists: `docs/PRD.md`, `docs/prd/<module>/tickets/`, `docs/adr/`, and an empty `docs/plans/`.
4. Check the pattern entry's expiry (README metadata table). If expired, re-verify the model/effort table against current official docs before adopting — do not copy an expired recommendation into a new project.

## Usage modes

- **Mode A — one orchestrator session (default):** run `/plan-ticket` → `/build-ticket` → `/review-ticket` → `/verify-delivery` from a single main session. Each stage executes in its own subagent, so stage contexts stay isolated. The orchestrator passes only artifacts between stages — ticket path, plan path, diff ref — never transcripts or agent self-assessments, and it never does stage work itself (see "Orchestrator discipline" in `claude-md-snippet.md`; role leakage is a recorded failure mode).
- **Mode B — three human-run sessions:** open a fresh Claude Code session per stage. Strongest isolation; use when the orchestrator session itself has grown long or has seen implementation detail.

## Config-key verification record

`model:` and `effort:` in `.claude/agents/*.md`, and command frontmatter (`description`, `argument-hint`, `$ARGUMENTS`/`$N` substitution), verified against the official Claude Code docs on **2026-07-17**:

- <https://code.claude.com/docs/en/sub-agents.md> — agent frontmatter keys incl. `model` (full IDs and aliases; omitted = inherit) and `effort` (`low`/`medium`/`high`/`xhigh`/`max`); omitted `tools` inherits all tools.
- <https://code.claude.com/docs/en/skills.md> — command/skill frontmatter incl. `model`, `effort`, `argument-hint`; argument substitution via `$ARGUMENTS` and `$N` (0-based).
- <https://code.claude.com/docs/en/model-config.md> — effort levels incl. `max`; note the `effortLevel` *setting* accepts `low`–`xhigh` only (`max` is session-only), while agent/command frontmatter `effort` accepts `max`.

Re-verify these keys when Claude Code major-versions, or when this record is more than 6 months old.
