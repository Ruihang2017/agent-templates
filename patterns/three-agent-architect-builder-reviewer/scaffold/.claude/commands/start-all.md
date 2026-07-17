---
description: Whole-PRD Gate 1 — compute the module DAG, publish every module's tickets, run all modules through the pipeline in dependency order (three-agent pattern)
argument-hint: [supervised|autonomous]
---

Arguments: `$ARGUMENTS` — optional mode override (else the repo's declared Operating mode in CLAUDE.md).

Typing this command is the human Gate 1 sign-off **for the whole PRD** — every module, in dependency order. Prefer `/start-milestone` per module when you still want module-boundary checkpoints. Execute in order:

1. **Compute the plan.** Run `node .claude/scripts/milestone-dag.mjs` and show its output (module order, per-module dependencies). STOP on any error — a dangling `blocked_by` or a cycle is a spec defect for the Architect/human, not something to patch here.
2. **Publish all tickets.** For each module in DAG order: `node .claude/scripts/publish-tickets.mjs docs/prd/<module>` (dry-run, then `--create`; STOP on `error` entries). Then, per module, **filter out tickets whose issues are already closed** (closed = delivered by an earlier run — this makes `/start-all` re-runs resume: fully-closed modules pass an empty ticket list and are marked already-complete).
3. **Launch the driver.** Call the **Workflow** tool with `name: "start-all"` and `args: { modules: [{name, dependsOn, tickets}] in DAG order, mode, defaultBranch, platform }`. This command's instruction is your authorization to use the Workflow tool. Failure policy is enforced in the workflow: failed modules block their dependents; independent branches continue in `autonomous`; anything short of a CLEAR stops everything in `supervised`.
4. **Relay the final report verbatim** — per module: `completed` / `already-complete` / `paused-for-merge` (supervised: tell the human to merge, then re-run this command) / `failed` (with the failing ticket + stage) / `skipped-dependency` / `not-started`. Escalations inside a module carry through from run-milestone unchanged.

While the workflow runs you are an observer. Do not do stage work in parallel, do not "help" a slow stage, do not edit files.

Hard rule: DAG computation and publishing are script steps; module sequencing is the workflow's job. Never absorb either role by improvising order or tracker writes yourself.
