---
name: run-ticket
description: Run one ticket through the Codex Architect -> Builder -> fresh Reviewer -> delivery loop. Use for an end-to-end ticket pipeline.
---

Resolve one ticket and its id. Read `AGENTS.md` for Operating mode, Tracker, Integration branch, default branch, and the repository test command. Stop if required project facts are missing. Confirm a tracker issue with the `[<id>]` title prefix already exists; if it does not, stop and direct the user to `$publish-tickets <module>` or a Gate 1 start skill. Do not create tracker state implicitly from this skill.

1. Spawn `architect` with only the ticket path. Wait for `docs/plans/<id>.md`.
2. Spawn `builder` with ticket path, plan path, default branch, and `ticket/<id>`. Wait for a committed implementation and exact test evidence.
3. Spawn a new `reviewer`. Pass only ticket path, plan path, and branch/commit diff reference.
4. On BOUNCE, send the numbered findings back to the same Builder thread. After it commits repairs, spawn another new Reviewer with artifact-only input. Permit at most two BOUNCE cycles; then escalate.
5. On CLEAR, identify the tracker issue created from `[<id>]`. **You compose the PR/MR body yourself, in this thread** — `delivery` never composes it (catalog issue #193).

   The reason is a contract conflict, not a preference: `delivery` is defined as a mechanical actuator at low reasoning effort whose instructions say it may write only *supplied* text and must not invent a verdict or a body. A complete PR body needs facts only this thread holds — the bounce count, the Reviewer's actual findings, the Builder's declared deviations, the test evidence, requirement/UAT references, impacts and known gaps. Asking a mechanical actuator to compose that is asking it to invent review history, and a low-effort role will produce fluent, plausible, wrong evidence.

   Fill the repository's PR/MR template (`.gitlab/merge_request_templates/default.md`, else `.github/pull_request_template.md`) from the **stage artifacts you already hold**, and from nothing else:

   | Section | Comes from |
   |---|---|
   | What changed | the Builder's returned summary and the diff |
   | Review | the Reviewer's verdict text and finding count; the number of BOUNCE cycles this ticket took |
   | Requirements / UAT | the ticket's own `## Acceptance` rows, quoted |
   | Deviations | the Builder's `deviations` field — verbatim, or "none declared" |
   | Tests | the Builder's exact test output, and the Reviewer's independent re-run |
   | Known gaps / rollback | the ticket's `## Non-goals` and any escalation raised during the run |

   **If a required fact is not in an artifact, write that it is unavailable and say why — never infer it.** A body that reads complete but is partly invented is worse than one that admits a gap, because the whole purpose of this document is to let a human trust the run without re-reading it.

   Then spawn `delivery` and ask it to write the two files **verbatim from the bytes you supply** — the verdict to `.codex/tmp/<id>-verdict.md`, your composed body to `.codex/tmp/<id>-body.md` — and run:

   `node .codex/scripts/deliver-ticket.mjs --id <id> --branch ticket/<id> --default-branch <default> --issue <n> --platform <gh|glab> --verdict-file .codex/tmp/<id>-verdict.md --body-file .codex/tmp/<id>-body.md [--test-cmd <command>]`

   Add `--no-merge` in supervised mode. Add `--integration-branch <name>` in autonomous mode only when configured.
6. Relay the `DELIVER-SUMMARY-JSON` outcome verbatim. A script refusal, failed check, or `dodPassed: false` is an escalation, not success.

The primary thread orchestrates only. Never absorb a failed stage or edit files inline.
