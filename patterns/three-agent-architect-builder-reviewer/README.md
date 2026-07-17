# Pattern: Three-Agent Architect–Builder–Reviewer

| Field | Value |
|---|---|
| **Pattern name** | `three-agent-architect-builder-reviewer` |
| **Status** | `trialed` — signed off as the team standard 2026-07-17; promotes to `adopted` after its first real-ticket run (CLAUDE.md promotion rule) |
| **As-of date** | 2026-07-17 |
| **Expiry trigger** | First successor release to any listed model, or 2027-01-17 (+6 months), whichever comes first |
| **Sign-off** | Horace Hou (repo maintainer), 2026-07-17 |

One ticket flows through three agents in sequence: **Architect** plans → **Builder** implements → **Reviewer** (fresh context, different model tier) clears or bounces. No agent judges its own work.

## 1. When to use / when not to use

**Use when:**
- Ticket-scoped production changes where a bad merge is expensive: shared services, security-sensitive paths, concurrency-heavy code.
- The ticket is large enough to amortize three agent runs (rule of thumb: ≥ half a day of human-equivalent work).
- The team priority is predictable, reviewable delivery over token cost and latency — an explicit policy of this pattern.

**Do not use when:**
- Trivial or mechanical changes (typo fixes, config bumps, codemod output) — pipeline overhead dominates the value.
- Throwaway spikes and prototypes — a plan plus an independent review of disposable code adds nothing.
- Live pair-programming where a human already reviews every step in real time.

*(Scope guidance is design-derived, not a benchmark claim.)*

## 2. Agent roles & boundaries

