<!-- Append this block to the target repo's CLAUDE.md.
     Source pattern: agent-templates/patterns/three-agent-architect-builder-reviewer (as of 2026-07-17). -->

## Delivery pipeline — three-agent Architect / Builder / Reviewer

**Operating mode: `supervised`** <!-- switch to `autonomous` once the pattern holds on this repo -->

- `supervised` — a human confirms each merge and each tracker close; issue **creation** is authorized by the `/start-milestone` sign-off itself. The milestone runner stops after each CLEAR verdict for the human merge — re-run `/start-milestone` to continue (closed issues are skipped). Use for a fresh adoption.
- `autonomous` (target) — humans decide at exactly two gates: Gate 1, sign-off of master PRD → sub-PRDs → tickets before the pipeline starts; Gate 2, a smoke test of the delivered milestone. Between them the pipeline self-drives: merge on CLEAR, `/verify-delivery` repairs gaps (including closing the issue) automatically. A human is pulled in only on the exception path — 2 bounce cycles without convergence, a failed build, or an unrepairable verify-delivery item.

Every non-trivial ticket flows through three stages; no agent judges its own work.

- **`/plan-ticket <ticket>`** — Architect (`claude-sonnet-5` @ `xhigh`) reads the ticket + codebase → implementation plan at `docs/plans/<ticket-id>.md`. Writes no production code.
- **`/build-ticket <ticket>`** — Builder (`claude-opus-4-8` @ `xhigh`) implements the plan, runs tests until green, records deviations. Never merges or self-clears.
- **`/review-ticket <ticket>`** — Reviewer (`claude-fable-5` @ `max`) in a **fresh context**, deliberately a different model tier from the Builder. Focus: edge cases, concurrency, security-sensitive paths. Verdict **CLEAR** or **BOUNCE**; merge requires CLEAR.
- **`/verify-delivery <ticket>`** — post-merge Definition-of-Done check: plan on disk · tests green · CLEAR verdict · MR merged into the default branch · **tracker issue closed** · writeback done. Run after **every** merge; tracker auto-close side effects are never trusted blindly.
- **`/start-milestone <module> [mode]`** — the Gate 1 start signal: verify sub-PRD + tickets, publish tickets as tracker issues (deterministic idempotent script — agents never hand-create issues), then run every ticket through the deterministic `run-milestone` workflow (stage order, bounce cap, merge policy enforced in code).
- **`/nightly-issues [max]`** — unattended sweep (OS-scheduled, `claude -p`): triage open issues → auto-fix fixable ones through the pipeline → per-issue comments + labels + a `Nightly report <date>` issue for the morning read. Invalid issues are labeled `triage:invalid`, never auto-closed. Setup: scaffold INSTALL.md § Nightly sweep.

Orchestrator discipline (hard rules for the main session):

- The main session **orchestrates only**: it invokes the stage commands and relays artifacts (ticket path, plan path, diff ref). It never plans, implements, or reviews a ticket inline — that work belongs to the stage subagents, whatever the size of the change.
- If a stage subagent fails or is unavailable, report the failure and stop. **Never absorb its role.**
- This is **mechanically enforced**: a PreToolUse guard (`.claude/hooks/guard-main-session-writes.mjs`) denies Edit/Write in the main session; subagent calls pass. For a human-approved out-of-pipeline edit, create `.claude/allow-main-writes` (git-ignored) and delete it afterwards.
- Known guard boundary: Bash is not covered. Bash in the main session is for orchestration only (git, tracker CLI, running commands) — never for writing files (`echo >`, `git apply`, heredocs). The guard stops reflexive edits, not determined bypasses; this rule covers the rest.
- A ticket is done only when `/verify-delivery` passes all items — "the MR is merged" is not done (known failure: MRs merged with issues left open, observed 2026-07-17).

Rules:

- The Reviewer never runs in the Builder's session and never edits code; it receives only the ticket, the plan, and the diff ref — never transcripts.
- Maximum 2 bounce cycles, then escalate to a human.
- Trivial/mechanical changes may skip the pipeline only with an explicit human OK.
- Ticket files are the issue-content source of truth. Issues are created only by `.claude/scripts/publish-tickets.mjs` (`[<id>]` title prefix = dedupe key); to change an issue body, edit the ticket file and republish. Issue state (close) moves via the deliver step / `/verify-delivery`, never by hand mid-pipeline.
- Agents own the whole test pyramid: the Builder writes and runs unit + integration tests (and E2E where the ticket's acceptance calls for it); the Reviewer re-runs the full suite independently; the deliver step re-runs it on the merged default branch. The human tests exactly once — the Gate 2 smoke test after the PRD's tasks are all done.
- Model/effort per role are pinned in `.claude/agents/*.md`. Change them by updating the pattern entry in agent-templates first (new as-of date + provenance entry), then syncing here — never by editing only this repo.
