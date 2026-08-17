---
description: Nightly issue sweep — triage open issues, auto-fix the fixable ones through the three-agent pipeline, deliver what cleared, post the morning report (designed for headless `claude -p "/nightly-issues"`)
argument-hint: [max-issues]
---

Arguments: `$ARGUMENTS` — optional first argument caps how many issues to process tonight (default 5).

Execute in order:

1. **Collect.** List open issues with the platform CLI (`gh issue list --state open --json number,title,body,labels,createdAt,url` / glab equivalent). Exclude issues labeled `nightly:escalated`, `triage:invalid`, or `needs-human`, and any issue titled `Nightly report ...`. For each remaining issue set `isNew` = created within the last 24 hours. Compute `reportDate` = today's local date (YYYY-MM-DD).

2. **Run the sweep.** Call the **Workflow** tool with `name: "nightly-issues"` and `args: { issues, maxIssues, defaultBranch, platform, reportDate }` — read `platform` from the CLAUDE.md **`Tracker:`** line (`gh` or `glab`; adopt.mjs set it), never guess it. This command's instruction is your authorization to use the Workflow tool. The workflow triages (read-only) and runs each fixable issue's ticket through architect → builder → reviewer.

   **It delivers nothing and writes nothing to the tracker.** A ticket comes back `reviewed-clear`, which means a Reviewer cleared the work and it is still sitting on its branch. Nightly issues are independent of one another, so they form exactly one wave.

3. **Deliver what cleared.** For each `reviewed-clear` row in `waveResults`, compose the PR/MR body into `.claude/tmp/<id>-body.md` (see `/deliver-ticket` step 2 — every section from a named artifact, anything unavailable said plainly rather than inferred). Never write the `-verdict.md` file; the Reviewer wrote it, and a missing one is a refusal, not a gap for you to fill.

   Write the returned `waveResults` — plus each `bodyFile` — to `.claude/tmp/wave-nightly.json`, then:

   ```
   node .claude/scripts/deliver-wave.mjs --wave .claude/tmp/wave-nightly.json \
     --default-branch <default> --platform <gh|glab> [--test-cmd "<command>"]
   ```

   Parse `WAVE-DELIVER-JSON`. A ticket counts as **fixed** only where `outcome` is `delivered` **and** `dodPassed` is true. `refused`, `delivered-to-integration`, and anything else are **not** fixed.

4. **Post the report.** This is the only step that writes to the tracker, and it runs here rather than inside the workflow because only this session knows what actually landed. Base every statement on the digest and the delivery report; **fabricate nothing**.

   1. Per issue, post ONE comment stating the outcome — fixed (link the merge or PR) / attempted-but-not-solved (why, with the findings) / needs-human (why) / invalid (why).
   2. Labels: add `triage:invalid` to invalid issues (do **not** close them — the human decides in the morning); add `nightly:escalated` to attempted-but-not-solved, refused, and pipeline-failed issues; add `needs-human` to needs-human issues.
   3. For every ticket the delivery report shows as delivered, verify its issue is actually closed and close it if the deliver step missed it.
   4. Create a tracker issue titled exactly `Nightly report <reportDate>` (search first; if it exists, comment on it instead of duplicating) with sections: New overnight · Fixed & closed · Attempted, not solved · Needs human · Invalid (ignore) · Not processed (cap). Use `#N` references so the tracker links them.

5. **Final output** (this is the headless run's stdout): the report issue URL, then one line per processed issue — `#N · <classification or delivery outcome> · <one-line reason>` — plus how many eligible issues were left for the next night, and every `escalations` entry `deliver-wave.mjs` produced.

Operator notes: scheduling, permissions, and the morning-email mechanics are documented in the scaffold's INSTALL.md § Nightly sweep. You are an observer while the workflow runs — no stage work, no file edits, no tracker writes until it returns. After it returns you deliver and report, and that is all you do: a ticket the pipeline did not clear is never fixed by hand here.
