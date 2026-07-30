---
description: Connect this repo to an Asana task so the pipeline mirrors milestones and tickets as Asana subtasks (optional; the pipeline runs fine without it)
argument-hint: "[asana-task-url]"
---

Connect this repository to Asana, or report the current connection. Asana is a **reporting mirror** of the pipeline — never a gate on it. Nothing here changes how tickets are planned, built, reviewed, or delivered.

**Never absorb the role:** you orchestrate this command. Every Asana read and write goes through `.claude/scripts/asana-sync.mjs`. Do not call Asana yourself, do not hand-write `.claude/asana.json`, and do not ask for the token.

## The mapping this installs

| Repo concept | Asana object |
|---|---|
| this repository | an **existing** Asana task you point at (never created by the pipeline) |
| milestone / module (`docs/prd/<module>/`) | a **subtask** of that task, named `[<module>] <title>` |
| ticket / issue | a **subtask of that subtask**, named `[<id>] <title> · #<issue>` |

`[<id>]` is the idempotency key. The `#<issue>` suffix is a human cross-reference only — nothing looks tasks up by it.

## Steps

1. **Check whether this repo is already connected.** Run:

   ```
   node .claude/scripts/asana-sync.mjs check
   ```

   Read the last line (`ASANA-SYNC-JSON:`). If `configured` is `true` and `errors` is empty, report the repo task name and the module subtask count, and STOP — it is already connected. If the user asked to repoint it at a different task, continue but tell them step 3 needs `--force`, and that repointing **orphans every subtask already created** under the old task.

2. **Make sure the token is set.** If `errors` contains `no-token`, stop and tell the user to do this themselves, in their own shell:

   ```
   export ASANA_TOKEN=...        # PowerShell: $env:ASANA_TOKEN = '...'
   ```

   The token is created at <https://app.asana.com/0/my-apps>. **Never** ask the user to paste it into this conversation, never put it in a command argument, and never write it to a file — an Asana Personal Access Token acts as that whole user. Persisting it is the user's own decision (shell profile, or a git-ignored `.env` they source); adopt already git-ignores `.env`.

3. **Get the Asana task URL.** Use `$1` if the user passed one. Otherwise ask for it: the Asana task that represents this repository — open it in Asana and copy the URL from the browser, or use the task's "Copy task link".

   Then write the config:

   ```
   node .claude/scripts/asana-sync.mjs configure --url "<the url>"
   ```

   Add `--project <gid>` if the user wants ticket subtasks to also appear in an Asana project's List/Board/Timeline/Reporting views. Explain the tradeoff when it is relevant: an Asana subtask does **not** belong to its parent's project, so at this depth tickets are invisible in those views unless added explicitly. Do not add it silently — it makes each ticket appear as both a task and a subtask.

   The script validates the task is readable before writing anything, and refuses to overwrite an existing config without `--force`.

4. **Confirm and report.** Re-run `check`. Then tell the user, in this order:
   - the repo task name and gid it is now bound to;
   - that `.claude/asana.json` was written and **should be committed** (it holds no secret);
   - that the token must be present in the environment of whatever runs the pipeline — including any scheduled `/nightly-issues` run, which has its own environment;
   - the next step: nothing syncs yet. Sync a module with
     ```
     node .claude/scripts/asana-sync.mjs sync docs/prd/<module> --create
     ```
     (drop `--create` for a dry run, which is the default).

## Rules

- **Fail-soft, and say so.** Every Asana problem — no token, bad config, HTTP 500, rate limit — exits `0` and is reported in `errors`. Exit `1` means this command invoked the script wrong. Relay `errors` verbatim; never summarize an Asana failure away, and never present a failed sync as done.
- **Never** create the repo-level Asana task, and never delete or complete anything from this command.
- If the user has no Asana task for this repo yet, say so plainly and ask them to create one in Asana first — choosing where it lives in their workspace is their call, not yours.
