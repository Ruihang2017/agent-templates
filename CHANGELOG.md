# Changelog

What changed for someone **using** this catalog. The full decision record — why each change was made, what evidence backed it, and what is still unmeasured — lives in each pattern's README § 7 provenance log and § 4 pitfalls.

## Unreleased

### New pattern: `hub-and-spoke-orchestrator-executors` (status `proposed`)

A second point on the cost/assurance curve. One Claude Opus 5 **hub** decomposes a PRD into contract-first briefs, N headless `codex exec` **spokes** implement one brief each at low reasoning effort in isolated git worktrees, and the *same* hub session then audits, reviews and merges.

```
npx agent-templates@latest adopt hub-and-spoke-orchestrator-executors .
```

**Read this before adopting it.** The hub reviews diffs written against a contract the hub itself wrote, in the same context. That review is **not independent** — it is the thing this pattern trades away for cost and throughput, and it will not catch a wrong brief that was faithfully implemented. If a bad merge is expensive, keep using `three-agent-architect-builder-reviewer`, whose independent reviewer exists for exactly that case. The comparison table is in the README.

Requires the **Codex CLI** on `PATH`; there is no fallback without it.

What is mechanical rather than advisory:

- **All-or-nothing dispatch** — one invalid brief dispatches nothing (missing/empty contract section, repo-wide or denied `file_scope`, missing `test_cmd`, duplicate ids, dangling `blocked_by`, cycles, unordered briefs with overlapping scopes).
- **A global file firewall** — no spoke may write dependency, lock, build, CI, secret, or agent-config files, whatever its brief says. Deny is checked before scope, so a `**` scope cannot launder a lockfile edit.
- **`quarantined` outranks green tests** — a spoke that passed its tests while writing outside its scope does not merge.
- **`unverified` is not a pass** — a branch whose tests could not be re-run does not merge.
- **Executor completion is read from its result artifact, never from its exit code** — `codex exec`'s exit codes are undocumented (checked 2026-08-10), so trusting them would be an assumption.

Covered by a new E2E suite (`testbed/e2e/suite-hub.mjs`, 100 checks) driving the real scripts against a controllable stand-in executor.

### Fixed — affects existing installs

- **`adopt` derives the CLAUDE.md idempotency marker from the snippet** instead of hardcoding the three-agent heading. The hardcoded marker was correct only while the catalog had one pattern; adopting any other one would fail to find it and re-append the whole pipeline section on **every** re-run.
- **`adopt`'s NEXT STEPS are now per-pattern** (`scaffold/next-steps.txt`). Printing one pattern's steps after installing another names commands that do not exist.

## 0.10.0 — 2026-08-06

### Upgrading from 0.9.0 — read this first

```
git add -A && git commit -m "checkpoint before agent-templates update"
npx agent-templates@latest adopt three-agent-architect-builder-reviewer . --force
git diff
```

Two things a re-adopt does **not** do for you:

**1. Add test-runner ignores for `.claude/worktrees/`.** Required at `concurrency > 1`. `adopt` now git-ignores that path, but `.gitignore` is invisible to jest, vitest, pytest, eslint, tsc, bundlers and watchers — and at `concurrency > 1` the harness puts a full checkout of your repo under it *per isolated agent*. Without a runner-level ignore, a root test command can discover tests **inside** those checkouts, so the Builder runs other in-flight tickets' tests and `--test-cmd` measures the wrong tree for the Definition of Done. Add whichever applies:

```jsonc
// jest.config      testPathIgnorePatterns: ['/\\.claude/worktrees/']
// vitest.config    exclude: ['**/.claude/worktrees/**']
// pytest.ini       norecursedirs = .claude
// .eslintignore    .claude/worktrees/
// tsconfig.json    "exclude": [".claude/worktrees"]
```

**2. Preserve your agent effort pins.** `--force` overwrites `.claude/agents/*.md`, so it adopts the new pins: Architect `high`, Builder `medium`, Reviewer `high`, Triage `high` — each one level below 0.9.0. This is a deliberate cost decision (pattern § 3), and § 4 records honestly that it is **unmeasured**: the Builder now runs below its model's documented default on work the vendor scopes as non-routine, and the Reviewer has no effort margin left over the code it judges. Watch your bounce rate. To keep the old pins, re-adopt **without** `--force`, or restore the four agent files from your diff.

