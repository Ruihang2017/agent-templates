---
name: start-milestone
description: Gate 1 for one Codex three-agent module. Publish its tickets, then run ready tickets sequentially through Architect, Builder, Reviewer, and delivery.
---

Treat invocation as Gate 1 sign-off and authorization to create issues. Resolve the module and optional mode override. Reject any requested concurrency greater than 1; this Codex-native pattern does not provide worktree isolation for parallel Builders.

Validate the module README and all tickets. Ask `delivery` to run `.codex/scripts/publish-tickets.mjs` first as a dry run, then with `--create --platform <Tracker>`. Stop on errors or drift.

**Do not choose the next ticket by reading `blocked_by` yourself.** Run
`node .codex/scripts/wave-plan.mjs docs/prd --module <name> --delivered <ids> --failed <ids>`
and take its `WAVE-PLAN-JSON` `ready` list (catalog issue #206). Which tickets may run now is
control flow, and control flow this catalog left in prose has been got wrong before; the script
also reports `unreachable` tickets and exits non-zero on a cycle, a dangling dependency, or a
module name that matches nothing — so a run that executed zero tickets can never read as complete.
Seed `--delivered` with the ids whose issues the publish step reported as closed.

Read `.agents/skills/run-ticket/SKILL.md` completely before starting a ticket. Take one ready ticket at a time and follow the loaded run-ticket procedure exactly. In supervised mode, stop after the first CLEAR opens a PR/MR and report `awaiting-human-merge`; a later invocation resumes because closed issues are filtered out. In autonomous mode, continue independent ready tickets after a failure, but skip their transitive dependents.

Re-run `wave-plan.mjs` after each settled ticket, so a ticket added mid-run joins the graph and a newly unblocked one becomes available. Finish with every ticket classified as delivered, awaiting-human-merge, escalated, failed, refused, unreachable (naming the blocker that did not deliver), already-delivered, drift, or not-started. Never omit filtered tickets, and relay every `notes` entry the planner printed.
