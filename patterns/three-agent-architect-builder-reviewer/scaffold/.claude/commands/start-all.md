---
description: Gate 1 for the whole PRD — publish every module's tickets, then drive the wave loop until the PRD is done
argument-hint: [supervised|autonomous] [concurrency] [none]
---

Arguments: `$ARGUMENTS` — optional mode override (else the repo's declared Operating mode in CLAUDE.md); an optional integer sets **`concurrency`** (default 1 = sequential; >1 runs independent tickets as parallel lanes — autonomous only).

**`none` = local delivery (issue #180).** If the arguments contain the bare word `none`, pass `--platform none` to `deliver-wave.mjs`. Every ticket then merges to the **local** default branch and nothing touches a forge — no push, no PR/MR, no tracker — so a pipeline gate, a protected branch, an expired token or a 403 MR API cannot stop the run. Review is unchanged: a ticket still only merges on CLEAR; what is deferred is publication. In this mode you must **not** publish tickets (step 3 is skipped entirely), and the resume signal is the committed ledger at `docs/delivered.json` instead of closed issues.

**Do not guess `concurrency`.** `node .claude/scripts/dag-report.mjs docs/prd` derives it from the ticket DAG and prints `recommended concurrency: N`. Above that number the extra lanes never fill; below it, independent tickets get serialized. If the human passed no integer, run the report and report what it recommends rather than defaulting to 1 silently.

## How this runs

**You are the orchestrator, and delivery is yours** (catalog issue #206). The pipeline no longer merges anything: a workflow run plans, implements and reviews, then hands the cleared tickets back to you. That is not a style choice — a workflow script has no filesystem and no exec, so nothing inside one can run the delivery script except an agent, and that agent had no judgement to make. It is gone.

The consequence shapes the loop: because nothing merges inside a run, **a ticket and its blocker can never share one**. Work proceeds in **waves** — a set of tickets whose blockers are all already delivered:

```
wave-plan.mjs  ->  Workflow(run-wave)  ->  compose bodies  ->  deliver-wave.mjs  ->  repeat
   which             plan / build /          your only          merge, close,
 tickets now           review               writing job          clean up
```

Wave boundaries are a real cost, stated plainly: a fast ticket waits for the slowest ticket in its wave before its dependents start. `dag-report.mjs` already modelled the run this way ("actual wall-clock is at most this many rounds"), so its wave counts stop being an upper bound and become exact.

## Steps

1. **Verify the PRD is ready.** `docs/PRD.md` and at least one `docs/prd/<module>/tickets/*.md` must exist. If not, STOP and tell the human to run `/breakdown-prd` first.

2. **Check the graph is sound.** `node .claude/scripts/dag-scan.mjs docs/prd`. A non-zero exit means the decomposition is broken (dangling `blocked_by`, duplicate id, or a cycle) — report it and STOP. Never start a run on a broken DAG.

3. **Publish every module's tickets.** For each module dir under `docs/prd/`, run `node .claude/scripts/publish-tickets.mjs docs/prd/<module> --create --platform <gh|glab>` — read `platform` from the CLAUDE.md **`Tracker:`** line (adopt.mjs set it), never guess it. Collect each ticket's issue number and `state` from the `PUBLISH-SUMMARY-JSON` lines. **Skip this step entirely in `none` mode.**

3b. **Mirror to Asana, if this repo is connected.** Skip entirely when `.claude/asana.json` is absent — no output, no calls. Otherwise, for each module dir, save step 3's stdout for that module and run `node .claude/scripts/asana-sync.mjs sync docs/prd/<module> --create --issues <that file>`. It is idempotent. Read each `ASANA-SYNC-JSON` line, collect all `errors`, **relay them verbatim in the final report**, and carry on. **Never stop the run for an Asana failure** — Asana is a reporting mirror, not a gate.

4. **Note what is already delivered — and say so.** Every summary entry from step 3 carries `state` (`open`/`closed`). The **closed** ones were delivered by an earlier run; you pass their ids to `wave-plan.mjs` and it excludes them. This is what makes a re-run safe after a supervised pause, a crash, or a **new phase appended to the PRD** (a phase-2 run is just a re-run in which everything from phase 1 is already closed).

   **Report the dropped list** — ids and issue numbers, or a count with the ids available. A filter that removes work silently is indistinguishable from work that ran. If everything is already closed, report "already complete" and stop.

   **Any entry with `drift: true` is an escalation, not a skip.** The issue is closed but its body no longer matches the ticket file: either the ticket was edited after delivery — the human, not the scheduler, decides whether to re-run it — or the issue predates a body-format change and `publish-tickets.mjs --sync` alone fixes it. Relay these before starting.

5. **THE WAVE LOOP.** Repeat until `done` or a stop condition below. Keep two running lists across iterations: `delivered` (ids that landed) and `failed` (ids that escalated, failed, or were refused).

   5a. **Plan the wave.**

   ```
   node .claude/scripts/wave-plan.mjs docs/prd \
     --delivered <comma-separated ids> --failed <comma-separated ids>
   ```

   Parse the final `WAVE-PLAN-JSON` line. A **non-zero exit** means a broken or cyclic graph — STOP and report it; do not fall back to running a partial wave. If `done` is `true`, leave the loop. If `ready` is empty but `done` is `false`, that is not completion — report `blocked`, `unreachable` and `cycle` and STOP; a loop that exits quietly here reports a complete run over unstarted work.

   5b. **Run the wave.** Call the **Workflow** tool with `name: "run-wave"` and `args`:

   ```
   {
     tickets: [{id, path, issue, module, blockedBy}],   // exactly WAVE-PLAN-JSON's `ready`
     defaultBranch, concurrency, maxBounces: 2,
     waveNumber: <1-based counter>
   }
   ```

   Join in each ticket's `issue` number from step 3 by `id`. This command's instruction is your authorization to use the Workflow tool. Pass the wave through **unchanged** — the workflow refuses a wave containing an edge between two of its own tickets, and that refusal is a guard you want, not an obstacle to route around.

   Each result comes back as `reviewed-clear`, `escalated`, or `failed`. **`reviewed-clear` means nothing has been delivered yet.** Add every non-`reviewed-clear` id to `failed`.

   5c. **Compose one PR/MR body per cleared ticket** into `.claude/tmp/<id>-body.md`. This is your only writing job in the loop, and `.claude/tmp/` is carved out of the write guard for it — no override file needed. Follow `/deliver-ticket` step 2 for what fills each section: every section maps to a returned artifact (`buildSummary`, `deviations`, `testOutput`, `bounces`, the ticket's own Acceptance rows, the Reviewer's record file). **A fact not present in an artifact is written as unavailable with its reason — never inferred.** Skip this step for a repo with no PR/MR template.

   Do **not** write `.claude/tmp/<id>-verdict.md`. The Reviewer wrote it. If `recordWritten` is false or the file is empty, do not substitute for it — `deliver-wave.mjs` will refuse that ticket, which is correct.

   5d. **Deliver the wave.** Write the workflow's return value to `.claude/tmp/wave-<n>.json`, adding `bodyFile` to each cleared row, then:

   ```
   node .claude/scripts/deliver-wave.mjs --wave .claude/tmp/wave-<n>.json \
     --default-branch <default> --platform <gh|glab|none> \
     [--test-cmd "<command>"] [--integration-branch <name>] [--no-merge]
   ```

   `--no-merge` in **supervised** mode. `--integration-branch` only in autonomous mode and only if CLAUDE.md declares an **`Integration branch:`** line — a merge the **protected** default branch refuses then lands there instead of stalling the run. Never used for an unmet gate; work delivered there **does not pass the Definition of Done**.

   Parse `WAVE-DELIVER-JSON`. Add its landed ids to `delivered`; add every `refused` id and every ticket whose outcome was not `delivered` to `failed`. **Relay its `escalations` array** — that is where a branch it could not delete, a summary it could not parse, or a missing Reviewer record is recorded.

   5e. **Stop conditions.** In **supervised** mode, stop after this wave and tell the human which PRs to merge and to re-run this command afterwards — the next wave builds from the default branch, so an unmerged PR means the next wave would build without it. In autonomous mode, continue; a ticket that failed only blocks its own dependents, which the next `wave-plan.mjs` call reports as `unreachable`.

   The loop also stops if a wave delivers **nothing at all** while its plan listed ready tickets — that is a delivery boundary problem (auth, protection, forge), and re-running the same wave will reproduce it.

6. **Hand off the integration branch, if one was used.** If any ticket reported `outcome: "delivered-to-integration"`, run once: `node .claude/scripts/deliver-ticket.mjs --open-integration-mr --integration-branch <name> --default-branch <default> --platform <gh|glab>`. It **opens** the MR and never merges it — landing accumulated work on a protected branch is a human decision. Relay its `INTEGRATION-MR-JSON` line.

7. **Refresh the visualization.** `node .claude/scripts/dag-report.mjs docs/prd` so `docs/prd/dag.html` shows the graph as it now stands.

8. **Relay the final report verbatim.** Per ticket: `delivered` / **`delivered-to-integration`** (landed on the integration branch, **NOT** the default branch — these tickets are **not** done; name the handoff MR) / `escalated` (with stage + findings) / `failed` (with stage) / `refused` (with the reason `deliver-wave.mjs` gave) / `unreachable` (with the blocker that did not deliver) / `awaiting-human-merge`. Add step 4's two lists: tickets **skipped as already delivered**, and any **drifted** ones.

   A run that executed 3 of 15 tickets and does not say why the other 12 were not attempted is not a report. **Always relay every `escalations` entry** from both scripts. If this repo is connected to Asana, add a one-line mirror status — say "Asana: in sync" or say what broke. In `none` mode, relay the `localHandoff` verbatim: it names what landed and the exact command to publish. A run that quietly accumulates work on one machine and says nothing is indistinguishable from work nobody can see.

## The DAG stays live

`wave-plan.mjs` re-reads `docs/prd` **every wave**, so a ticket added while the run is in flight is picked up by the next wave with no special machinery — it is simply in the graph the next time the graph is read. Publish any newly-added ticket (step 3, that module only) before the wave that runs it, so delivery has an issue to close. Adding a ticket means writing the ticket file via `/breakdown-prd` or the architect; the write guard blocks the main session from writing it directly.