A plain re-run (no `--force`) still picks up the new integration files, the CLAUDE.md sections, the `.gitignore` rules, and the `settings.json` permission merge — those are additive and marker-guarded.

### Fixed

- **GitLab repos past 30 issues silently created duplicate issues.** The dedup oracle was one un-paginated `glab issue list`; `--all` is a *state* filter, not a pagination flag, and `--per-page` defaults to 30. Everything beyond the first page read as "never published" and was created again, and each duplicate pushed a real issue further out of the window. One field run: 44 tickets, 44 issues, **43 duplicates from a single `--create`**. Now paginated, sorted oldest-first, and every truncation path throws instead of returning a short list. Also added a pre-create guard that refuses to run against a tracker that already contains duplicates. (#132)
- **At `concurrency > 1`, every delivery was refused.** The harness places each isolated agent's worktree at `.claude/worktrees/wf_<runId>-<agentIndex>/` — inside your repo, untracked — so `deliver-ticket.mjs`'s clean-tree guard saw a dirty tree and would not merge. One field run: 7 tickets produced 16 worktrees and nothing could be delivered. Now git-ignored and exempted from the guard. See the upgrade note above for the half that is still yours to do. (#141)
- **`glab mr`/`gh pr` bodies always carry an AI banner now.** Previously the two body paths that adopted repos actually take — a pre-composed `--body-file` and your own MR template — carried no visible marker, so an MR written and merged by the pipeline looked like ordinary human work. The banner states that the change was AI-written and machine-merged, and that the account shown as author is the token's owner rather than the code's author. (#137)
- **Releases are retryable.** A failed publish can be re-run against the same tag from the Actions tab instead of deleting and re-pushing it. (#119)

### Added

- **Asana mirror** (`/connect-asana`). Optional, installed with every pattern, and completely inert until you configure it. Milestones and tickets become Asana subtasks, and a delivered ticket's subtask is completed automatically. It is a **reporting mirror, never a gate** — deliberately outside the Definition of Done, so an expired Asana token can never fail a ticket that actually shipped. Needs an `ASANA_TOKEN` environment variable; the token never goes to an agent. (#124, #126)
- **`/publish-tickets <module> [--all]`** — create the tracker issues (and Asana subtasks) and stop. For populating the board before any work starts. It authorizes issue creation but is *not* Gate 1 sign-off to build. (#126)
- **Integration-branch fallback for a protected default branch.** Opt-in via an `Integration branch:` line in CLAUDE.md. In autonomous mode, a merge your default branch refuses *because it is protected* lands on that branch (`ai-staging` by convention) instead of stalling every ticket. It fires **only** on a protection refusal — a failing pipeline or missing approval still escalates, and the classifier fails closed on anything it does not recognise. Work delivered there closes its issue but **does not pass the Definition of Done**, and one handoff MR is opened at the end of the run and never merged. (#139)
- **Real GitLab CLI and token setup guidance** — required scope (`api` alone), `glab auth login --stdin` rather than a token on the command line, self-managed hosts, and the 365-day expiry that silently breaks an unattended nightly sweep. The rule throughout: you install the token into the CLI yourself, and it never goes to an agent. (#137)

### Packaging

- `integrations/` was missing from the published files whitelist, so the Asana integration would have shipped absent while `adopt` exited 0 and told users to run `/connect-asana`. Caught pre-flight; never released. The real fix is a new packaging test that asserts every path `adopt` reads is present in the actual `npm pack` manifest, derived from disk so future additions are covered without anyone updating a list. (#143)

### Note on publishing

The tagged-release workflow has still never completed successfully — `v0.8.0` and `v0.9.0` both failed at the registry with `EOTP` because the CI token cannot publish without an interactive one-time password. Both versions shipped by hand. See README § "CI & releasing" before assuming a tag is enough.

## 0.9.0 and earlier

Not recorded here. See the git history and the pattern's README § 7 provenance log.
