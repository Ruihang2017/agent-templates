# Pattern: Hub-and-Spoke Orchestrator + Headless Executors

| Field | Value |
|---|---|
| **Pattern name** | `hub-and-spoke-orchestrator-executors` (= directory name) |
| **Status** | `proposed` — drafted, not yet signed off, and **never run end to end** |
| **As-of date** | 2026-08-10 |
| **Expiry trigger** | First successor release to any listed model, or 2027-02-10 (+6 months), whichever comes first |
| **Sign-off** | *(unsigned — `proposed`; maintainer sign-off pending, catalog issue #156)* |

One long-lived **hub** (Claude Opus 5) decomposes a PRD into contract-first task briefs, N **spokes** (headless `codex exec`, low reasoning effort, one isolated git worktree each) implement one brief apiece, and the *same* hub session then audits, reviews and merges each branch. The pyramid is flattened into a pipeline: exactly one expensive context for the whole run, and no agent-to-agent conversation anywhere.

## 1. When to use / when not to use

**Use when:**

- The work decomposes into briefs whose write-sets are **disjoint** — mostly-additive feature work, per-endpoint handlers, per-component UI, per-module test coverage. Fan-out is the entire point; a deep `blocked_by` chain gets none of it.
- The design is **already settled** and the remaining work is transcription. The spokes are told not to design, so anything requiring a design decision mid-implementation belongs to the hub or to another pattern.
- The project has a **real one-line test command** that exits non-zero on failure. That exit code is the only automatic correctness signal before review.
- Throughput and cost matter more than an independent second opinion, and a bad merge is **cheap to revert** — internal tooling, prototypes under active supervision, batch mechanical work across many files.

**Do not use when:**

- **A bad merge is expensive.** Security-sensitive paths, shared services, payment or auth code, anything with concurrency invariants. The review here is not independent (§2, §4); use `three-agent-architect-builder-reviewer`, which exists for exactly this case.
- **The work is genuinely exploratory** — the answer is not known, the interfaces will move, the first attempt is meant to be thrown away. Contract-first decomposition assumes there is a contract to write.
- **One brief, or a strictly serial chain.** Worktree setup, brief validation and the collect gate are overhead that only pays back across a wave. Below roughly three concurrent spokes, the three-agent pattern is simpler and better-reviewed.
- **The Codex CLI is not available** in the environment. There is no fallback: without the executors this degrades to one Claude session doing everything, with none of the review structure the other pattern provides.
- **The team cannot review the merged result themselves.** This pattern deliberately trades away the independent gate. If nobody downstream reads the diff either, nothing does.

*(Scope guidance is design-derived. This pattern has no run record — see the Status field and §4.)*

## 2. Agent roles & boundaries

| Agent | Does | Never does |
|---|---|---|
| **Hub — decompose** (`/hub-brief`) | Reads the PRD, ADRs and codebase. Owns **all structural truth**: schemas, types, migrations, public interfaces, and every dependency change. Writes one brief per unit of work, each carrying the full interface contract, the declared `file_scope`, and the project's `test_cmd`. | Writes production code at this stage. Delegates a structural decision to a spoke. Invents a `test_cmd` the project does not have. |
| **Driver** (`dispatch-spokes.mjs`, deterministic) | Validates the whole brief set; creates one worktree and branch per ready brief; runs the executor; re-runs the test command; drives the capped self-repair loop; audits the committed diff against the firewall and the declared scope. | Makes any judgement call. Dispatches a partially-valid brief set. Infers executor success from the executor's exit code. |
| **Spoke** (`codex exec`, low effort, one worktree) | Implements exactly one brief inside its declared `file_scope`, including its unit and integration tests. Repairs its own failing tests, up to the cap. Reports `blocked` with a reason when the brief cannot be done within its scope. | Designs anything. Writes outside its `file_scope`. Touches dependency, lock, build, CI, or agent-config files. Commits (the driver commits). Weakens or deletes tests to go green. |
| **Hub — collect** (`/hub-collect`, *same session*) | Runs the deterministic landing gate, reads each diff against the PRD, repairs or re-cuts what failed, merges what clears. | Merges anything the gate marks `blocked` or `unverified`. Writes inside `.claude/worktrees/` (denied in `settings.json`). Resolves a spoke-vs-spoke merge conflict by hand. Widens a brief's `file_scope` to match what a spoke actually did. |

**Who judges whom — read this precisely, because it is where this pattern differs from every other one in the catalog.**

The hub judges the spokes. **Nothing judges the hub.** The same context writes the contract, may repair the code, and then reviews the diff for contract adherence. That review is *not* independent: a misreading in the brief reappears as approval of the code that faithfully implements the misreading.

That is a deliberate, maintainer-chosen trade (`[team-policy]`, 2026-08-10, catalog issue #156) — the whole cost argument rests on there being exactly one expensive context. It is **the opposite** of `three-agent-architect-builder-reviewer` §2, which states the independent reviewer to be "a hard requirement of the pattern, not a cost knob". Both statements are correct within their own pattern; they are different points on a cost/assurance curve, and §1 draws the line between them.

What partially compensates, and what does not:

- **Compensates:** the checks in `firewall.mjs` and `collect.mjs` are deterministic and have no stake in the outcome. Scope violations, firewall violations, empty deliveries, and a non-zero test exit are caught by code that cannot be persuaded. `quarantined` outranks a green test run, and `unverified` never merges.
- **Does not compensate:** nothing mechanical can tell whether the *brief itself* was right. `/hub-collect` therefore instructs the hub to re-read the PRD section the brief cites and ask whether the brief was correct — a prompt-level mitigation, which is weaker than a separate reviewer and is not claimed to be equivalent.

**Isolation that IS enforced:** spokes never see each other (separate worktrees, separate processes, no shared context) and the hub never writes inside a spoke worktree (`permissions.deny` on `Edit`/`Write`/`NotebookEdit` under `.claude/worktrees/`). Reads are left open so the hub can diagnose a failure rather than guess at it.

**Testing policy `[team-policy]` (2026-07-17, repo-wide):** the agents own the whole test pyramid. Spokes write and run unit and integration tests within their brief's scope; the driver re-runs `test_cmd` after every repair round; `collect.mjs` re-runs it once more before any merge. The human tests exactly once — the Gate 2 smoke test after the last brief is delivered.

## 3. Model + effort assignment (as of 2026-08-10)

| Role | Model | Effort | Reasoning | Source labels |
|---|---|---|---|---|
| Hub — decompose | Claude Opus 5 | `high` | This is the stage that must not be economised, and it is the only stage with no downstream check on it: the spokes are explicitly instructed not to design, so an under-specified or wrong brief is implemented faithfully and nothing in the pipeline notices. `high` is Opus 5's documented default and the vendor's recommended starting point. **`xhigh` was considered and not taken:** the vendor names it for "demanding coding and agentic work", which decomposition arguably is, but this pattern's entire premise is cost, and raising the one stage that runs on every request contradicts it. Anyone whose briefs come back thin should raise this row first, before touching anything else. | Effort levels, the `high` default for Opus 5, and the `xhigh` step-up wording: `[official]` — [effort](https://platform.claude.com/docs/en/build-with-claude/effort), verified 2026-08-10. Opus 5 as the Opus-tier model for complex agentic coding: `[official]` — [models overview](https://platform.claude.com/docs/en/about-claude/models/overview), verified 2026-07-29 in the sibling pattern, **not independently re-verified for this entry**. The choice of `high` over `xhigh`: `[team-policy]` — cost-driven, **unmeasured** |
| Spoke — execute | Codex CLI (`codex exec`) | `low` | Passed as `-c model_reasoning_effort=low`; the model itself is whatever the project's `~/.codex/config.toml` configures, overridable per run with `-m`. The brief already fixes the interface contract, the file-scope and the test command, so the spoke's job is constrained transcription. `low` is the correct level for that shape of task, and it is what makes N-way fan-out affordable. **This row deliberately does not pin an OpenAI model name.** The catalog has no verified basis for recommending one, and `codex exec` takes whichever model the operator has configured; pinning one from memory is precisely what CLAUDE.md's grounding rule 1 forbids. Run a sweep on your own work before lowering or raising it. | `model_reasoning_effort` accepting `minimal\|low\|medium\|high\|xhigh`, and `codex exec`'s flags (`-m`, `-s/--sandbox`, `-c`, `--output-schema`, `-o/--output-last-message`, `-C/--cd`, `--skip-git-repo-check`): `[official]` — [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) and [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), both verified 2026-08-10. `--full-auto` is **deprecated** there in favour of `--sandbox workspace-write`; the scaffold uses the current form. Quality of any specific model at `low` on this workload: `[unverified]` — no benchmark claimed in either direction |
| Hub — collect / review | Claude Opus 5, **the same session as the decompose stage** | `high` | Same session and same effort, on purpose and for two separate reasons. **Design:** the reviewer needs the contract in context to check adherence, and re-deriving it in a fresh session is what the pattern is trying to avoid paying for. **Mechanical:** changing the effort value between requests invalidates the cached prefix, so a hub that ran `high` to decompose and then dropped to `medium` to review would lose the cache the single-session design exists to exploit. Hold it constant. The corresponding cost is stated in §2 and §4 and is not mitigated here. | Effort changes invalidating cached prefixes, and the recommendation to hold effort constant within a cached conversation: `[official]` — [effort](https://platform.claude.com/docs/en/build-with-claude/effort) § "Changing effort mid-conversation" and § "Best practices", verified 2026-08-10. Same-session review: `[team-policy]` — maintainer decision, 2026-08-10, catalog issue #156 |

**No token-saving figure is claimed by this table.** The proposal this pattern came from asserted an ~80% saving; that is `[unverified]` and is recorded as an open measurement in §4, not as a property of the pattern. Do not repeat the number.

Update only via the process in the repo CLAUDE.md: a changed recommendation moves the As-of date and adds a §7 entry in the same commit.

## 4. Known failure modes / pitfalls

| Pitfall | Context | Mitigation | Recorded |
|---|---|---|---|
| **The hub reviews its own contract.** A brief that misreads the PRD produces code that faithfully implements the misreading, and the same context then approves it. No mechanical check can catch this — scope, firewall and tests all pass. | Design constraint (not a measured incident) — inherent to the single-session topology chosen in issue #156. The sibling pattern's §2 forbids exactly this configuration | Not mitigable within the pattern; it is the price. Partially bounded by: deterministic gates that outrank the hub's opinion, and `/hub-collect` instructing the hub to re-read the cited PRD section and question the brief rather than the code. **If this risk is unacceptable for your work, §1 says use the other pattern** — that is the real mitigation | 2026-08-10 |
| **Wrong decomposition is unrecoverable downstream.** Everything rests on the briefs, and the spokes are instructed not to think, so they will not flag a bad brief | Design constraint (not a measured incident) | `dispatch-spokes.mjs` gates the whole set **all-or-nothing** before creating any worktree: missing/empty required sections, empty or repo-wide `file_scope`, a scope naming a denied path, missing `test_cmd`, duplicate ids, dangling `blocked_by`, cycles, and unordered briefs with overlapping scopes. A single failure dispatches nothing | 2026-08-10 |
| **`codex exec`'s own exit codes are not documented**, so treating a zero exit as "the spoke finished" is an assumption, not a fact | Verified against the Codex CLI docs 2026-08-10: flags are documented, exit codes are not | The driver never reads the executor's exit code as a completion signal. A spoke counts as finished only if it left a parseable artifact at the `--output-schema`/`-o` path; anything else is a failure regardless of exit status. The exit code that *is* trusted belongs to the project's own `test_cmd` | 2026-08-10 |
| **A spoke can pass its tests while writing outside its scope**, and passing tests is exactly what would otherwise wave it through | Design constraint (not a measured incident) | `quarantined` outranks `passed`: the scope/firewall audit runs on the committed diff and, when it fails, overrides a green test run. `/hub-dispatch` explicitly forbids "fixing" a quarantine by widening the brief's `file_scope` | 2026-08-10 |
| **"Could not verify" silently read as "passed."** This is the failure class this repo has shipped most often (catalog issues #109, #115, #119, #127, #132, #141, #143) | Repo history, `[internal]` — the catalog's own PR record | `collect.mjs` has three states, not two. `unverified` (audit clean, tests could not be run) never merges and is reported by name | 2026-08-10 |
| **The collect stage is fully serial**, so fan-out only covers implementation. If the time is going into review and repair rather than into code generation, the serial tail dominates and the wall-clock win largely disappears | Design constraint (not a measured incident) — an unavoidable consequence of "exactly one hub session" | None available without a second reviewer context, which the topology rules out. Budget for it: the honest claim is *parallel implementation*, not a parallel pipeline | 2026-08-10 |
| **The hub's context grows monotonically** across the run — every diff, test log and repair round accumulates in the one session, and it is the one context that cannot be reset without discarding the contract knowledge that makes it the reviewer | Design constraint (not a measured incident). Directly counterweighs the pattern's cost premise; the sibling pattern's fresh-context reviewer does not have this problem | Keep briefs small so diffs stay small; collect and merge in waves rather than accumulating every branch to the end. **Not eliminated** — this is the leading candidate for why a measured saving might come in below expectations | 2026-08-10 |
| **The claimed ~80% token saving is unmeasured**, in either direction, and the two rows above are reasons it might not hold | `[unverified]` — from the originating proposal (catalog issue #156). No harness, no run, no numbers | Do not quote the figure. Measurement is an open item in §7; the first real run should record hub input/output tokens and spoke counts | 2026-08-10 |
| Harness-specific failures for these exact model + effort combinations | **None recorded yet** (as of 2026-08-10) — this pattern has never been run end to end | Record here with harness name, conditions and date when observed | — |

## 5. Upstream / downstream integration

**Upstream (work intake).** `docs/PRD.md` (master PRD) and any `docs/adr/` decision records are read by the hub in `/hub-brief`, which emits `docs/briefs/<ID>.md`. A brief is this pattern's unit of work — the counterpart of a ticket in the sibling pattern, and deliberately a different artifact: it carries a full **interface contract** because its implementer is not permitted to design one. `blocked_by` between briefs forms the dependency graph the driver schedules from.

**Downstream (deliverables).** Each spoke produces one `spoke/<ID>` branch. `collect.mjs` merges cleared branches into the base with `--no-ff`, one at a time. What gates a merge, in order: the brief exists and declares a `file_scope` · the diff is non-empty · no firewall-denied path · nothing outside the declared scope · `test_cmd` re-run **here** and exiting 0 · the hub's own diff review. A merge conflict between two spokes is **aborted, never resolved** — it means the decomposition was wrong, and resolving it by hand would conceal the decomposition error.

**No tracker integration.** Unlike the sibling pattern, this one does not publish issues or open PRs; the briefs and the branches are the record. That is a deliberate omission for speed, and it means there is no durable evidence trail once the branches are deleted — worth knowing before adopting it for work that needs an audit record.

**Human gates — exactly two:**

| Gate | When | What the human decides |
|---|---|---|
| **Gate 1** | After `/hub-brief`, before any dispatch | Are the briefs right? This is the **only** point at which a human can catch a wrong contract before it is implemented N ways in parallel. It carries more weight here than the equivalent gate in the sibling pattern, because there is no independent reviewer downstream to catch what slips through |
| **Gate 2** | After the last merge | Smoke-test the delivered result |

Between the gates the pipeline runs unattended. **The exception path back to a human:** a `blocked` spoke needing a firewall-denied change is a hub decision, not a human one — but a repeated quarantine on the same brief, or a merge conflict between spokes, means the decomposition is wrong, and re-cutting briefs after Gate 1 has passed should be surfaced to the human rather than done silently.

## 6. Scaffold

Everything in `scaffold/`; install steps in [`scaffold/INSTALL.md`](scaffold/INSTALL.md).

| File | Purpose |
|---|---|
| `.claude/commands/hub-brief.md` | Hub stage 1 — contract-first decomposition, stops at Gate 1 |
| `.claude/commands/hub-dispatch.md` | Hub stage 2 — runs the driver, reads the report, never enters a worktree |
| `.claude/commands/hub-collect.md` | Hub stage 3 — the landing gate, and the standing warning that this review is not independent |
| `.claude/scripts/firewall.mjs` | `DEFAULT_DENY` + `auditPaths()`. Fail-closed: a missing or unusable scope allows nothing |
| `.claude/scripts/brief.mjs` | Brief parsing, per-brief validation, dangling/cycle/scope-overlap detection, wave readiness |
| `.claude/scripts/dispatch-spokes.mjs` | The driver: all-or-nothing gate, worktree per brief, `codex exec`, capped repair loop, post-run audit. Exit `0`/`1`/`2` |
| `.claude/scripts/collect.mjs` | Re-audit, re-test, three-state verdict, `--merge` with conflict-abort |
| `.claude/settings.json` | Permission allowlist plus `deny` on `Edit`/`Write`/`NotebookEdit` under `.claude/worktrees/` |
| `claude-md-snippet.md` | Marker-guarded CLAUDE.md section — the seven non-negotiable rules and the stated known limit |
| `next-steps.txt` | The post-adopt instructions `adopt.mjs` prints for this pattern |
| `INSTALL.md` | Install, prerequisites, first run, firewall tuning, cleanup |

Codex CLI flags verified against the official docs **2026-08-10** (`codex exec`, `-m`, `-s/--sandbox`, `-c model_reasoning_effort=`, `--output-schema`, `-o`, `-C/--cd`, `--skip-git-repo-check`; `--full-auto` confirmed deprecated). Claude Code `permissions.allow`/`permissions.deny` shape follows the sibling pattern's `settings.json`, in use since 2026-07-17.

Covered by `testbed/e2e/suite-hub.mjs`, which exercises the firewall, the brief gate, the dispatch driver against a fake executor, and the collect gate.

## 7. Provenance & change log

| Date | Change | Basis | Author |
|---|---|---|---|
| 2026-08-10 | Initial entry, status `proposed`. Topology, effort matrix and the four distinguishing mechanisms (contract-first decomposition, global file firewall, `.test_cmd` exit-code gating, executors-only-in-worktrees) proposed by the maintainer. Two open questions resolved by the maintainer at drafting time: the final diff review is done by the **same hub session** (not an independent reviewer), and a failing test is repaired by the **executor itself** under a round cap (not a separate debugger tier) — both recorded in catalog issue #156 | Maintainer proposal + decisions, catalog issue #156. Codex CLI surface: [developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), verified 2026-08-10. Claude effort semantics: [effort](https://platform.claude.com/docs/en/build-with-claude/effort), verified 2026-08-10 | Horace Hou (proposal, decisions) / Claude (drafting, verification) |
| 2026-08-10 | Corrections applied before drafting, so they are not carried into the catalog: the proposal's `Claude 3.7 Sonnet` / `claude-3.7-opus` model names, its `claude-code --thinking-budget` and `codex-headless --effort` command lines, and its `--full-auto` flag are all non-existent or deprecated. §3 is written from the verified surface instead | CLAUDE.md grounding rule 1 (no training-data impressions); docs verified 2026-08-10 | Claude |
| 2026-08-10 | The proposal's "~80% token saving" recorded as `[unverified]` in §4 with two named counter-pressures (monotonic hub context, serial collect tail) rather than repeated as a benefit | CLAUDE.md grounding rule 1; no harness or run exists | Claude |
| — | **Open: first end-to-end run.** Status stays `proposed` until signed off, and cannot reach `adopted` until it has run ≥1 real ticket in a real project, named here. The first run should record hub input/output tokens, spoke count, quarantine rate and wall-clock, so §4's unmeasured rows can be closed | CLAUDE.md § "Adding a new pattern", promotion rule | — |
