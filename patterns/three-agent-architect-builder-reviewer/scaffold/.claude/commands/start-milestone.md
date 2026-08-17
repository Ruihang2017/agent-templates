---
description: Gate 1 start signal — publish one module's tickets as tracker issues, then drive the wave loop for that module
argument-hint: <module dir, e.g. docs/prd/01-foo> [supervised|autonomous] [concurrency]
---

Arguments: `$ARGUMENTS` — the first is the module directory (MODULE below); an optional `supervised|autonomous` overrides the repo's declared Operating mode (CLAUDE.md); an optional integer sets **`concurrency`** (default 1 = sequential; >1 runs independent tickets as parallel lanes — autonomous only).

Typing this command **is** the human Gate 1 sign-off: the sub-PRD and tickets are final, and tracker issue **creation** is authorized by this sign-off.

This is `/start-all` scoped to one module. It runs the same wave loop, with `--module <name>` on the wave planner — so a blocker living in **another** module still gates this module's tickets, it just never joins the wave. (The old runner approximated this with a module barrier and could start a ticket whose cross-module blocker had not landed.)

**Delivery is yours, in this session** (catalog issue #206). The pipeline plans, implements and reviews; nothing inside a workflow run merges anything. See `/start-all` for why, and `/deliver-ticket` for the delivery procedure in full.

1. **Verify Gate 1 inputs.** `MODULE/README.md` (the sub-PRD) exists and `MODULE/tickets/*.md` is non-empty; every ticket has the required frontmatter (see `templates/ticket.template.md`). Anything missing → STOP and list exactly what is missing. Do not fix it yourself — that is Architect-stage work.

2. **Publish tickets as tracker issues.** Run `node .claude/scripts/publish-tickets.mjs MODULE` (dry-run) and show the mapping. If the summary contains `error` entries → STOP and report them. Otherwise re-run with `--create` (idempotent — the `[<id>]` title prefix dedupes), and again STOP on any `error` entries. Collect each ticket's issue number and `state`.

2b. **Mirror to Asana, if this repo is connected.** Skip this step entirely when `.claude/asana.json` does not exist — most repos are not connected and must see no extra output. When it does exist, save step 2's `--create` stdout to a file and run `node .claude/scripts/asana-sync.mjs sync MODULE --create --issues <that file>` so subtask names carry the `#<issue>` numbers. Read the `ASANA-SYNC-JSON` line: report what was created, and if `errors` is non-empty **relay every entry verbatim in your final report** and carry on. **Never stop the run for an Asana failure** — Asana is a reporting mirror, not a gate, and the script exits 0 on every Asana problem by design.

3. **THE WAVE LOOP.** Identical to `/start-all` step 5, with `--module <the module's directory name>` added to every `wave-plan.mjs` call. Keep running lists of `delivered` and `failed` ids across iterations.

   ```
   node .claude/scripts/wave-plan.mjs docs/prd --module <name> \
     --delivered <ids> --failed <ids>
   ```

   Seed `--delivered` with the ids whose issues step 2 reported as **closed** — an earlier run delivered them, and re-admitting one re-plans and re-builds it against a codebase that already contains its work. Report what you dropped.

   A **non-zero exit** from the planner is a stop, not a smaller wave: a module name that matches nothing exits 1 rather than reporting "nothing left to run", because a run that executed zero tickets must never read as complete.

   Then per wave: `Workflow(name: "run-wave", args: {tickets: <the planner's ready list>, defaultBranch, concurrency, maxBounces: 2, waveNumber})` → compose one `.claude/tmp/<id>-body.md` per cleared ticket (see `/deliver-ticket` step 2; never write the `-verdict.md` file, the Reviewer wrote it) → write the workflow's return value plus each `bodyFile` to `.claude/tmp/wave-<n>.json` → `node .claude/scripts/deliver-wave.mjs --wave .claude/tmp/wave-<n>.json --default-branch <default> --platform <gh|glab|none> [--test-cmd "..."] [--integration-branch <name>] [--no-merge]`.

   Read `platform` from the CLAUDE.md **`Tracker:`** line (adopt.mjs set it from the origin remote), never guess it. Add `--test-cmd` if CLAUDE.md declares a test command, so the Definition-of-Done check re-runs the tests on the merged default branch. Read `--integration-branch` from the CLAUDE.md **`Integration branch:`** line if it declares one, else omit it.

   In **supervised** mode, stop after the first wave: tell the human which PRs to merge, then to re-run this command. The next wave builds from the default branch, so an unmerged PR means the next wave would build without it.

3b. **Hand off the integration branch, if one was used.** If any ticket reported `outcome: "delivered-to-integration"`, run once:

   ```
   node .claude/scripts/deliver-ticket.mjs --open-integration-mr --integration-branch <name> --default-branch <default> --platform <gh|glab>
   ```

   It **opens** an MR and never merges it — landing accumulated work on a protected branch is a human decision. Relay its `INTEGRATION-MR-JSON` line.

4. **Relay the final report verbatim** — including any `asana` errors from step 2b and any `Asana mirror:` notes the deliver step produced. Per ticket: `delivered` · **`delivered-to-integration`** (landed on the integration branch, **NOT** on the default branch — say so explicitly, name the handoff MR, and never report these as done) · `awaiting-human-merge` · `escalated` (stage `review`, `reviewer-failed`, `bounce-fix-build`, or `acceptance-unmet`) · `failed` · `refused` (with the reason `deliver-wave.mjs` gave) · `unreachable` (naming the blocker that did not deliver) · tickets skipped as already delivered. **Relay every `escalations` entry** from both scripts. Escalated and failed items go to the human; do not fix them inline — the write guard will hold you to that.

While a wave runs you are an observer. Do not do stage work in parallel, do not "help" a slow stage, do not edit files. Between waves you deliver, and that is all you do.
