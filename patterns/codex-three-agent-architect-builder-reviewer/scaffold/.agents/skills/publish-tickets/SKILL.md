---
name: publish-tickets
description: Publish Codex pipeline ticket files as GitHub or GitLab issues and stop. Use when the board should be populated without starting implementation.
---

Invocation authorizes tracker issue creation, but not Gate 1 implementation.

Resolve one module directory or all modules for `--all`. Validate each module README and ticket against `templates/ticket.template.md`. Report all input errors without fixing them.

For each valid module, first ask `delivery` to run the dry run:

`node .codex/scripts/publish-tickets.mjs <module> --platform <Tracker>`

If clean, ask `delivery` to rerun with `--create`. Parse and relay `PUBLISH-SUMMARY-JSON`, including created, existing, failed, closed, and drifted tickets. Drift is an escalation. Stop and state that nothing was built.

