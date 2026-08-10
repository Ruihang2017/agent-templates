# Install — hub-and-spoke-orchestrator-executors

One command, from the target repo:

```
npx agent-templates@latest adopt hub-and-spoke-orchestrator-executors .
```

(Or `node scripts/adopt.mjs hub-and-spoke-orchestrator-executors <target-dir>` from a catalog checkout.) Re-running is safe: existing files are skipped, `--force` overwrites them.

## What lands

| Path | Purpose |
|---|---|
| `.claude/commands/hub-brief.md` | Hub stage 1 — PRD → contract-first briefs |
| `.claude/commands/hub-dispatch.md` | Hub stage 2 — fan out to headless executors |
| `.claude/commands/hub-collect.md` | Hub stage 3 — audit, review, merge |
| `.claude/scripts/firewall.mjs` | Deny list + scope audit. No model in the loop |
| `.claude/scripts/brief.mjs` | Brief parsing, validation, dependency graph |
| `.claude/scripts/dispatch-spokes.mjs` | The driver: worktrees, `codex exec`, repair loop, audit |
| `.claude/scripts/collect.mjs` | The landing gate: re-audit, re-test, merge or refuse |
| `.claude/settings.json` | Permission allowlist, and a **deny rule on writes under `.claude/worktrees/`** |
| `CLAUDE.md` | Pipeline section appended once, marker-guarded |
| `.gitignore` | `.claude/worktrees/` — spoke worktrees are never committed |

## Prerequisites

| | |
|---|---|
| Node | >= 18 on `PATH` |
| Git | a repo with at least one commit; `git worktree` available (git >= 2.5) |
| Executor | the Codex CLI on `PATH`. Verify with `codex --version` |
| Test command | the project must have a real one-line test command — it goes in each brief's `test_cmd` and is the pipeline's only correctness gate before review |

**The executor is a hard dependency, not an optional accelerator.** Without it there is no pattern here — just one Claude session doing all the work, which is what the three-agent pattern already does better.

## Manual install

Copy `scaffold/.claude/` into the target repo's `.claude/`, append `claude-md-snippet.md` to its `CLAUDE.md`, and add `.claude/worktrees/` to `.gitignore`. Keep the `.mjs` files LF-only.

## First run

```
/hub-brief docs/PRD.md
# --- Gate 1: read the briefs yourself before anything is dispatched ---
node .claude/scripts/dispatch-spokes.mjs --briefs docs/briefs --dry-run
/hub-dispatch docs/briefs 4
/hub-collect docs/briefs --all
/hub-collect docs/briefs --all --merge
# --- Gate 2: your smoke test ---
```

Start with `--concurrency 1` on the first real run. Concurrency multiplies token spend and makes several failures arrive at once; get one clean lane first.

## Tuning the firewall

`DEFAULT_DENY` in `.claude/scripts/firewall.mjs` is the list of paths no executor may ever write. Add to it for your stack — a generated API client, a protobuf output directory, an infra module. Removing entries is a decision to make deliberately: every entry is there because a concurrent edit to it produces a merge conflict that is not mechanically resolvable.

## Cleaning up

```
git worktree list
git worktree remove .claude/worktrees/<ID>
git branch -d spoke/<ID>
```

The driver removes a stale worktree before re-dispatching the same id, so an interrupted run does not need manual cleanup before a retry — but finished work does, or `git worktree list` grows without bound.
