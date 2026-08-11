---
name: start-all
description: Gate 1 for the complete Codex three-agent docs/prd dependency graph. Publish all tickets and run the global DAG sequentially.
---

Treat invocation as Gate 1 sign-off and issue-creation authorization. Resolve the optional supervised/autonomous mode. Reject any concurrency argument greater than 1.

1. Require `docs/PRD.md` and at least one ticket.
2. Run `node .codex/scripts/dag-scan.mjs docs/prd`; stop on cycles, duplicate ids, or dangling dependencies.
3. Ask `delivery` to publish every module with `node .codex/scripts/publish-tickets.mjs <module> --create --platform <Tracker>`.
4. Report and filter closed issues as already delivered. Escalate every drifted closed issue.
5. Read `.agents/skills/run-ticket/SKILL.md` completely. Across the one flat graph, repeatedly choose one ready open ticket and follow the loaded run-ticket procedure. Preserve cross-module `blocked_by` edges. Supervised mode stops after the first PR/MR is opened; autonomous mode continues independent branches after failures and skips dependents.
6. Re-run `dag-scan.mjs` after each settled ticket so newly added tickets join the graph. Never alter dependencies of an already-started ticket.
7. Return a complete per-ticket report plus graph reload errors and other escalations.

Sequential execution is a deliberate v1 safety boundary. Do not simulate parallelism by spawning multiple Builders in the same checkout.
