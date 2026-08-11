---
name: run-ticket
description: Run one ticket through the Codex Architect -> Builder -> fresh Reviewer -> delivery loop. Use for an end-to-end ticket pipeline.
---

Resolve one ticket and its id. Read `AGENTS.md` for Operating mode, Tracker, Integration branch, default branch, and the repository test command. Stop if required project facts are missing. Confirm a tracker issue with the `[<id>]` title prefix already exists; if it does not, stop and direct the user to `$publish-tickets <module>` or a Gate 1 start skill. Do not create tracker state implicitly from this skill.

1. Spawn `architect` with only the ticket path. Wait for `docs/plans/<id>.md`.
2. Spawn `builder` with ticket path, plan path, default branch, and `ticket/<id>`. Wait for a committed implementation and exact test evidence.
3. Spawn a new `reviewer`. Pass only ticket path, plan path, and branch/commit diff reference.
4. On BOUNCE, send the numbered findings back to the same Builder thread. After it commits repairs, spawn another new Reviewer with artifact-only input. Permit at most two BOUNCE cycles; then escalate.
5. On CLEAR, identify the tracker issue created from `[<id>]` and spawn `delivery`. Ask it to write the verdict verbatim to `.codex/tmp/<id>-verdict.md`, compose the repository PR/MR template into `.codex/tmp/<id>-body.md`, and run:

   `node .codex/scripts/deliver-ticket.mjs --id <id> --branch ticket/<id> --default-branch <default> --issue <n> --platform <gh|glab> --verdict-file .codex/tmp/<id>-verdict.md --body-file .codex/tmp/<id>-body.md [--test-cmd <command>]`

   Add `--no-merge` in supervised mode. Add `--integration-branch <name>` in autonomous mode only when configured.
6. Relay the `DELIVER-SUMMARY-JSON` outcome verbatim. A script refusal, failed check, or `dodPassed: false` is an escalation, not success.

The primary thread orchestrates only. Never absorb a failed stage or edit files inline.
