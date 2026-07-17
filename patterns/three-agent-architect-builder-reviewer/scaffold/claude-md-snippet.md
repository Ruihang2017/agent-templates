<!-- Append this block to the target repo's CLAUDE.md.
     Source pattern: agent-templates/patterns/three-agent-architect-builder-reviewer (as of 2026-07-17). -->

## Delivery pipeline — three-agent Architect / Builder / Reviewer

Every non-trivial ticket flows through three stages; no agent judges its own work.

- **`/plan-ticket <ticket>`** — Architect (`claude-sonnet-5` @ `xhigh`) reads the ticket + codebase → implementation plan at `docs/plans/<ticket-id>.md`. Writes no production code.
- **`/build-ticket <ticket>`** — Builder (`claude-opus-4-8` @ `xhigh`) implements the plan, runs tests until green, records deviations. Never merges or self-clears.
- **`/review-ticket <ticket>`** — Reviewer (`claude-fable-5` @ `max`) in a **fresh context**, deliberately a different model tier from the Builder. Focus: edge cases, concurrency, security-sensitive paths. Verdict **CLEAR** or **BOUNCE**; merge requires CLEAR.
- **`/verify-delivery <ticket>`** — post-merge Definition-of-Done check: plan on disk · tests green · CLEAR verdict · MR merged into the default branch · **tracker issue closed** · writeback done. Run after **every** merge; tracker auto-close side effects are never trusted blindly.

Orchestrator discipline (hard rules for the main session):

- The main session **orchestrates only**: it invokes the stage commands and relays artifacts (ticket path, plan path, diff ref). It never plans, implements, or reviews a ticket inline — that work belongs to the stage subagents, whatever the size of the change.
- If a stage subagent fails or is unavailable, report the failure and stop. **Never absorb its role.**
- A ticket is done only when `/verify-delivery` passes all items — "the MR is merged" is not done (known failure: MRs merged with issues left open, observed 2026-07-17).

Rules:

- The Reviewer never runs in the Builder's session and never edits code; it receives only the ticket, the plan, and the diff ref — never transcripts.
- Maximum 2 bounce cycles, then escalate to a human.
- Trivial/mechanical changes may skip the pipeline only with an explicit human OK.
- Model/effort per role are pinned in `.claude/agents/*.md`. Change them by updating the pattern entry in agent-templates first (new as-of date + provenance entry), then syncing here — never by editing only this repo.
