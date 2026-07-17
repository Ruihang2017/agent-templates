# Pattern: Three-Agent Architect–Builder–Reviewer

| Field | Value |
|---|---|
| **Pattern name** | `three-agent-architect-builder-reviewer` |
| **Status** | `adopted` |
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

The Reviewer is **deliberately a different model tier from the Builder** so the two do not share blind spots. This is a hard requirement of the pattern, not a cost knob.

Related in-house variant: fx-eye-tracking's `planner` / `generator` / `evaluator` harness — same independence principle, heavier machinery (spec decomposition, file-scope parallelism, sprint contracts, tracker governance). That harness runs a whole project; this pattern runs one ticket.

## 3. Model + effort assignment (as of 2026-07-17)

| Role | Model | Effort | Reasoning | Source labels |
|---|---|---|---|---|
| Architect | Claude Sonnet 5 | `xhigh` | Planning is terminal/tool-call-heavy work, where Sonnet 5 benchmarks strongest in the lineup: Terminal-Bench 2.1 **80.4** vs Opus 4.8's **74.6**. `xhigh` is Anthropic's documented recommendation for agentic exploration workloads. | Benchmark: `[third-party]` (link not captured — attach at first re-verification). Effort guidance: `[official]` |
| Builder | Claude Opus 4.8 | `xhigh` | Anthropic's official guidance is to start at `xhigh` for coding and agentic use cases. Opus 4.8 leads Sonnet 5 on the hardest agentic-coding benchmark: SWE-bench Pro **69.2** vs **63.2**. One effort setting for all tickets — no per-ticket downgrades; team priority is predictable delivery over token cost. | Benchmark: `[vendor-benchmark]` (Anthropic-reported). Effort guidance: `[official]`. No-downgrade rule: `[team-policy]` |
| Reviewer | Claude Fable 5 | `max` | The Reviewer is the last quality gate before merge. Fable 5 has the largest capability margin on the hardest problems (SWE-bench Pro **~80.3**), and catching missed edge cases is where that margin pays off most. `max` because token cost is explicitly not the constraint at this gate. | Benchmark: `[unverified]` — recorded as "reported" without a named source; treat as unverified until linked. `max` choice: `[team-policy]` |

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
| **Orchestrator role leakage** — the main (orchestrator) session absorbs subagent work: plans, implements, or reviews inline instead of dispatching, dissolving the role boundaries the pattern exists for | `[internal]` — observed on fx-eye-tracking's planner/generator/evaluator harness (sibling of this pattern), reported by the maintainer, 2026-07-17. Soft "launch the subagent" prompts alone did not hold. | Hard orchestrator-discipline rules in the target repo's CLAUDE.md (main session never does stage work); every stage command carries a "never absorb the role" line. If leakage recurs, switch to Mode B (separate human-run sessions — no orchestrator exists to leak). | 2026-07-17 |
| **Silent delivery drop** — end-of-pipeline bookkeeping relied on side effects that never fired: many MRs merged, **zero** tracker issues closed, and no step verified the transition | `[internal]` — fx-eye-tracking, reported by the maintainer, 2026-07-17. Root cause on that instance not yet diagnosed; typical causes: missing `Closes #N` in the MR description, or merging to a non-default branch (GitLab auto-close fires only on default-branch merges). | Delivery is verified, not assumed: run `/verify-delivery <ticket>` after every merge — it checks the Definition of Done (plan · tests · CLEAR verdict · merged · issue closed · writeback) and repairs gaps only with explicit human OK. Never trust tracker auto-close blindly. | 2026-07-17 |
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
- Delivery is **verified, not assumed**: after every merge, `/verify-delivery <ticket>` checks the Definition of Done — plan on disk · tests green · CLEAR verdict · MR merged into the default branch · tracker issue closed · writeback done. Added 2026-07-17 after the fx-eye-tracking silent-delivery-drop observation (§4).

## 6. Scaffold

```
scaffold/
├── INSTALL.md                 # install steps + config-key verification record
├── claude-md-snippet.md       # block to append to the target repo's CLAUDE.md
└── .claude/
    ├── agents/                # role definitions with pinned model + effort
    │   ├── architect.md       # claude-sonnet-5 @ xhigh; writes the plan, no production code
    │   ├── builder.md         # claude-opus-4-8 @ xhigh; inherits all tools
    │   └── reviewer.md        # claude-fable-5 @ max; read/run-only (no Write/Edit)
    └── commands/              # human-invoked stage gates
        ├── plan-ticket.md     # /plan-ticket <ticket>    → Architect stage
        ├── build-ticket.md    # /build-ticket <ticket>   → Builder stage
        ├── review-ticket.md   # /review-ticket <ticket>  → Reviewer stage (fresh context)
        └── verify-delivery.md # /verify-delivery <ticket> → post-merge Definition-of-Done check
```

Install steps and usage modes: [scaffold/INSTALL.md](scaffold/INSTALL.md). Frontmatter keys (`model`, `effort`, `tools`, command arguments) verified against official Claude Code docs on 2026-07-17 — see the verification record in INSTALL.md.

## 7. Provenance & change log

| Date | Change | Basis | Author |
|---|---|---|---|
| 2026-07-17 | Initial entry. Roles, boundaries, and the model/effort table adopted as the team standard. | Team-finalized specification, 2026-07-17. Benchmark figures transcribed as recorded there; original source links were not captured — attach them at the first re-verification. Scaffold config keys verified against live Claude Code docs same day (record in `scaffold/INSTALL.md`). | Horace Hou (spec) / Claude Fable 5 (write-up) |
| 2026-07-17 | Added two `[internal]` failure modes observed on the fx-eye-tracking sibling harness: orchestrator role leakage, and silent delivery drop (MRs merged, issues never closed). Hardened the scaffold accordingly: orchestrator-discipline rules in the CLAUDE.md snippet, "never absorb the role" line in every stage command, new `/verify-delivery` Definition-of-Done command. Model/effort table unchanged. | Maintainer report (Horace Hou), 2026-07-17. | Horace Hou (report) / Claude Fable 5 (write-up) |
