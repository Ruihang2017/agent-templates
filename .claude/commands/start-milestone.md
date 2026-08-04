---
description: Gate 1 start signal — publish the module's tickets as tracker issues, then run the milestone pipeline (three-agent pattern)
argument-hint: <module dir, e.g. docs/prd/01-foo> [supervised|autonomous] [concurrency]
---

Arguments: `$ARGUMENTS` — the first is the module directory (MODULE below); an optional `supervised|autonomous` overrides the repo's declared Operating mode (CLAUDE.md); an optional integer sets **`concurrency`** (default 1 = sequential; >1 runs independent tickets as parallel lanes — autonomous only, supervised is forced to 1).

Typing this command **is** the human Gate 1 sign-off: the sub-PRD and tickets are final, and tracker issue **creation** is authorized by this sign-off. Execute in order:

1. **Verify Gate 1 inputs.** `MODULE/README.md` (the sub-PRD) exists and `MODULE/tickets/*.md` is non-empty; every ticket has the required frontmatter (see `templates/ticket.template.md`). Anything missing → STOP and list exactly what is missing. Do not fix it yourself — that is Architect-stage work.
2. **Publish tickets as tracker issues.** Run `node .claude/scripts/publish-tickets.mjs MODULE` (dry-run) and show the mapping. If the summary contains `error` entries → STOP and report them. Otherwise re-run with `--create` (idempotent — the `[<id>]` title prefix dedupes, so re-running is safe), and again STOP on any `error` entries.
2b. **Mirror to Asana, if this repo is connected.** Skip this step entirely when `.claude/asana.json` does not exist — most repos are not connected and must see no extra output. When it does exist, save step 2's `--create` stdout to a file and run `node .claude/scripts/asana-sync.mjs sync MODULE --create --issues <that file>` so subtask names carry the `#<issue>` numbers. Read the `ASANA-SYNC-JSON` line: report what was created, and if `errors` is non-empty **relay every entry verbatim in your final report** and carry on. **Never stop the run for an Asana failure** — Asana is a reporting mirror, not a gate, and the script exits 0 on every Asana problem by design.

3. **Launch the pipeline.** Parse the final `PUBLISH-SUMMARY-JSON` line into `tickets: [{id, path, issue}]`, and add each ticket's **`blockedBy`** — its `blocked_by` frontmatter, filtered to ids in THIS module (cross-module / already-delivered deps are ignored) — so parallel lanes respect the intra-module DAG. **Filter out tickets whose issue is already closed** (check via `gh`/`glab` — closed means delivered by an earlier run; this filter is what makes re-runs after supervised pauses or crashes safe). Determine the Operating mode, then call the **Workflow** tool with `name: "run-milestone"` and `args: { tickets, mode, defaultBranch, platform, concurrency, integrationBranch }` (concurrency from the optional arg, default 1) — read `platform` from the CLAUDE.md **`Tracker:`** line (`gh` or `glab`; adopt.mjs set it from the origin remote), never guess it — plus `testCmd` (the repo's test command, if its CLAUDE.md declares one) so the deterministic deliver script re-runs tests on the merged default branch as part of DoD. Read **`integrationBranch`** from the CLAUDE.md **`Integration branch:`** line if it declares one, else omit it: in autonomous mode that lets a merge the **protected** default branch refuses land there instead of stalling the run. It is never used for an unmet gate — a failing pipeline or missing approval still escalates — and work delivered there **does not pass the Definition of Done**. This command's instruction is your authorization to use the Workflow tool.

3b. **Hand off the integration branch, if one was used.** After the workflow returns, if any ticket reports `outcome: "delivered-to-integration"`, run once:

   ```
   node .claude/scripts/deliver-ticket.mjs --open-integration-mr --integration-branch <name> --default-branch <default> --platform <gh|glab>
   ```

   It **opens** an MR and never merges it — landing accumulated work on a protected branch is a human decision. Relay its `INTEGRATION-MR-JSON` line.

4. **Relay the final report verbatim** — including any `asana` errors from step 2b and any `Asana mirror:` notes the deliver step produced. Per ticket: `delivered` · **`delivered-to-integration`** (landed on the integration branch, **NOT** on the default branch — say so explicitly, name the handoff MR, and never report these as done) · `awaiting-human-merge` · `escalated` (stage `review`, `reviewer-failed`, or `bounce-fix-build`) · `failed` · `delivery-incomplete`, plus `notStarted` when the run stopped early. Escalated and failed items go to the human; do not fix them inline (the write guard will hold you to that). In `supervised` mode each CLEAR opens a PR/MR (with the Reviewer's verdict as a comment) and the run stops — relay the PR/MR URL, tell the human to review + merge it, then re-run this command to continue.

While the workflow runs you are an observer. Do not do stage work in parallel, do not "help" a slow stage, do not edit files.
