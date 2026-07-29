---
description: Gate 1 for the whole PRD — publish every module's tickets, then run them all through the pipeline scheduled from one dependency DAG
argument-hint: [supervised|autonomous] [concurrency]
---

Arguments: `$ARGUMENTS` — optional mode override (else the repo's declared Operating mode in CLAUDE.md); an optional integer sets **`concurrency`** (default 1 = sequential; >1 runs independent tickets as parallel lanes — autonomous only).

**Do not guess `concurrency`.** `node .claude/scripts/dag-report.mjs docs/prd` derives it from the ticket DAG and prints `recommended concurrency: N` (also rendered in `docs/prd/dag.html`, written at `/breakdown-prd` time). Above that number the extra lanes never fill; below it, independent tickets get serialized. If the human passed no integer, run the report and report what it recommends rather than defaulting to 1 silently.

`/start-all` schedules from **one flat DAG across every module** — it is not a sequence of `/start-milestone` runs. Two modules with no dependency between them run concurrently; only `blocked_by` gates anything (catalog issue #71).

1. **Verify the PRD is ready.** `docs/PRD.md` and at least one `docs/prd/<module>/tickets/*.md` must exist. If not, STOP and tell the human to run `/breakdown-prd` first.

2. **Compute the graph.** Run `node .claude/scripts/dag-scan.mjs docs/prd` and parse its final `SCAN-JSON` line: `{tickets: [{id, module, path, blockedBy}]}`. This is the whole PRD in one flat list, cross-module edges intact. A non-zero exit means the decomposition is broken (dangling `blocked_by`, or a cycle) — report it and STOP; never start a run on a broken DAG.

3. **Publish every module's tickets.** For each module dir under `docs/prd/`, run `node .claude/scripts/publish-tickets.mjs docs/prd/<module> --create --platform <gh|glab>` — read `platform` from the CLAUDE.md **`Tracker:`** line (adopt.mjs set it), never guess it. Collect each ticket's issue number from the `PUBLISH-SUMMARY-JSON` lines.

4. **Filter out already-delivered tickets — and say what you dropped.** Every summary entry from step 3 carries `state` (`open`/`closed`). Drop the **closed** ones: closed means an earlier run delivered it, and this filter is what makes re-runs safe after a supervised pause, a crash, or a **new phase appended to the PRD** (catalog issue #112 — a phase-2 run is just a re-run in which everything from phase 1 is already closed). Use that `state`; do not issue a second `gh`/`glab` query for it.

   **Report the dropped list** — ids and issue numbers, or a count with the ids available — even when only some were dropped. A filter that removes work silently is indistinguishable from work that ran. If every ticket is filtered out, report "already complete" and stop.

   **Any entry with `drift: true` is an escalation, not a skip.** It means the issue is closed but its body no longer matches the ticket file: either the ticket was edited after delivery — in which case the human, not the scheduler, decides whether to re-run it (edit → docs PR → `publish-tickets.mjs --sync`, then run it deliberately) — or the issue predates a body-format change and `--sync` alone fixes it. Relay these before starting the run; never let them pass as ordinary skips.

5. **Launch the scheduler.** Call the **Workflow** tool with `name: "start-all"` and `args`:

   ```
   {
     tickets: [{id, path, issue, module, blockedBy}],   // FLAT — every module, one array
     mode, concurrency, defaultBranch, platform,
     rescanEvery: 3,            // reload the DAG every N settled tickets; 0 disables
     prdRoot: 'docs/prd',
     testCmd                    // optional, if CLAUDE.md declares one
   }
   ```

   Build `tickets` by joining step 2 (`id`, `module`, `path`, `blockedBy`) with step 3 (`issue`) on `id`. **Keep `blockedBy` complete — including cross-module edges.** They gate scheduling directly now; dropping them would let a ticket start before its blocker. This command's instruction is your authorization to use the Workflow tool.

   Failure policy is enforced in the workflow: a failed ticket cascades to its dependents (skipped); independent branches continue in `autonomous`; anything short of a CLEAR stops the run in `supervised`.

6. **The DAG stays live during the run.** Every `rescanEvery` settled tickets — and always once more before the run finishes — the workflow re-reads `docs/prd` through an agent, so **a ticket added while the run is in flight is published, scheduled, executed, and re-rendered into `docs/prd/dag.html`**. Adding one is just writing the ticket file (via `/breakdown-prd` or the architect; the write guard blocks the main session from writing it directly). Pass `rescanEvery: 0` for a frozen graph.

7. **Relay the final report verbatim** — per ticket: `delivered` / `escalated` (with stage + findings) / `failed` (with stage) / `skipped-dependency` / `awaiting-human-merge` (supervised: tell the human to merge, then re-run this command) / `not-started`. Add step 4's two lists to the same report: the tickets **skipped as already delivered**, and any **drifted** ones. A run that executed 3 of 15 tickets and does not say why the other 12 were not attempted is not a report. **Always relay `escalations` too** — that array carries the things the scheduler could not enforce and a human must judge: a dependency added to a ticket that had already started, a cycle introduced mid-run, a failed DAG reload, or a hit runaway guard. Do not summarize those away.
