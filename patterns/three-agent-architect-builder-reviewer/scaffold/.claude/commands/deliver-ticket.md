---
description: Deliver one reviewed-CLEAR ticket by hand, after a /review-ticket CLEAR — the manual path the stage commands stop short of
argument-hint: <ticket-id> [supervised]
---

Arguments: `$ARGUMENTS` — the ticket id, and optionally the bare word `supervised` (open the PR/MR and stop for a human merge instead of merging).

**You do this in THIS session. Do not spawn a subagent for it.** You are already holding everything delivery needs — the ticket, the branch, the Reviewer's record — and handing those to a fresh context would buy nothing and cost the artifacts. (Inside a pipeline run it *is* a stage, because a workflow script has no filesystem and no exec, so an agent is the only actor there that can invoke a command. That is a mechanical constraint, not a role; see the pattern README §2.)

Delivery makes no judgement in either place. In particular it **never writes or summarises a verdict**: the Reviewer authors its own record, and re-typing one is what a safety classifier read as one agent authoring another agent's approval, blocking delivery three times on already-CLEAR tickets (catalog issues #201, #208).

Preconditions — stop if any is unmet, and say which:

| Must hold | How you know |
|---|---|
| A Reviewer returned **CLEAR** for this ticket | the verdict from `/review-ticket` or the pipeline run |
| The Reviewer wrote its own record | `.claude/tmp/<id>-verdict.md` exists and is non-empty |
| Its `[machine]`/`[fixture]` acceptance rows were all met | `machineChecks` carries no `met: false` |
| The branch `ticket/<id>` exists and its tests pass | the Builder's returned test output |

A CLEAR you did not see, or a record you would have to write yourself, is not a precondition met — it is the check failing. Stop and say so.

1. **Verify the Reviewer's record.** Read `.claude/tmp/<id>-verdict.md`. If it is missing or empty, **STOP**: the review is unevidenced and delivering it produces a merge nobody can audit. Do not write this file. Re-run `/review-ticket` instead. The record is the Reviewer's words, and the only agent that may author a verdict is the one that reached it.

2. **Compose the PR/MR body** and write it to `.claude/tmp/<id>-body.md`. This write is allowed from this session — `.claude/tmp/` is carved out of the main-session write guard for exactly this, and needs no override file.

   Start from the repo's template (`.gitlab/merge_request_templates/default.md` on GitLab, else `.github/pull_request_template.md`; if neither exists, skip this step and let the script use its own skeleton). Fill each section **from a named artifact, and from nothing else**:

   | Section | Comes from |
   |---|---|
   | What changed | the Builder's returned summary, and `git diff --stat <default>..ticket/<id>` |
   | Related issue | `Closes #<n>` — the issue number the ticket was published as |
   | Review | the Reviewer's record (quote it; do not paraphrase it into an approval) and the number of BOUNCE cycles |
   | Requirements / UAT | the ticket's own `## Acceptance` rows |
   | Deviations | the Builder's `deviations` field, verbatim — or "none declared" |
   | Tests | the Builder's real test output, and the Reviewer's independent re-run |
   | Constraint check | this repo's CLAUDE.md non-negotiables; tick what the diff touches, mark the rest N/A |
   | Known gaps / rollback | the ticket's `## Non-goals`, and any escalation raised during the run |

   **A fact you do not have is written as unavailable, with the reason. Never infer one.** A body that reads complete but is partly invented is worse than one that admits a gap: this document exists so a human can trust the run without re-reading it, and one invented line makes every other line unverifiable.

3. **Run the delivery script.** It is the only sanctioned path to a merge — it holds the merge policy, the revert guard, the tracker close and the Definition-of-Done check:

   ```
   node .claude/scripts/deliver-ticket.mjs --id <id> --branch ticket/<id> \
     --default-branch <default> --platform <gh|glab> --issue <n> \
     --verdict-file .claude/tmp/<id>-verdict.md --body-file .claude/tmp/<id>-body.md \
     [--test-cmd "<command>"] [--integration-branch <name>] [--no-merge]
   ```

   Read `platform`, the default branch and the test command from CLAUDE.md — never guess them. Add `--no-merge` for `supervised`. Add `--integration-branch` only in autonomous mode, and only if CLAUDE.md declares one. For a repo with no forge at all, replace `--platform`/`--issue` with `--delivery local`.

   **Never** merge, push, open a PR/MR or close an issue with your own `git`/`gh`/`glab` calls, even if the script fails. A failure is an escalation, not an invitation to finish the job by hand.

4. **Relay the `DELIVER-SUMMARY-JSON` line verbatim**, then state plainly what happened. `outcome: "delivered"` **with** `dodPassed: true` is the only thing that counts as done. `delivered-to-integration` means it landed on the integration branch and **not** on the default branch — the ticket is **not** done. `awaitingMerge: true` means the PR/MR is open and nothing merged. Anything else is a failure to report, not to work around. In `checks`, `testsPassed: null` means the check was never run — say that, rather than reporting it as failed.

5. **Delete the branch only after it landed.** `git branch -D ticket/<id>` once `outcome: "delivered"` and `dodPassed: true`. A leftover branch for a ticket that did NOT land is evidence and stays — and it is what later opens a merge request proposing to revert the default branch, so leaving one behind is not merely untidy. (`/start-milestone` and `/start-all` run `cleanup-run.mjs` for you at the end of a run.)
