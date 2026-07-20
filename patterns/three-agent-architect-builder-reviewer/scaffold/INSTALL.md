# Installing the three-agent scaffold

Source pattern: `agent-templates/patterns/three-agent-architect-builder-reviewer` — read its [README](../README.md) (especially the expiry trigger) before installing.

## Quickstart

From a checkout of the catalog: `node scripts/adopt.mjs three-agent-architect-builder-reviewer <target-dir>` performs steps 1–6 below mechanically (idempotent; `--platform gh|glab`), then prints the next steps. Full walkthrough incl. the bare-PRD.md scenario: the catalog's [ADOPTING.md](../../../ADOPTING.md). The manual steps:

## Steps

1. Copy `.claude/` from this scaffold into the target repo root. If the target already has `.claude/settings.json`, merge the `hooks.PreToolUse` entry and the `permissions.allow` list instead of overwriting.
2. Install the catalog's **universal templates** (shared by all patterns — source of truth is the catalog root, not this scaffold): `templates/ticket.template.md` → the target repo's `templates/`; the platform half of `templates/tracker/` → `.github/` (ISSUE_TEMPLATE/ + PULL_REQUEST_TEMPLATE.md) or `.gitlab/` (issue_templates/ + merge_request_templates/). Then fill the PR/MR template's **Constraint check** section with the target repo's CLAUDE.md non-negotiables. Hand-written issues and pipeline PRs now share one format that triage can convert and reviewers can verify.
3. The write-guard hook needs Node.js ≥ 18 on PATH. It denies main-session Edit/Write with a dispatch instruction; subagent writes pass. Override switch for human-approved out-of-pipeline edits: create `.claude/allow-main-writes`, delete it afterwards — and add that path to `.gitignore`.
4. The tracker steps (`publish-tickets.mjs`, `deliver-ticket.mjs`, `/verify-delivery`, the nightly sweep) need the platform CLI installed and authenticated: `gh` (GitHub) or `glab` (GitLab). The publish script autodetects the platform from the origin remote; override with `--platform gh|glab` (test doubles / non-PATH binaries: `GH_BIN` / `GLAB_BIN` env overrides). Delivery (merge `--no-ff` + push + verified issue close + deterministic DoD) is `deliver-ticket.mjs` — never an agent improvising git/tracker writes; `settings.json` carries explicit allow rules for the pipeline's whole tool surface (the three deterministic scripts, the enumerated git branch/commit/push set, `npm test`-family test commands, and the enumerated `gh`/`glab` issue commands) so unattended runs do not stall waiting for interactive approval (catalog issues #26, #30). Deliberately NOT pre-allowed: `git merge` / `rebase` / `reset` / `clean` and `gh pr *` — merging belongs to `deliver-ticket.mjs`. If your project's test command is not `npm test` / `npm run test` / `node --test`, add one more allow rule for it (e.g. `Bash(pytest:*)`).
5. Append the content of `claude-md-snippet.md` to the target repo's `CLAUDE.md`, and set the **Operating mode** line (`supervised` for a fresh adoption; `autonomous` is the target) and the **Tracker** line (`gh` for GitHub, `glab` for GitLab — the commands and workflows read the platform from this line). `adopt.mjs` sets Tracker automatically from the origin remote; set it by hand only on a manual install. The snippet contains one **opt-in** bullet between `<!-- upstream-escalation -->` markers that tells agents to file pattern-level problems against the catalog — **delete that block (and its markers) unless you want it**, or repoint the `--repo` slug at your own catalog. `adopt.mjs` strips it by default; keep it only with `--upstream`.
6. Ensure the docs layout the pipeline assumes exists: `docs/PRD.md`, `docs/prd/<module>/README.md` (the sub-PRD — `/start-milestone` hard-requires it), `docs/prd/<module>/tickets/` (author tickets from `templates/ticket.template.md`), `docs/adr/`, and an empty `docs/plans/`.
7. Check the pattern entry's expiry (README metadata table). If expired, re-verify the model/effort table against current official docs before adopting — do not copy an expired recommendation into a new project.

## Usage modes

- **Mode A — one orchestrator session (default):** run `/plan-ticket` → `/build-ticket` → `/review-ticket` → `/verify-delivery` from a single main session. Each stage executes in its own subagent, so stage contexts stay isolated. The orchestrator passes only artifacts between stages — ticket path, plan path, diff ref — never transcripts or agent self-assessments, and it never does stage work itself (see "Orchestrator discipline" in `claude-md-snippet.md`; role leakage is a recorded failure mode).
- **Mode B — three human-run sessions:** open a fresh Claude Code session per stage. Strongest isolation; use when the orchestrator session itself has grown long or has seen implementation detail.
- **Milestone mode (the target operating model):** `/start-milestone <module> [supervised|autonomous]` — Gate 1 in one action: verify inputs, publish tickets as issues, then run all tickets through `.claude/workflows/run-milestone.js`. Each stage still runs in its own subagent; ordering, the bounce cap, and merge policy are code, not prompts. The human returns at Gate 2 (smoke test) or on escalation.

## Nightly sweep (unattended)

