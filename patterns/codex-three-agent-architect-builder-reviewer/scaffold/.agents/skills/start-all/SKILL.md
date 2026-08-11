---
name: start-all
description: Gate 1 for the complete Codex three-agent docs/prd dependency graph. Publish all tickets and run the global DAG sequentially.
---

Treat invocation as Gate 1 sign-off and issue-creation authorization. Resolve the optional supervised/autonomous mode. Reject any concurrency argument greater than 1.

**`none` = local delivery.** If the arguments contain the bare word `none`, this run touches **no forge**: skip step 3 entirely (publish nothing), pass `--delivery local` instead of `--platform <Tracker>` to `deliver-ticket.mjs`, and pass no `--issue`. Every ticket then merges to the local default branch — no push, no PR/MR, no tracker — so a pipeline gate, a protected branch, an expired token or a 403 MR API cannot stop the run.

Review is unchanged in this mode: a ticket still only merges on CLEAR. What is deferred is **publication**, not judgement.

In `none` mode the resume signal is the committed ledger at `docs/delivered.json`, not closed issues. In step 4 and on every re-scan, read it and treat any ticket id present in its `delivered` array as already delivered; every other ticket is open. If the file is missing, nothing has been delivered yet. If you cannot read it, say so rather than reporting every ticket as open — re-admitting a delivered ticket re-plans and re-builds it against a codebase that already contains its work.

Finish the run by stating plainly that nothing was pushed and no PR/MR was opened, and give the exact command to publish (`git push origin <default branch>`). A run that accumulates work locally and says nothing is indistinguishable from work nobody can see.

1. Require `docs/PRD.md` and at least one ticket.
2. Run `node .codex/scripts/dag-scan.mjs docs/prd`; stop on cycles, duplicate ids, or dangling dependencies.
3. Ask `delivery` to publish every module with `node .codex/scripts/publish-tickets.mjs <module> --create --platform <Tracker>`.
4. Report and filter closed issues as already delivered. Escalate every drifted closed issue.
5. Read `.agents/skills/run-ticket/SKILL.md` completely. Across the one flat graph, repeatedly choose one ready open ticket and follow the loaded run-ticket procedure. Preserve cross-module `blocked_by` edges. Supervised mode stops after the first PR/MR is opened; autonomous mode continues independent branches after failures and skips dependents.
6. Re-run `dag-scan.mjs` after each settled ticket so newly added tickets join the graph. Never alter dependencies of an already-started ticket.
7. Return a complete per-ticket report plus graph reload errors and other escalations.

Sequential execution is a deliberate v1 safety boundary. Do not simulate parallelism by spawning multiple Builders in the same checkout.
