---
description: Gate 1 start signal — publish the module's tickets as tracker issues, then run the milestone pipeline (three-agent pattern)
argument-hint: <module dir, e.g. docs/prd/01-foo> [supervised|autonomous]
---

Arguments: `$ARGUMENTS` — the first is the module directory (MODULE below); the optional second overrides the repo's declared Operating mode (CLAUDE.md).

Typing this command **is** the human Gate 1 sign-off: the sub-PRD and tickets are final, and tracker issue **creation** is authorized by this sign-off. Execute in order:

1. **Verify Gate 1 inputs.** `MODULE/README.md` (the sub-PRD) exists and `MODULE/tickets/*.md` is non-empty; every ticket has the required frontmatter (see `templates/ticket.template.md`). Anything missing → STOP and list exactly what is missing. Do not fix it yourself — that is Architect-stage work.
2. **Publish tickets as tracker issues.** Run `node .claude/scripts/publish-tickets.mjs MODULE` (dry-run) and show the mapping. If the summary contains `error` entries → STOP and report them. Otherwise re-run with `--create` (idempotent — the `[<id>]` title prefix dedupes, so re-running is safe), and again STOP on any `error` entries.
3. **Launch the pipeline.** Parse the final `PUBLISH-SUMMARY-JSON` line into `tickets: [{id, path, issue}]`. **Filter out tickets whose issue is already closed** (check via `gh`/`glab` — closed means delivered by an earlier run; this filter is what makes re-runs after supervised pauses or crashes safe). Determine the Operating mode, then call the **Workflow** tool with `name: "run-milestone"` and `args: { tickets, mode, defaultBranch, platform }`. This command's instruction is your authorization to use the Workflow tool.
4. **Relay the final report verbatim** — per ticket: `delivered` · `awaiting-human-merge` · `escalated` (stage `review`, `reviewer-failed`, or `bounce-fix-build`) · `failed` · `delivery-incomplete`, plus `notStarted` when the run stopped early. Escalated and failed items go to the human; do not fix them inline (the write guard will hold you to that). In `supervised` mode the run stops after each CLEAR verdict — tell the human to merge, then re-run this command to continue.

While the workflow runs you are an observer. Do not do stage work in parallel, do not "help" a slow stage, do not edit files.
