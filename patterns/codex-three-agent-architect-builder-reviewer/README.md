# Pattern: Codex Three-Agent Architect–Builder–Reviewer

| Field | Value |
|---|---|
| **Pattern name** | `codex-three-agent-architect-builder-reviewer` |
| **Status** | `proposed` |
| **As-of date** | 2026-08-11 |
| **Expiry trigger** | First successor release to any listed model, or 2027-02-11, whichever comes first |
| **Sign-off** | Pending — Horace Hou, maintainer |

A Codex-native port of the catalog's three-agent assurance topology: a planning Architect hands a cold-startable artifact to a Builder, and a fresh-context read-only Reviewer clears or bounces the diff. Repository skills replace Claude slash commands; project custom-agent TOML replaces Claude agent frontmatter; deterministic Node scripts retain the ticket, DAG, tracker, and delivery gates.

## 1. When to use / when not to use

**Use when:**

- A ticket changes several files or behaviors and a bad merge is expensive enough to justify an independent review context.
- Work starts from a PRD or cold-startable ticket, is delivered through a branch and PR/MR, and has an executable test suite.
- The project can run tickets sequentially and values role isolation over maximum implementation throughput.
- The team wants Gate 1 human sign-off, unattended plan/build/review between gates, and a final human smoke test.

**Do not use when:**

- The task is a trivial typo or mechanical one-file edit whose three-context overhead exceeds its risk.
- Multiple Builders must edit concurrently. Codex-native v1 deliberately rejects `concurrency > 1` because it does not yet create isolated worktrees per writing subagent.
- Requirements cannot be made cold-startable, acceptance is subjective, or implementation needs continuous product decisions.
- The repository has no reliable test command, or the change cannot be reviewed as a bounded diff.
- Independent review is unnecessary and parallel throughput matters more; consider `hub-and-spoke-orchestrator-executors` and accept its same-hub review limitation explicitly.

## 2. Agent roles & boundaries

| Agent | Does | Never does |
|---|---|---|
| **Primary orchestrator** | Selects repo skills, spawns named custom agents, passes artifacts, enforces the bounce cap, and relays complete outcomes | Plans, edits, reviews, invents a verdict, or absorbs a failed stage |
| **Architect** | Explores the codebase; writes the per-ticket HOW plan or PRD breakdown artifacts | Writes production code/tests, changes tracker state, or turns an unspecified requirement into spec |
| **Builder** | Implements one ticket on `ticket/<id>`, writes and runs unit/integration/E2E tests, commits, records deviations | Clears, reviews, merges, publishes issues, or expands ticket scope |
| **Reviewer** | Starts fresh, receives artifact references only, runs the full suite, returns CLEAR or numbered BOUNCE findings | Reads the Builder transcript, trusts self-reported tests, edits, repairs, or merges |
| **Delivery actuator** | Writes supplied verdict/body scratch files and invokes deterministic publication/delivery scripts | Supplies judgment, resolves conflicts, bypasses checks/protection, or improvises around a script refusal |
| **Triage (optional)** | Classifies issues and synthesizes a cold-startable ticket for fixable items | Fixes code or writes tracker state |

### Why this pattern keeps a delivery actuator and the Claude sibling does not

