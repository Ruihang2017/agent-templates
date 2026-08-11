# Installing the Codex three-agent scaffold

Source pattern: `agent-templates/patterns/codex-three-agent-architect-builder-reviewer`. Read its README, especially the status, expiry trigger, and known limits, before installing.

## Quickstart

From a catalog checkout:

```text
node scripts/adopt.mjs codex-three-agent-architect-builder-reviewer <target-dir> --platform gh
```

The installer copies the Codex custom agents, repo skills, deterministic scripts, universal ticket/tracker templates, docs skeleton, and a marker-guarded `AGENTS.md` section. It is idempotent; use `--force` only after committing local customizations.

## Prerequisites

- Codex CLI 0.147.0 or newer. The CLI surface was checked against 0.147.0 on 2026-08-11; the custom-agent keys come from the official Subagents schema.
- Node.js 18 or newer for `.codex/scripts/*.mjs`.
- Git plus an authenticated `gh` or `glab` CLI for tracker and delivery operations.
- A Git repository with a remote when PR/MR delivery is expected.

Official Codex references verified 2026-08-11:

- [Subagents and project custom-agent TOML](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)
- [Repository instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md)
- [Build and invoke repository skills](https://learn.chatgpt.com/docs/build-skills.md)
- [Configuration and sandbox defaults](https://learn.chatgpt.com/docs/config-file/config-basic)
- [Non-interactive codex exec](https://learn.chatgpt.com/docs/non-interactive-mode.md)

## What to review after adoption

1. Trust and inspect `.codex/config.toml`. It makes the primary thread read-only and enables subagents; `architect`, `builder`, and `delivery` override the sandbox only for their roles.
2. Add project facts and the exact test command to `AGENTS.md`. Keep Operating mode `supervised` for the first real run.
3. Fill the PR/MR template's Constraint check with repository non-negotiables.
4. Confirm `docs/PRD.md`, `docs/prd/`, `docs/adr/`, and `docs/plans/` match the project.
5. Run `gh auth status` or `glab auth status`. Tokens stay in the CLI credential store; never put one in a prompt, ticket, repository config, or command argument.

## First run

In a new Codex chat rooted at the repository:

```text
$breakdown-prd
```

Review `docs/prd/dag.html`, module READMEs, and every ticket. That review is Gate 1. Then:

```text
$start-milestone docs/prd/00-<module> supervised
```

The primary thread spawns the named project agents and passes artifacts between them. A CLEAR verdict opens a PR/MR and stops for human merge. Re-run the milestone skill to resume. After the pattern has held on representative work, switch `AGENTS.md` to `autonomous`; the downstream human duty is the final smoke test.

For one ticket, use `$run-ticket <ticket-id>`. The individual `$plan-ticket`, `$build-ticket`, and `$review-ticket` skills exist for diagnostics and manual stage control.

## Isolation and permissions

- Reviewer is mechanically read-only through its custom-agent sandbox.
- The primary thread is read-only through project config by default. A user-selected live permission override can supersede project defaults, so `AGENTS.md` still carries the no-role-leakage rule.
- Architect has workspace write because it must write plans and PRD artifacts. Builder has workspace write for code and tests. Their path boundaries are instruction-enforced, then independently checked by review and git diff.
- Delivery uses a separate low-effort agent and deterministic scripts. It never supplies judgment; the Reviewer must already have returned CLEAR.
- Approval requirements are inherited by subagents. In a non-interactive run, any operation needing a new approval fails; do not use broad bypass flags outside an externally isolated runner.

## Sequential v1 boundary

This pattern deliberately rejects `concurrency > 1`. Current Codex subagents can run in parallel, but write-heavy agents in one checkout can conflict, and this scaffold does not yet provide the Claude pattern's Workflow-owned per-agent worktree isolation. The global DAG and dependency semantics are preserved; tickets execute one at a time.

Use the sibling `hub-and-spoke-orchestrator-executors` pattern when parallel implementation is the main requirement and its non-independent review tradeoff is acceptable. Do not remove the sequential guard merely to improve throughput.

The proposed v1 also does not ship the Claude sibling's unattended `$nightly-issues` entry point or its Asana mirror. `triage.toml` is present so the classification contract is not lost, but scheduled collection, tracker reporting, and real headless approval behavior still need a Codex Level-1 design and rehearsal.

## Non-interactive operation

`codex exec` is suitable for CI or scheduled runs and defaults to a read-only sandbox. This pattern's native subagent workflow is designed primarily for an interactive Codex app, CLI, or IDE chat, where agent activity and approvals can surface. Treat headless milestone/nightly automation as unverified until a Level-1 rehearsal covers approvals, tracker auth, and custom-agent spawning on the target platform.

## Updating

Commit target-repo changes, then rerun adoption with `--force` and inspect the diff. The installer intentionally does not rewrite an existing marker-guarded `AGENTS.md` section; reapply changed guidance manually.
