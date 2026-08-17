---
name: start-all
description: Gate 1 for the complete Codex three-agent docs/prd dependency graph. Publish all tickets and run the global DAG sequentially.
---

Treat invocation as Gate 1 sign-off and issue-creation authorization. Resolve the optional supervised/autonomous mode. Reject any concurrency argument greater than 1.

**State what you are about to upload, and where, before you upload it** (catalog issue #190). Generic "issue-creation authorization" is not consent an approval system can act on, and a system that requires destination- and payload-specific consent will stop the first supervised run. Before step 3, print and let the operator confirm:

- **Destination** — the resolved tracker repository, and the platform from `AGENTS.md`'s **Tracker** line.
- **Payload** — for each ticket: the issue **title** (`[<id>] <title>`), the **Markdown ticket body** read verbatim from `docs/prd/<module>/tickets/<file>.md`, and **dependency metadata** (`blocked_by` / `blocks` rendered as issue references). Nothing else from the repository leaves it.
- **Count** — how many issues will be created, and in which modules.

In `none` mode there is nothing to state: that mode is forge-free, uploads nothing, and must not ask for upload consent at all.

**`none` = local delivery.** If the arguments contain the bare word `none`, this run touches **no forge**: skip step 3 entirely (publish nothing), pass `--delivery local` instead of `--platform <Tracker>` to `deliver-ticket.mjs`, and pass no `--issue`. Every ticket then merges to the local default branch — no push, no PR/MR, no tracker — so a pipeline gate, a protected branch, an expired token or a 403 MR API cannot stop the run.

Review is unchanged in this mode: a ticket still only merges on CLEAR. What is deferred is **publication**, not judgement.

In `none` mode the resume signal is the committed ledger at `docs/delivered.json`, not closed issues. In step 4 and on every re-scan, read it and treat any ticket id present in its `delivered` array as already delivered; every other ticket is open. If the file is missing, nothing has been delivered yet. If you cannot read it, say so rather than reporting every ticket as open — re-admitting a delivered ticket re-plans and re-builds it against a codebase that already contains its work.

Finish the run by stating plainly that nothing was pushed and no PR/MR was opened, and give the exact command to publish (`git push origin <default branch>`). A run that accumulates work locally and says nothing is indistinguishable from work nobody can see.

1. Require `docs/PRD.md` and at least one ticket.
2. Run `node .codex/scripts/dag-scan.mjs docs/prd`; stop on cycles, duplicate ids, or dangling dependencies.
3. Ask `delivery` to publish every module with `node .codex/scripts/publish-tickets.mjs <module> --create --platform <Tracker>`.
4. Report and filter closed issues as already delivered. Escalate every drifted closed issue.
5. **Choose the next ticket with the planner, not by reading `blocked_by` yourself** (catalog issue #206):
   `node .codex/scripts/wave-plan.mjs docs/prd --delivered <ids> --failed <ids>` — take its `WAVE-PLAN-JSON` `ready` list, seeded from step 4's closed issues. Which tickets may run now is control flow, and control flow this catalog left in prose has been got wrong before. A non-zero exit (cycle, dangling dependency) stops the run; `ready` empty with `done: false` is NOT completion — report `blocked`, `unreachable` and `cycle` and stop.
   Then read `.agents/skills/run-ticket/SKILL.md` completely and take one ready ticket at a time through the loaded procedure. Cross-module edges gate directly — the planner already accounts for them. Supervised mode stops after the first PR/MR is opened; autonomous mode continues independent branches after failures, and the planner reports their dependents as `unreachable` rather than silently dropping them.
6. Re-run `wave-plan.mjs` after each settled ticket so newly added tickets join the graph and newly unblocked ones become available. Never alter dependencies of an already-started ticket.
7. Return a complete per-ticket report — delivered · delivered-to-integration · awaiting-human-merge · escalated · failed · refused · unreachable (naming the blocker) · already-delivered · drift · not-started — plus every planner `note`, graph reload error, and other escalation. A run that executed 3 of 15 tickets and does not say why the other 12 were not attempted is not a report.

Sequential execution is a deliberate v1 safety boundary. Do not simulate parallelism by spawning multiple Builders in the same checkout.