The sibling pattern deleted its delivery stage outright (catalog issue #206): it made no judgement, and giving it a separate context is what forced a Reviewer's approval to be handed across a boundary and re-typed — which safety classifiers blocked. That reasoning applies here unchanged.

The conclusion does not, because the reason this actuator exists is **mechanical, not architectural**. `.codex/config.toml` sets `sandbox_mode = "read-only"` on the primary thread: the orchestrator here physically cannot write a file or run git. Deleting the actuator would mean opening that sandbox — trading a real enforcement mechanism for symmetry with a sibling — and `workspace-write` is separately reported unusable on restricted Windows hosts, where the restricted-token sandbox refuses to start and Codex falls back to shell-routed `apply_patch` (catalog issue #203).

So the actuator stays, held to the narrowest possible remit: it writes **supplied** bytes and runs one command. It never composes a PR/MR body and never authors a verdict (issue #193), and the Reviewer writes its own review record. The failure mode #206 describes is closed by those two rules rather than by deleting the role.

The Reviewer judges the Builder. No agent judges its own work. A BOUNCE returns to the same Builder thread so implementation context is retained; the next review is always a new Reviewer thread. Two BOUNCE cycles without CLEAR pull in a human.

All three test levels belong to agents. The Builder creates and runs focused tests; the Reviewer independently runs the full suite. The human performs only the final smoke test after PRD delivery.

Mechanical boundaries:

- `.codex/config.toml` makes the primary thread read-only by default.
- `reviewer.toml` is read-only; Builder and Architect receive workspace write only because their roles require it.
- Delivery is concentrated in `.codex/scripts/deliver-ticket.mjs`; CLEAR is a required input.
- Model context isolation is an orchestration rule plus a separate Reviewer thread. Builder transcripts are never handed over.

Known enforcement limit: current Codex documentation says live parent-turn permission overrides are reapplied to spawned children. A user choosing a more permissive live mode can therefore weaken project sandbox defaults; artifact isolation and independent review still apply, but the primary no-write boundary is then instruction-enforced.

## 3. Model + effort assignment (as of 2026-08-11)

| Role | Model | Effort | Reasoning | Source labels |
|---|---|---|---|---|
| Architect | `gpt-5.6-sol` | `high` | Ambiguous decomposition, repository exploration, dependency design, and edge-case planning are the most reasoning-heavy planning work. | `[official]` [Subagents: model choice and custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md) says to start with the GPT-5.6 flagship tier for demanding, ambiguous, multi-step work; the id is `gpt-5.6-sol` — a bare `gpt-5.6` is a tier family, not a model id; `[team-policy]` high effort for the planning gate. |
| Builder | `gpt-5.6-sol` | `medium` | Implementation needs strong agentic coding and follow-through; medium is the balanced starting point because independent review carries the final judgment. | `[official]` [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md) and [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model); `[team-policy]` medium balances cost and repairability. |
| Reviewer | `gpt-5.6-terra` | `high` | A deliberately different tier reduces identical-context/model coupling; high effort is reserved for tracing behavior, assumptions, concurrency, and security. | `[official]` [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md) explicitly uses `gpt-5.6-terra` high for a correctness/security/test reviewer example and describes high for complex logic and edge cases; `[team-policy]` model diversity is an assurance choice, not a capability claim. |
| Delivery actuator | `gpt-5.6-luna` | `low` | Its task is narrow and repeatable: validate inputs, run one deterministic command, and relay structured output. | `[official]` [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md) positions Luna for fast, narrowly scoped repeatable work and low effort for straightforward tasks; `[team-policy]` no judgment is delegated here. |
| Triage | `gpt-5.6-terra` | `high` | Read-heavy exploration plus classification benefits from a fast reviewer-shaped profile; ambiguity fails toward needs-human. | `[official]` [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md); `[team-policy]` inherits the Reviewer-shaped profile. |

These are initial recommendations, not measured superiority claims. No Codex Level-1 run of these exact assignments exists yet.

## 4. Known failure modes / pitfalls

| Pitfall | Context | Mitigation | Recorded |
|---|---|---|---|
| Parallel write-heavy subagents can conflict in one checkout | Design constraint from official subagent guidance; this scaffold has no per-Builder worktree driver | Reject `concurrency > 1`. Use sequential global-DAG scheduling or a worktree-isolated pattern | 2026-08-11 |
| A live parent permission override can supersede a custom agent's sandbox setting | Documented Codex subagent behavior; not yet exercised by this scaffold | Keep normal project defaults, inspect permission mode before Gate 1, and treat any override as a deliberate weakening of the primary no-write boundary | 2026-08-11 |
| Architect path scope is not mechanically restricted to planning files | Design constraint: Architect requires workspace write to create plans and PRD artifacts, while current PreToolUse input does not expose subagent identity for a role-specific path guard | Reviewer and git diff detect leakage; a future runner should give the Architect an isolated artifact worktree or role-aware hook when supported | 2026-08-11 |
| Skills are model-orchestrated, not an equivalent of Claude's deterministic Workflow scripts | Design difference, not a measured incident | Keep graph parsing, tracker publication, and delivery in deterministic Node scripts; make the pattern `proposed` until real runs validate orchestration | 2026-08-11 |
| Headless approvals cannot surface interactively | Official `codex exec` behavior for non-interactive runs | Treat headless milestone/nightly use as unverified; fail rather than bypass, or run in an externally isolated CI design with explicit least privilege | 2026-08-11 |
| Copied delivery and DAG scripts may drift from the Claude sibling | Catalog maintenance risk; two runtime copies now exist | E2E integrity tests compare logic or fixtures, and every sibling bug fix must state whether the Codex copy is affected | 2026-08-11 |
| Harness-specific failures for these exact model+effort combinations | **None recorded yet** (as of 2026-08-11) | Record the harness, conditions, model, effort, and date after each real run | — |

## 5. Upstream / downstream integration

**Upstream (work intake).** `docs/PRD.md` or a later `docs/PRD-NN-<phase>.md` is decomposed by `$breakdown-prd` into the single global `docs/prd/` tree. Module READMEs and template-compliant tickets carry file scope, dependencies, acceptance, and tests. `docs/adr/` supplies hard-to-reverse decisions. Gate 1 is the human review of the decomposition followed by `$start-milestone` or `$start-all`.

**Pipeline.** The primary thread spawns Architect, Builder, and a fresh Reviewer by their project custom-agent names. BOUNCE findings return to the Builder; CLEAR flows to the delivery actuator. `.codex/scripts/dag-scan.mjs`, `publish-tickets.mjs`, and `deliver-ticket.mjs` keep graph, issue creation, and merge/DoD behavior deterministic.

**Downstream (deliverables).** In supervised mode, CLEAR produces an open PR/MR with the verdict attached and stops. In autonomous mode, the delivery script may merge only through the configured forge/default-branch policy, rerun tests, close and verify the issue, and report `dodPassed`. `$verify-delivery` independently checks the plan, verdict comment, merged default branch, green suite, closed issue, and ticket writeback.

**Human gates — exactly two on the happy path:**

| Gate | Human decision |
|---|---|
| Gate 1 | Approve PRD decomposition, ticket scope, dependency DAG, and the start signal |
| Gate 2 | Smoke-test the delivered phase |

Humans re-enter on the exception path: two BOUNCE cycles, a failed stage, drift in a delivered ticket, a spec gap, branch protection/check refusal, or an unrepairable Definition-of-Done failure. Supervised mode intentionally adds a human merge at each CLEAR while the pattern is being proven.

## 6. Scaffold

Install with [`scaffold/INSTALL.md`](scaffold/INSTALL.md).

Parity with the Claude sibling in this proposed v1:

| Capability | Codex v1 |
|---|---|
| Architect → Builder → fresh Reviewer, CLEAR/BOUNCE, two-bounce cap | Included |
| PRD phases, append freeze, global dependency DAG, issue publication, supervised/autonomous delivery, post-merge DoD | Included |
| Parallel ticket lanes | Not included — sequential safety boundary until worktree isolation exists |
| Unattended nightly issue sweep | Not included — `triage.toml` defines the classification role, but no scheduled/reporting entry point ships yet |
| Asana mirror | Not included — the catalog's current integration is Claude-runtime-specific |

| File | Purpose |
|---|---|
| `.codex/config.toml` | Enables subagents, caps threads, and makes the primary thread read-only by default |
| `.codex/agents/architect.toml` | Planning and PRD-decomposition agent |
| `.codex/agents/builder.toml` | Implementation and test owner |
| `.codex/agents/reviewer.toml` | Fresh-context read-only CLEAR/BOUNCE judge |
| `.codex/agents/delivery.toml` | Narrow deterministic-script actuator |
| `.codex/agents/triage.toml` | Reserved issue classifier/ticket synthesizer for manual triage and a future nightly runner |
| `.agents/skills/*/SKILL.md` | Codex-native workflow entry points replacing slash commands |
| `.codex/scripts/dag-*.mjs`, `prd-phase.mjs` | Deterministic phase freeze, graph validation, and HTML report |
| `.codex/scripts/publish-tickets.mjs` | Idempotent GitHub/GitLab issue publication |
| `.codex/scripts/deliver-ticket.mjs` | CLEAR-only PR/MR, merge, issue-close, tests, and DoD gate |
| `agents-md-snippet.md` | Marker-guarded repository guidance appended to `AGENTS.md` |
| `next-steps.txt` | Runtime-specific adoption handoff |

Configuration keys and behavior were checked on 2026-08-11 against the official OpenAI documentation. `codex --version` and `codex exec --help` confirmed the installed `codex-cli 0.147.0` surface; the zero-token E2E suite statically checks every required custom-agent key, role pin, skill, script path, and installer output.

## 7. Provenance & change log

| Date | Change | Basis | Author |
|---|---|---|---|
| 2026-08-11 | Initial Codex-native pattern, status `proposed`. Preserves the sibling pattern's three judging stages, artifact handoffs, two-bounce cap, ticket-as-spec rule, tracker/DAG scripts, and CLEAR-only delivery. Replaces Claude agents/commands/workflows with Codex project custom agents, repo skills, and native subagent orchestration. | User request; existing `three-agent-architect-builder-reviewer` behavior; official [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md), [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md), [Skills](https://learn.chatgpt.com/docs/build-skills.md), and [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md), verified 2026-08-11 | Codex |
| 2026-08-11 | Parallel Builder execution intentionally excluded from v1. The DAG remains global and dynamic but executes sequentially because native subagents share the checkout and no worktree-isolated Codex runner is present. | Official subagent guidance warns that parallel write-heavy workflows can conflict; assurance boundary chosen by team policy | Codex |
| 2026-08-11 | **Corrected the Architect and Builder model pin: `gpt-5.6` -> `gpt-5.6-sol`.** A bare `gpt-5.6` is a tier FAMILY, not a model id — Codex exposes `gpt-5.6-sol` / `-terra` / `-luna` — so both stages would have failed at spawn. The E2E suite had hardcoded the same wrong value, i.e. a green gate over a configuration that could not run; it now asserts membership in the documented id set and that README §3 matches the scaffold, which catches the whole class rather than this instance. §3 as-of date unchanged: the intended tier (flagship for planning and implementation, a different tier for review) is exactly what it always was — only the identifier was wrong. | `[official]` [Models](https://learn.chatgpt.com/docs/models), verified 2026-08-11 | Claude (review) |
| 2026-08-11 | Added a script-parity gate between `.codex/scripts/` and `.claude/scripts/`. They are hand-maintained copies, and a copy is the most reliable way this catalog ships a bug twice: fix delivery for GitLab in one runtime and the other silently keeps the defect, with every suite green because each reads only its own copy. The gate compares CODE (whole-line comments stripped, runtime paths normalised), so runtime-specific rationale may differ but behaviour may not. | Structural risk, no incident yet | Claude (review) |
| 2026-08-12 | **PR-body authorship moved out of the Delivery actuator** (catalog issue #193). Two shipped contracts disagreed: `run-ticket` step 5 told the orchestrating thread to have `delivery` "compose the repository PR/MR template", while `delivery.toml` defines that agent as a mechanical actuator at low reasoning effort that may write only *supplied* text and must not invent a verdict or body. The conflict resolves one way only — a complete body carries bounce count, Reviewer findings, declared deviations and test evidence, none of which a delivery actuator holds, so asking it to compose meant asking a low-effort role to produce fluent, plausible, invented review history in the one document a human reads to trust the run. The skill now composes the body in the orchestrating thread from named stage artifacts (a section→source table), requires an explicit "unavailable, because …" instead of any inference, and hands `delivery` bytes to write verbatim; `delivery.toml` now refuses a compose request outright. The E2E suite asserts BOTH sides, because a one-sided assertion is exactly how the two drifted apart. | `[internal]` catalog issue #193, fixed and mutation-tested 2026-08-12. | Claude Opus 5 |
| 2026-08-12 | **Ported issue #192's delivery-report fixes** from the sibling pattern (supervised `--no-merge` no longer claims a merge in the PR marker; `planExists` evaluated before the early exits so an unperformed check is not reported as a failed one). The script-parity gate is what forced the port in the same commit rather than leaving the Codex copy silently defective. | `[internal]` catalog issue #192, 2026-08-12. | Claude Opus 5 |
| 2026-08-18 | **This pattern KEEPS its `delivery` agent while the Claude sibling deletes theirs** (catalog issue #206) — a deliberate, grounded divergence rather than a lag. The sibling's argument is that delivery makes no judgement and its separate context is what forces a Reviewer's approval to be re-typed across a boundary; that argument holds here too. What does not hold is the conclusion, because the reason this actuator exists is **mechanical**: `.codex/config.toml` sets `sandbox_mode = "read-only"` on the primary thread, so the orchestrator physically cannot write a file or run git. Removing the role would mean opening that sandbox — trading a real enforcement mechanism for symmetry with a sibling pattern — and `workspace-write` is separately reported unusable on restricted Windows hosts (catalog issue #203: the restricted-token sandbox refuses to start, 426 failures). The actuator stays held to writing supplied bytes and running one command, and composes nothing (issue #193). | `[internal]` catalog issues #206, #203, and the scaffold's own `sandbox_mode`, 2026-08-18. | Claude Opus 5 |
| 2026-08-18 | **Ticket selection became deterministic** (catalog issue #206): `start-all` and `start-milestone` no longer read `blocked_by` in prose to pick the next ready ticket — they call `wave-plan.mjs` and take its `ready` list. The script is ported from the Claude pattern under the existing parity gate, and it adds what prose could not guarantee: `unreachable` tickets named with the blocker that failed them, a non-zero exit on a cycle or a dangling dependency, and a `--module` matching nothing failing loudly instead of reporting "nothing left to run". `deliver-wave.mjs` is ported alongside it so both runtimes share one delivery policy. | `[internal]` catalog issue #206, 2026-08-18. | Claude Opus 5 |
| — | Open: maintainer schema/sign-off review and first Level-1 rehearsal in a temporary target repository | Required before `trialed`; first real project/ticket is required before `adopted` | — |