- **Entry:** `claude -p "/nightly-issues"` — slash commands expand in headless `-p` mode. `[official]`
- **Permissions:** the scaffold's `settings.json` already enumerates the pipeline's whole tool surface in `permissions.allow` (see step 4 — deterministic scripts, git branch/commit/push set, test commands, `gh`/`glab` issue commands; catalog issue #30). Do NOT widen it to bare wildcards like `Bash(git:*)` or `Bash(gh:*)` — that would re-allow the role-discipline-forbidden surface (`git merge`, `gh pr …`) the enumeration deliberately excludes. Add only your project-specific test-command rule, then run with `--permission-mode dontAsk` — the documented CI recommendation: pre-approved tools run, everything else is auto-denied instead of blocking. Subagents run in `acceptEdits` mode (their file edits are auto-approved). Avoid `bypassPermissions` outside isolated containers (documented warning). `[official]`
- **Scheduling (Windows, primary):** Task Scheduler — runs whenever the machine is on at the trigger time:

  ```
  schtasks /create /tn "nightly-issues" /sc daily /st 02:00 ^
    /tr "cmd /c cd /d C:\path\to\repo && claude -p \"/nightly-issues\" --permission-mode dontAsk >> .claude\nightly.log 2>&1"
  ```

  macOS/Linux: launchd / cron equivalents.
- **Why not Claude Code's native cron** (`/loop`, Cron tools): documented constraints — the session must stay open, recurring tasks expire after 7 days, and firings jitter up to 30 minutes — the wrong shape for "machine on, no session open". For no-local-machine automation the docs point to Routines (Anthropic infrastructure) or CI schedules. `[official]`
- **Morning email:** watch the repo / enable tracker notifications. The sweep posts per-issue outcome comments, labels (`triage:invalid` = flagged invalid, never auto-closed · `nightly:escalated` = won't retry until a human clears it · `needs-human`), closes delivered issues, and files a `Nightly report YYYY-MM-DD` issue — the tracker's own notification email is the delivery mechanism, no SMTP to configure.

## Config-key verification record

`model:` and `effort:` in `.claude/agents/*.md`, and command frontmatter (`description`, `argument-hint`, `$ARGUMENTS`/`$N` substitution), verified against the official Claude Code docs on **2026-07-17**:

- <https://code.claude.com/docs/en/sub-agents.md> — agent frontmatter keys incl. `model` (full IDs and aliases; omitted = inherit) and `effort` (`low`/`medium`/`high`/`xhigh`/`max`); omitted `tools` inherits all tools.
- <https://code.claude.com/docs/en/skills.md> — command/skill frontmatter incl. `model`, `effort`, `argument-hint`; argument substitution via `$ARGUMENTS` and `$N` (0-based).
- <https://code.claude.com/docs/en/model-config.md> — effort levels incl. `max`; note the `effortLevel` *setting* accepts `low`–`xhigh` only (`max` is session-only), while agent/command frontmatter `effort` accepts `max`.

Hook mechanism (the main-session write guard), verified **2026-07-17**:

- <https://code.claude.com/docs/en/hooks.md> — PreToolUse settings schema (regex `matcher`, `type: command`); hooks fire for subagent tool calls too; the hook input carries `agent_id`/`agent_type` **only** when the call comes from a subagent, so their absence identifies the main session; deny via stdout JSON `hookSpecificOutput.permissionDecision: "deny"` (the reason string is fed back to the model), or exit code 2.
- <https://code.claude.com/docs/en/permissions.md> — `permissions.deny` rules apply to subagents as well (subagents inherit the parent's permission stack); **no documented main-session-only permission scope exists**, which is why the guard is a hook rather than a deny rule.

Workflow tool + `ultracode` (for the milestone runner), verified **2026-07-17**:

- <https://code.claude.com/docs/en/workflows> — the Workflow tool (deterministic multi-agent scripts: `export const meta`, `agent()` / `parallel()` / `pipeline()`) is publicly documented; `.claude/workflows/` is the documented project location for saved workflow scripts (also <https://code.claude.com/docs/en/claude-directory>).
- <https://code.claude.com/docs/en/model-config> — "Ultracode is a Claude Code setting rather than a model effort level": it applies `xhigh` effort plus automatic workflow orchestration. Persistable effort levels are `low`–`xhigh`; `max` and `ultracode` are session-only.

Headless + scheduling facts (for the nightly sweep), verified **2026-07-17**:

- <https://code.claude.com/docs/en/headless.md> — `claude -p "<prompt>"`; slash commands expand in `-p`; `--output-format`, `--max-turns`.
- <https://code.claude.com/docs/en/permission-modes.md> and <https://code.claude.com/docs/en/permissions.md> — `--permission-mode dontAsk` is the documented CI recommendation (pre-approved tools only, rest auto-denied); `acceptEdits`; `bypassPermissions` only for isolated environments; `--allowedTools`; settings `permissions.allow`; subagents run in `acceptEdits`.
- <https://code.claude.com/docs/en/workflows.md> — workflows are available in headless `claude -p`.
- <https://code.claude.com/docs/en/scheduled-tasks.md> and <https://code.claude.com/docs/en/routines.md> — native `/loop`/Cron tools require an open session, recurring tasks expire after 7 days, jitter up to 30 min; Routines run on Anthropic infrastructure.

Re-verify these keys when Claude Code major-versions, or when this record is more than 6 months old.
