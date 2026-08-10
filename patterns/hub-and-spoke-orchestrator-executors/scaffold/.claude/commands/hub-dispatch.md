---
description: Hub stage 2 — fan the ready briefs out to headless Codex executors, one isolated worktree each, and report what came back
argument-hint: [briefs-dir] [concurrency] [--dry-run]
---

Arguments: `$ARGUMENTS` — optional briefs directory (default `docs/briefs`), optional concurrency (default `4`), optional `--dry-run`.

This stage runs a **script**, not an agent. You do not write inside the spoke worktrees and you do not implement any brief yourself. `.claude/settings.json` denies `Edit`/`Write` under `.claude/worktrees/` so this boundary is enforced rather than merely stated; reading is left open so you can diagnose a failure instead of guessing at it.

When a spoke needs your intervention, work on its **branch from the main tree** (`git checkout spoke/<ID>`), never inside its worktree directory.

## 1. Confirm the executor is present

```
codex --version
```

If it is missing, stop and tell the human to install it. Do not fall back to implementing the briefs yourself: a hub that quietly becomes the executor spends the expensive model on exactly the work this pattern moved off it, and nobody finds out until the bill arrives.

## 2. Plan, then dispatch

```
node .claude/scripts/dispatch-spokes.mjs --briefs docs/briefs --dry-run
node .claude/scripts/dispatch-spokes.mjs --briefs docs/briefs --concurrency 4
```

The driver validates every brief first and **dispatches nothing if any brief fails** — an invalid set means the decomposition is suspect, and low-effort executors will not notice. Exit `2` is that case: go back to `/hub-brief`, fix the briefs, re-run.

Each spoke gets a fresh worktree at `.claude/worktrees/<ID>` on branch `spoke/<ID>`, a `TASK.md`, and a `.test_cmd`. On a failing test the executor retries in place, capped by `--repair-cap` (default 3), then escalates.

## 3. Read the report literally

| Status | Meaning | What you do |
|---|---|---|
| `passed` | result artifact returned, `test_cmd` exited 0, diff inside scope | nothing — `/hub-collect` will land it |
| `failed` | tests still failing after the repair cap, or no parseable result artifact | this is now yours: read the branch, fix it, or re-cut the brief |
| `blocked` | the executor stopped and said why — usually it needed a firewall-denied file | make the dependency/config change **yourself**, then re-dispatch that id |
| `quarantined` | it wrote outside its declared scope, or touched a denied path | **do not merge.** Read the diff. Either the brief's scope was wrong, or two briefs contend — re-cut them |

`quarantined` outranks a green test run, deliberately. A spoke that passed its tests while writing outside its scope is the more dangerous outcome, because passing tests is exactly what would otherwise wave it through.

Never "fix" a quarantine by widening the brief's `file_scope` to match what the executor did. That converts the finding into a rubber stamp.

## 4. Re-dispatch the next wave

Briefs with unmet `blocked_by` are held back. After landing a wave:

```
node .claude/scripts/dispatch-spokes.mjs --briefs docs/briefs --done FND-01,FND-02 --concurrency 4
```

Then report which spokes are ready to collect, and stop.