| Agent | Does | Never does |
|---|---|---|
| **Architect** (Planner) | Reads the ticket and the codebase; produces the implementation plan. Exploration/tool-call heavy. | Writes production code. |
| **Builder** (Coder) | Implements against the Architect's plan; runs tests; iterates until passing. | Acts as the final judge of its own work; merges without Reviewer clearance. |
| **Reviewer** | Runs in a **fresh context** (never the Builder's session); reviews the Builder's output against the ticket and the plan, focusing on edge cases, concurrency, and security-sensitive paths. Clears the work or bounces it back to the Builder with findings. | Continues the Builder's session; fixes code itself. |

| **Triage** (nightly sweep only) | Classifies open tracker issues — fixable / invalid / needs-human — and synthesizes a cold-startable ticket file from each fixable one. | Fixes code; writes to the tracker (the report step owns all tracker writes). |

The Reviewer is **deliberately a different model tier from the Builder** so the two do not share blind spots. This is a hard requirement of the pattern, not a cost knob.

**Testing policy `[team-policy]` (2026-07-17):** the agents own the whole test pyramid. The Builder writes and runs unit + integration tests (and E2E tests where the ticket's acceptance calls for them); the Reviewer independently re-runs the full suite; the deliver step re-runs it on the merged default branch. Tests run manually or wired into the pipeline as fits the project. The human tests exactly once — the Gate 2 smoke test after the PRD's tasks are all done.

Related in-house variant: fx-eye-tracking's `planner` / `generator` / `evaluator` harness — same independence principle, heavier machinery (spec decomposition, file-scope parallelism, sprint contracts, tracker governance). That harness runs a whole project; this pattern runs one ticket.

## 3. Model + effort assignment (as of 2026-07-17)

| Role | Model | Effort | Reasoning | Source labels |
|---|---|---|---|---|
| Architect | Claude Sonnet 5 | `xhigh` | Planning is terminal/tool-call-heavy work, where Sonnet 5 benchmarks strongest in the lineup: Terminal-Bench 2.1 **80.4** vs Opus 4.8's **74.6**. `xhigh` is Anthropic's documented recommendation for agentic exploration workloads. | Benchmark: `[third-party]` (link not captured — attach at first re-verification). Effort guidance: `[official]` |
| Builder | Claude Opus 4.8 | `xhigh` | Anthropic's official guidance is to start at `xhigh` for coding and agentic use cases. Opus 4.8 leads Sonnet 5 on the hardest agentic-coding benchmark: SWE-bench Pro **69.2** vs **63.2**. One effort setting for all tickets — no per-ticket downgrades; team priority is predictable delivery over token cost. | Benchmark: `[vendor-benchmark]` (Anthropic-reported). Effort guidance: `[official]`. No-downgrade rule: `[team-policy]` |
| Reviewer | Claude Fable 5 | `max` | The Reviewer is the last quality gate before merge. Fable 5 has the largest capability margin on the hardest problems (SWE-bench Pro **~80.3**), and catching missed edge cases is where that margin pays off most. `max` because token cost is explicitly not the constraint at this gate. | Benchmark: `[unverified]` — recorded as "reported" without a named source; treat as unverified until linked. `max` choice: `[team-policy]` |
| Triage (nightly only) | Claude Sonnet 5 | `xhigh` | Classification + ticket synthesis is planning-shaped work; profile inherited from the Architect row rather than separately derived. | `[team-policy]` — no separate benchmark basis |

Figures are transcribed from the team-finalized specification dated 2026-07-17 (§7). Do not re-derive or silently alter them; update only via the process in the repo CLAUDE.md (new as-of date + provenance entry in the same commit).

## 4. Known failure modes / pitfalls

| Pitfall | Context | Mitigation | Recorded |
|---|---|---|---|
| **Reviewer contamination** — review run inside the Builder's session inherits the Builder's assumptions and blind spots | Design constraint from the pattern spec (not a measured incident) | Reviewer always starts in a fresh context; `/review-ticket` checks for and refuses a contaminated session | 2026-07-17 |
| **Tier collapse** — Reviewer switched to the Builder's model/tier "to save cost" | Design constraint | Different tier is a hard requirement; changing it means updating this pattern entry first, not the target repo's config | 2026-07-17 |
| **Self-clearing** — Builder declares its own "small" diff done and skips review | Process risk | No merge without a Reviewer verdict attached to the PR | 2026-07-17 |
| **Unbounded bounce loop** — Reviewer ↔ Builder ping-pong without convergence | Process risk | Cap at 2 bounce cycles, then escalate to a human | 2026-07-17 |
| **Cold-start starvation** — the fresh-context Reviewer (or Builder) lacks context that lived only in the Architect's conversation | Design implication of fresh contexts | Ticket and plan must be self-contained (cold-startable); a plan that needs the planning conversation to be understood is defective | 2026-07-17 |
| **`max`-effort overthinking / latency at the gate** | Claude Code's own effort-level description: `max` "may use excessive tokens resulting in long response times or overthinking. Use sparingly." — `[official]` product text, observed 2026-07-17 | Accepted at this gate by explicit `[team-policy]`; do not copy `max` to Builder/Architect by default; keep tickets small so review diffs stay bounded | 2026-07-17 |
| **Orchestrator role leakage** — the main (orchestrator) session absorbs subagent work: plans, implements, or reviews inline instead of dispatching, dissolving the role boundaries the pattern exists for | `[internal]` — observed on fx-eye-tracking's planner/generator/evaluator harness (sibling of this pattern), reported by the maintainer, 2026-07-17. Soft "launch the subagent" prompts alone did not hold. | Mechanically enforced since 2026-07-17: a PreToolUse guard denies main-session Edit/Write while subagent calls pass (`agent_id` is present in hook input only for subagents — see the verification record in `scaffold/INSTALL.md`). Backed by prose rules in the CLAUDE.md snippet and a "never absorb the role" line in every stage command. If leakage still recurs, switch to Mode B (separate human-run sessions — no orchestrator exists to leak). | 2026-07-17 |
| **Silent delivery drop** — end-of-pipeline bookkeeping relied on side effects that never fired: many MRs merged, **zero** tracker issues closed, and no step verified the transition | `[internal]` — fx-eye-tracking, reported by the maintainer, 2026-07-17. Root cause on that instance not yet diagnosed; typical causes: missing `Closes #N` in the MR description, or merging to a non-default branch (GitLab auto-close fires only on default-branch merges). | Delivery is verified, not assumed: run `/verify-delivery <ticket>` after every merge — it checks the Definition of Done (plan · tests · CLEAR verdict · merged · issue closed · writeback) and repairs gaps only with explicit human OK. Never trust tracker auto-close blindly. | 2026-07-17 |
| **Guard bypass via Bash** — the write guard blocks the Edit/Write tool family only; the main session can still modify files through Bash (`echo >`, `git apply`, heredocs) | Known boundary of the mechanical guard — design analysis, 2026-07-17, not an incident | Accepted deliberately: blocking Bash would break legitimate orchestrator operations (checkout, merge, tracker CLI). The guard targets the observed failure mode — reflexive "I'll just edit it myself" — not a determined bypass. Prose rule stands: Bash in the main session is for orchestration, never for writing files. If bypass is ever observed in practice, record it here and escalate to Mode B. | 2026-07-17 |
| **Nightly grinding** — the sweep re-attempts the same unfixable issue night after night, burning tokens | Design risk of the nightly loop (not a measured incident) | Unsolved/failed issues get `nightly:escalated` and are excluded from later sweeps until a human clears the label; `maxIssues` caps each night's spend | 2026-07-17 |
| **Autonomous misjudgment of "invalid"** — the sweep wrongly declares a real issue invalid and it gets ignored | Design risk | Invalid verdicts only **label** (`triage:invalid`) and comment with evidence — never auto-close; the morning human is the final judge; triage is instructed to prefer `needs-human` when uncertain | 2026-07-17 |
| **Harness-specific timeouts/failures** for these exact model+effort combinations | **None recorded yet** (as of 2026-07-17) | When observed: record here with harness name, conditions, and date | — |

## 5. Upstream / downstream integration

**Upstream (work intake)** — assumes the standard docs layout (exemplar: fx-eye-tracking):

- `docs/PRD.md` (master PRD) → `docs/prd/<module>/README.md` (sub-PRD) → `docs/prd/<module>/tickets/*.md` (one file per ticket; each ticket is a future issue body).
- The **ticket file is the Architect's input**; the Architect also reads the linked sub-PRD and any `docs/adr/` entries touching the affected area.
- The Architect's plan lands at `docs/plans/<ticket-id>.md`. A hard-to-reverse choice made while planning becomes a new ADR, not a paragraph buried in the plan.

**Downstream (deliverables):**

- Builder → a PR: code + passing tests, referencing the ticket and the plan, plus a deviations note where it departed from the plan.
- Reviewer → a verdict on the PR: **CLEAR** (short note of what was checked) or **BOUNCE** (numbered findings: `file:line`, failure scenario, severity). Findings go back to the Builder.
- Net output: merged PR, updated docs/ADRs, closed ticket. Merge requires a CLEAR verdict.
- **Feedback channel (upstream):** pattern-level problems observed while running the pipeline — a role boundary that misfits, a stale model/effort pin, an orchestration bug — are filed as issues against the pattern catalog (`Ruihang2017/agent-templates`, issue templates provided); the catalog self-hosts the nightly sweep and triages them. Project-level bugs stay in the project's own tracker.
- Delivery is **verified, not assumed**: after every merge, `/verify-delivery <ticket>` checks the Definition of Done — plan on disk · tests green · CLEAR verdict · MR merged into the default branch · tracker issue closed · writeback done. Added 2026-07-17 after the fx-eye-tracking silent-delivery-drop observation (§4).

**Human gates (target operating model):**

- **Gate 1 — upstream sign-off = the start signal:** once the module's sub-PRD and all its tickets are generated (format: `scaffold/templates/ticket.template.md`), a human types **`/start-milestone <module>`**. That one action is the sign-off. The session then publishes every ticket as a tracker issue (`.claude/scripts/publish-tickets.mjs` — deterministic and idempotent, `[<id>]` title prefix as the dedupe key; agents never hand-create issues) and launches the milestone runner.
- **Gate 2 — smoke test:** a human smoke-tests the delivered work at the end of the ticket batch / milestone.
- **Between the gates the pipeline runs autonomously** via `.claude/workflows/run-milestone.js` (a Workflow script): plan → build → review → merge on CLEAR → deliver (including closing the tracker issue), with no per-ticket human approval. Stage order, reviewer freshness, the bounce cap, and no-merge-without-CLEAR are enforced **in code**, not prose — prose-only orchestration is a recorded failure mode (§4).
- **Exception path (the only other way a human appears):** 2 bounce cycles without convergence, a failed build, or an unrepairable delivery item escalates to a human; the runner is fail-fast by default because later tickets may depend on earlier ones.
- **On-ramp:** a project newly adopting the pattern starts in `supervised` mode: the runner takes one ticket to a CLEAR verdict and **stops the run** for the human merge (later tickets may depend on the merged result). Re-run `/start-milestone` to continue — tickets whose issues are already closed are filtered out before the run, which also makes crash recovery mechanical. Switch to `autonomous` once the pattern holds. The mode is declared in the target repo's CLAUDE.md (see `scaffold/claude-md-snippet.md`).

**Orchestration mechanics:** a single ticket can still be run by hand with the stage commands; a milestone runs through the deterministic workflow. `ultracode` is not needed in target repos — typing `/start-milestone` is the explicit orchestration request (its instructions call the Workflow tool). Note that `ultracode` is a Claude Code **session setting** (`xhigh` effort + automatic workflow orchestration), not a model effort level — the pattern's pinned per-role efforts are unaffected by it. `[official]` — workflows + model-config docs, verified 2026-07-17 (record in `scaffold/INSTALL.md`).

**Nightly issue sweep (unattended variant):** `claude -p "/nightly-issues"` on an OS schedule (Windows Task Scheduler etc.) while the machine is on. Flow: collect open issues → **Triage** (read-only; synthesizes tickets under `docs/prd/99-nightly/` for fixable ones) → **run-milestone** (autonomous, `continueOnFailure` — issues are independent) → one **report** step does all tracker writes: per-issue outcome comments, labels (`triage:invalid` / `nightly:escalated` / `needs-human`), closes delivered issues, and a `Nightly report YYYY-MM-DD` issue. The morning email is the tracker's own notification stream (watch the repo) — no SMTP to configure. Cost cap: `maxIssues` per night (default 5). Hand-written issues follow the native tracker templates (`scaffold/tracker-templates/`) so triage can convert them mechanically. Headless flags, permissions, and scheduling: `scaffold/INSTALL.md` § Nightly sweep.

## 6. Scaffold

```
scaffold/
├── INSTALL.md                 # install steps + config-key verification record
├── claude-md-snippet.md       # block to append to the target repo's CLAUDE.md
├── templates/
│   └── ticket.template.md     # ticket format (= issue body); adapted from fx-eye-tracking
├── tracker-templates/         # native issue templates → hand-written issues keep the format
│   ├── github/ISSUE_TEMPLATE/ #   bug-report.md · task.md  (copy to .github/ISSUE_TEMPLATE/)
│   └── gitlab/issue_templates/#   bug-report.md · task.md  (copy to .gitlab/issue_templates/)
└── .claude/
    ├── settings.json          # wires the PreToolUse write guard
    ├── hooks/
    │   └── guard-main-session-writes.mjs  # denies main-session Edit/Write; subagents pass
    ├── scripts/
    │   └── publish-tickets.mjs # tickets → tracker issues; idempotent; dry-run by default
    ├── workflows/
    │   ├── run-milestone.js   # deterministic milestone runner (Workflow script)
    │   └── nightly-issues.js  # nightly sweep: triage → pipeline → report (Workflow script)
    ├── agents/                # role definitions with pinned model + effort
    │   ├── architect.md       # claude-sonnet-5 @ xhigh; writes the plan, no production code
    │   ├── builder.md         # claude-opus-4-8 @ xhigh; inherits all tools
    │   ├── reviewer.md        # claude-fable-5 @ max; read/run-only (no Write/Edit)
    │   └── triage.md          # claude-sonnet-5 @ xhigh; nightly classification + ticket synthesis
    └── commands/
        ├── plan-ticket.md     # /plan-ticket <ticket>    → Architect stage
        ├── build-ticket.md    # /build-ticket <ticket>   → Builder stage
        ├── review-ticket.md   # /review-ticket <ticket>  → Reviewer stage (fresh context)
        ├── verify-delivery.md # /verify-delivery <ticket> → post-merge Definition-of-Done check
        ├── start-milestone.md # /start-milestone <module> → Gate 1 signal: publish issues + run milestone
        └── nightly-issues.md  # /nightly-issues [max]     → unattended sweep (headless claude -p)
```

The deterministic chain is covered by the repo's Level-0 E2E (`node testbed/e2e/run-e2e.mjs`, see `testbed/README.md`) — green is the merge gate for scaffold changes. Level 1 (live pipeline rehearsal on `testbed/app/`) is the promotion trigger from `trialed` to `adopted`.

Install steps and usage modes: [scaffold/INSTALL.md](scaffold/INSTALL.md). Frontmatter keys (`model`, `effort`, `tools`, command arguments) verified against official Claude Code docs on 2026-07-17 — see the verification record in INSTALL.md.

## 7. Provenance & change log

| Date | Change | Basis | Author |
|---|---|---|---|
| 2026-07-17 | Initial entry. Roles, boundaries, and the model/effort table adopted as the team standard. | Team-finalized specification, 2026-07-17. Benchmark figures transcribed as recorded there; original source links were not captured — attach them at the first re-verification. Scaffold config keys verified against live Claude Code docs same day (record in `scaffold/INSTALL.md`). | Horace Hou (spec) / Claude Fable 5 (write-up) |
| 2026-07-17 | Added two `[internal]` failure modes observed on the fx-eye-tracking sibling harness: orchestrator role leakage, and silent delivery drop (MRs merged, issues never closed). Hardened the scaffold accordingly: orchestrator-discipline rules in the CLAUDE.md snippet, "never absorb the role" line in every stage command, new `/verify-delivery` Definition-of-Done command. Model/effort table unchanged. | Maintainer report (Horace Hou), 2026-07-17. | Horace Hou (report) / Claude Fable 5 (write-up) |
| 2026-07-17 | Documented the target operating model — two human gates (upstream PRD/sub-PRD/ticket sign-off; final smoke test), autonomous pipeline in between, `supervised` on-ramp mode. Orchestrator write-denial is now mechanically enforced: PreToolUse guard denies main-session Edit/Write, subagent calls pass. Model/effort table unchanged. | Maintainer direction (Horace Hou), 2026-07-17. Hook mechanism verified against live Claude Code docs the same day (hooks.md, permissions.md — record in `scaffold/INSTALL.md`). | Horace Hou (direction) / Claude Fable 5 (write-up) |
| 2026-07-17 | Gate 1 made concrete: `/start-milestone` = the human start signal → tickets auto-published as tracker issues (`publish-tickets.mjs`, adapted from fx-eye-tracking `create-issues.mjs`; `[<id>]` title prefix as dedupe key; smoke-tested dry-run/no-CLI/usage paths) → deterministic milestone runner (`run-milestone.js` Workflow script: stage order, reviewer freshness, bounce cap, merge policy in code). Added `templates/ticket.template.md` (adapted from fx ticket discipline). Recorded the Bash guard boundary as a known pitfall. Clarified `ultracode`: a session setting (`xhigh` + automatic workflow orchestration), not a model effort level — role efforts unchanged. | Maintainer direction (Horace Hou), 2026-07-17. fx-eye-tracking conventions read the same day (read-only). Workflow tool, `.claude/workflows/`, and `ultracode` semantics verified against live docs (workflows, claude-directory, model-config — record in `scaffold/INSTALL.md`). | Horace Hou (direction) / Claude Fable 5 (write-up) |
| 2026-07-17 | Documented the **upstream feedback channel** (target repos file pattern-level issues against the catalog, which self-hosts the nightly sweep to triage them). The catalog repo also adopted issue/PR decision-record discipline — see catalog issues #1–#5. | Maintainer direction (Horace Hou), 2026-07-17. | Horace Hou (direction) / Claude Fable 5 (write-up) |
| 2026-07-17 | Added the unattended **nightly issue sweep** (triage agent + `nightly-issues` workflow + `/nightly-issues` headless entry + native tracker issue templates so hand-written issues keep the pipeline format), the **testbed** (Level-0 deterministic E2E — 122 checks over guard/publisher/runner — plus the Level-1 live-rehearsal app; Level-0 green is now the merge gate for scaffold changes), `GH_BIN`/`GLAB_BIN` test-double overrides (fx `GLAB_BIN` precedent), and the **testing policy**: agents own unit/integration/E2E; the human's only test duty is the Gate 2 smoke test after the PRD completes. Headless/permission/scheduling facts verified against live docs (headless.md, permission-modes.md, permissions.md, scheduled-tasks.md, routines.md — record in `scaffold/INSTALL.md`). | Maintainer direction (Horace Hou), 2026-07-17; verified by testbed E2E 122/122 green. | Horace Hou (direction) / Claude Fable 5 (build) |
| 2026-07-17 | Pre-merge adversarial review (three parallel reviewers; script findings reproduced with fixtures and fake gh/glab CLIs) — all findings fixed. Runner: a reviewer infrastructure failure no longer consumes bounce budget or dispatches phantom fixes (one retry → escalate `reviewer-failed`); `delivered` now requires merged ∧ issueClosed ∧ dodPassed; plan paths computed in code, agent-returned values verified; branch mismatch = builder failure; empty-findings BOUNCE escalates; config strictly validated; `supervised` mode stops the run after each CLEAR for dependency safety, resumable because closed issues are filtered on re-run. Publisher: existence check now fetches the issue list once per run and matches the `[<id>]` prefix exactly (fixes wrong-issue-number matching and per-ticket search rate/consistency risks); create failures keep the machine-readable summary and exit 1; within-run duplicate-id dedupe; BOM and quoted-YAML titles handled; invalid tickets included in the summary. DoD gains an explicit "tests green" item (verify-delivery + deliver prompt). Status corrected `adopted` → `trialed` per the promotion rule — this pattern has not yet run a real ticket (fx-eye-tracking ran the sibling harness, not this pipeline). | Internal adversarial review, 2026-07-17. | Claude Fable 5 (fixes); status correction flagged for maintainer confirmation |
