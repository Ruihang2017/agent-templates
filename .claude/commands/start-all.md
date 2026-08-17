---
description: Gate 1 for the whole PRD — publish every module's tickets, then run them all through the pipeline scheduled from one dependency DAG
argument-hint: [supervised|autonomous] [concurrency] [none]
---

Arguments: `$ARGUMENTS` — optional mode override (else the repo's declared Operating mode in CLAUDE.md); an optional integer sets **`concurrency`** (default 1 = sequential; >1 runs independent tickets as parallel lanes — autonomous only).

**`none` = local delivery (issue #180).** If the arguments contain the bare word `none`, pass `platform: 'none'` to the workflow. Every ticket then merges to the **local** default branch and nothing touches a forge — no push, no PR/MR, no tracker — so a pipeline gate, a protected branch, an expired token or a 403 MR API cannot stop the run. Review is unchanged: a ticket still only merges on CLEAR; what is deferred is publication.

In this mode you must **not** publish tickets (step 3 is skipped entirely), and the resume signal is the committed ledger at `docs/delivered.json` instead of closed issues. Relay the run's `localHandoff` verbatim at the end — it names what landed and the exact command to publish. A run that quietly accumulates work on one machine and says nothing is indistinguishable from work nobody can see.

**Do not guess `concurrency`.** `node .claude/scripts/dag-report.mjs docs/prd` derives it from the ticket DAG and prints `recommended concurrency: N` (also rendered in `docs/prd/dag.html`, written at `/breakdown-prd` time). Above that number the extra lanes never fill; below it, independent tickets get serialized. If the human passed no integer, run the report and report what it recommends rather than defaulting to 1 silently.

`/start-all` schedules from **one flat DAG across every module** — it is not a sequence of `/start-milestone` runs. Two modules with no dependency between them run concurrently; only `blocked_by` gates anything (catalog issue #71).

1. **Verify the PRD is ready.** `docs/PRD.md` and at least one `docs/prd/<module>/tickets/*.md` must exist. If not, STOP and tell the human to run `/breakdown-prd` first.

2. **Compute the graph.** Run `node .claude/scripts/dag-scan.mjs docs/prd` and parse its final `SCAN-JSON` line: `{tickets: [{id, module, path, blockedBy}]}`. This is the whole PRD in one flat list, cross-module edges intact. A non-zero exit means the decomposition is broken (dangling `blocked_by`, or a cycle) — report it and STOP; never start a run on a broken DAG.

3. **Publish every module's tickets.** For each module dir under `docs/prd/`, run `node .claude/scripts/publish-tickets.mjs docs/prd/<module> --create --platform <gh|glab>` — read `platform` from the CLAUDE.md **`Tracker:`** line (adopt.mjs set it), never guess it. Collect each ticket's issue number from the `PUBLISH-SUMMARY-JSON` lines.

3b. **Mirror to Asana, if this repo is connected.** Skip entirely when `.claude/asana.json` is absent — no output, no calls. Otherwise, for each module dir, save step 3's stdout for that module and run `node .claude/scripts/asana-sync.mjs sync docs/prd/<module> --create --issues <that file>` so subtask names carry the `#<issue>` numbers. It is idempotent, so modules already mirrored by an earlier run (including every module of a previous phase) cost one list call and create nothing. Read each `ASANA-SYNC-JSON` line: collect all `errors` and **relay them verbatim in step 7**, then carry on. **Never stop the run for an Asana failure** — Asana is a reporting mirror, not a gate, and the script exits 0 on every Asana problem by design.

4. **Filter out already-delivered tickets — and say what you dropped.** Every summary entry from step 3 carries `state` (`open`/`closed`). Drop the **closed** ones: closed means an earlier run delivered it, and this filter is what makes re-runs safe after a supervised pause, a crash, or a **new phase appended to the PRD** (catalog issue #112 — a phase-2 run is just a re-run in which everything from phase 1 is already closed). Use that `state`; do not issue a second `gh`/`glab` query for it.

   **Report the dropped list** — ids and issue numbers, or a count with the ids available — even when only some were dropped. A filter that removes work silently is indistinguishable from work that ran. If every ticket is filtered out, report "already complete" and stop.

   **Any entry with `drift: true` is an escalation, not a skip.** It means the issue is closed but its body no longer matches the ticket file: either the ticket was edited after delivery — in which case the human, not the scheduler, decides whether to re-run it (edit → docs PR → `publish-tickets.mjs --sync`, then run it deliberately) — or the issue predates a body-format change and `--sync` alone fixes it. Relay these before starting the run; never let them pass as ordinary skips.

5. **Launch the scheduler.** Pass **`integrationBranch`** as well if CLAUDE.md declares an **`Integration branch:`** line: in autonomous mode a merge the **protected** default branch refuses then lands there instead of stalling every ticket. Never used for an unmet gate — a failing pipeline or missing approval still escalates — and work delivered there **does not pass the Definition of Done**. Call the **Workflow** tool with `name: "start-all"` and `args`:

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

6b. **Hand off the integration branch, if one was used.** If any ticket reports `outcome: "delivered-to-integration"`, run once: `node .claude/scripts/deliver-ticket.mjs --open-integration-mr --integration-branch <name> --default-branch <default> --platform <gh|glab>`. It **opens** the MR and never merges it — landing accumulated work on a protected branch is a human decision. Relay its `INTEGRATION-MR-JSON` line.

7. **Relay the final report verbatim** — per ticket: `delivered` / **`delivered-to-integration`** (landed on the integration branch, **NOT** the default branch — these tickets are **not** done; name the handoff MR) / `escalated` (with stage + findings) / `failed` (with stage) / `skipped-dependency` / `awaiting-human-merge` (supervised: tell the human to merge, then re-run this command) / `not-started`. Add step 4's two lists to the same report: the tickets **skipped as already delivered**, and any **drifted** ones. A run that executed 3 of 15 tickets and does not say why the other 12 were not attempted is not a report. **Always relay `escalations` too** — that array carries the things the scheduler could not enforce and a human must judge: a dependency added to a ticket that had already started, a cycle introduced mid-run, a failed DAG reload, or a hit runaway guard. Do not summarize those away. If this repo is connected to Asana, add a one-line mirror status: step 3b's `errors` and any `Asana mirror:` notes carried in the per-ticket deliver summaries. A silently stale mirror is the failure this reporting exists to prevent — say "Asana: in sync" or say what broke.
