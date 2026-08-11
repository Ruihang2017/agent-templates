<!-- Source pattern: agent-templates/patterns/codex-three-agent-architect-builder-reviewer (as of 2026-08-11). -->

## Delivery pipeline — Codex Architect / Builder / Reviewer

**Operating mode: `supervised`**
**Tracker: `gh`**
**Integration branch: `(none)`**

Every non-trivial ticket uses three independent stages. The primary Codex thread orchestrates only; it never plans, implements, reviews, or delivers inline.

- `$breakdown-prd [prd-path] [notes]` — Architect decomposes the PRD and renders docs/prd/dag.html, then stops at Gate 1.
- `$plan-ticket <ticket>` — a fresh Architect writes docs/plans/<ticket-id>.md.
- `$build-ticket <ticket>` — a Builder implements the existing plan and tests it.
- `$review-ticket <ticket> [diff-ref]` — a fresh, read-only Reviewer returns CLEAR or BOUNCE.
- `$run-ticket <ticket>` — runs a previously published ticket through plan -> build -> fresh review, with at most two bounce repairs, then invokes deterministic delivery.
- `$publish-tickets <module|--all>` — creates tracker issues only and stops.
- `$start-milestone <module> [mode]` — Gate 1 for one module; publishes and runs ready tickets in dependency order.
- `$start-all [mode]` — Gate 1 for the whole docs/prd DAG. Codex-native v1 is deliberately sequential; it rejects concurrency greater than 1.
- `$verify-delivery <ticket>` — verifies the post-merge Definition of Done rather than trusting side effects.

Hard boundaries:

- Spawn the named project agent from `.codex/agents/` for every stage. If it cannot start, stop; never absorb its role.
- Pass artifacts between stages: ticket path, plan path, branch/commit/diff, and Reviewer findings. Never pass the Builder transcript or self-assessment to the Reviewer.
- Architect and Builder may write only within their declared role. Reviewer is read-only. Delivery is performed only by the `delivery` agent invoking `.codex/scripts/deliver-ticket.mjs`.
- A CLEAR verdict is required before delivery. On BOUNCE, send numbered findings back to the same Builder thread. After two bounce cycles without CLEAR, escalate to the human.
- The ticket is the source of truth for WHAT; the plan describes HOW. Spec changes go through the ticket and are republished before implementation resumes.
- Agents own unit, integration, and E2E tests. The human owns only Gate 1 sign-off and the final smoke test, plus exception decisions.
- `supervised`: CLEAR opens a PR/MR and stops for human merge. `autonomous`: deterministic delivery may merge after CLEAR. Branch protection and unmet checks are never bypassed.
- Do not run parallel Builders in one working tree. This pattern rejects `concurrency > 1`; use an explicitly worktree-isolated pattern when parallel implementation is required.

The project config keeps the primary thread read-only by default. A live permission override selected by the user can supersede that default; the orchestration boundary remains mandatory even then.
<!-- upstream-escalation:start -->
- **Pattern-level problems go upstream, not here.** File them with `gh issue create --repo Ruihang2017/agent-templates`; project bugs stay in this repository.
<!-- upstream-escalation:end -->
