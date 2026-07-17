---
description: Nightly issue sweep — triage open issues, auto-fix the fixable ones through the three-agent pipeline, post the morning report (designed for headless `claude -p "/nightly-issues"`)
argument-hint: [max-issues]
---

Arguments: `$ARGUMENTS` — optional first argument caps how many issues to process tonight (default 5).

Execute in order:

1. **Collect.** List open issues with the platform CLI (`gh issue list --state open --json number,title,body,labels,createdAt,url` / glab equivalent). Exclude issues labeled `nightly:escalated`, `triage:invalid`, or `needs-human`, and any issue titled `Nightly report ...`. For each remaining issue set `isNew` = created within the last 24 hours. Compute `reportDate` = today's local date (YYYY-MM-DD).
2. **Launch the sweep.** Call the **Workflow** tool with `name: "nightly-issues"` and `args: { issues, maxIssues, defaultBranch, platform, reportDate }`. This command's instruction is your authorization to use the Workflow tool. The workflow triages (read-only), runs fixable issues through the run-milestone pipeline autonomously, and posts all tracker writes in one report step.
3. **Final output** (this is the headless run's stdout): the report issue URL, then one line per processed issue — `#N · <classification or pipeline status> · <one-line reason>` — plus how many eligible issues were left for the next night.

Operator notes: scheduling, permissions, and the morning-email mechanics are documented in the scaffold's INSTALL.md § Nightly sweep. You are an observer while the workflow runs — no stage work, no file edits, no tracker writes outside the workflow.
