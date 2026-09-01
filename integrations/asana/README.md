# Integration: Asana

| Field | Value |
|---|---|
| **Applies to** | every pattern — installed by `adopt.mjs` regardless of which pattern you adopt |
| **Status** | `proposed` — core shipped, pipeline wiring is a follow-up |
| **As-of date** | 2026-07-30 (every Asana API claim below verified against live docs that day) |
| **Expiry trigger** | Asana API v1.0 successor, MCP V2 deprecation, or 2027-01-30 (+6 months) |
| **Opt-in** | the files install always but are **inert** until `/connect-asana` writes `.claude/asana.json` |

Mirrors pipeline work into Asana: milestones and tickets become Asana subtasks, and a delivered ticket's subtask gets completed. Asana is a **reporting mirror, never a gate** — see [Fail-soft](#fail-soft).

## Mapping

| Repo concept | Asana object | Name |
|---|---|---|
| repository | an **existing** task you point at | never created or renamed by the pipeline |
| milestone / module (`docs/prd/<module>/`) | subtask of the repo task | `[<module>] <title>` |
| ticket / issue | subtask of the module subtask | `[<id>] <title> · #<issue>` |

`[<key>]` is the **idempotency key**. Everything after it is cosmetic — the `#<issue>` suffix is a human cross-reference, and a subtask created before its issue existed picks the number up on the next `sync --create` via a rename.

Asana permits [5 levels of subtask nesting](https://help.asana.com/s/article/subtasks), so three levels fit.

### The accepted cost of this depth

An Asana subtask **does not belong to its parent's project**. At sub-subtask depth, tickets therefore do **not** appear in List, Board, Timeline, or Reporting views — only inside the parent task's detail pane. This was accepted deliberately (issue #124) to match an existing workspace structure where one repo is already one task.

Mitigation without changing the hierarchy: set `addTicketsToProject` to a project gid, and each ticket subtask is added to that project as it is created. Cost: the ticket then shows up **both** as a task in the project and as a subtask under its module.

The alternative mapping — repo → Asana *project*, module → task, ticket → subtask — puts every level on a native Asana concept and keeps subtasks one level deep (Asana's own recommendation). It is not implemented; `mode: "task"` in the config exists so the choice stays visible and a `"project"` mode can be added without a migration guess.

## Setup

1. Create a Personal Access Token at <https://app.asana.com/0/my-apps>.
2. Export it. **Never** commit it, never pass it as a CLI argument, never put it in `.claude/asana.json`:
   ```
   export ASANA_TOKEN=...            # PowerShell: $env:ASANA_TOKEN = '...'
   ```
   A PAT [acts as the whole user](https://developers.asana.com/docs/personal-access-token) — treat it like a password. `adopt` git-ignores `.env` if you prefer to keep it there and source it.
3. In Claude Code, run **`/connect-asana`** and give it the Asana task that represents this repo.
4. Commit the resulting `.claude/asana.json`. It holds gids and names only.

`adopt` also merges `Bash(node .claude/scripts/asana-sync.mjs:*)` into your `.claude/settings.json` `permissions.allow` (additively — your own entries survive). This is not cosmetic: an un-allowlisted script prompts on **every** call, which breaks autonomous runs and the headless nightly sweep outright, since nobody is there to approve. If you keep a hand-written `settings.json`, add that rule yourself.

Whatever runs the pipeline needs `ASANA_TOKEN` in **its** environment — including a scheduled `/nightly-issues` run, which does not inherit your interactive shell.

## Script

`.claude/scripts/asana-sync.mjs` is the only sanctioned Asana write path — the same rule `publish-tickets.mjs` and `deliver-ticket.mjs` follow, for the same reason: agents never hand-write tracker state.

| Command | Does |
|---|---|
| `check` | validate config + token, resolve the repo task, count module subtasks. Writes nothing |
| `resolve --url <url>` | parse a task URL and report name + workspace gid. Writes nothing |
| `configure --url <url> [--project <gid>] [--force]` | validate, then write `.claude/asana.json` |
| `sync <module-dir> [--create] [--issues <file\|->]` | ensure the module subtask and its ticket subtasks exist |
| `complete <ticket-id> [--create]` | mark one ticket's subtask completed |
| `status [<module-dir>]` | report what exists vs the tickets. Writes nothing |

`--create` is required to write; **dry-run is the default**. `--issues` takes `publish-tickets.mjs`'s `PUBLISH-SUMMARY-JSON` (a file, or `-` for stdin) so subtask names carry the issue number.

The last stdout line is machine-readable:

```
ASANA-SYNC-JSON: {"verb","configured","ok","repoTask","module","items":[...],"errors":[...]}
```

### Fail-soft

**Exit `1` means the caller invoked the script wrong** — unknown verb, missing argument. A bug to fix.

**Exit `0` is everything else, including every Asana failure**: no token, no config, HTTP 500, rate-limited past retries, a missing parent task. The failure is reported in `errors`.

This is deliberate. `dodPassed` gates on `issueClosed` and `/start-all` runs unattended for 47–104 minutes; an expired Asana token must never fail a ticket that was actually delivered. **Asana is not in the Definition of Done and must not be added to it.**

The corresponding obligation: callers **must relay `errors` into their escalations**. A reporting mirror that silently stops mirroring is this repo's recurring failure class (pattern §4, "Silent delivery drop") — fail-soft means *do not block*, never *do not mention*.

## Why a script and not the official MCP server

Asana ships an official MCP server — `https://mcp.asana.com/v2/mcp`, Streamable HTTP, [OAuth](https://developers.asana.com/docs/using-asanas-mcp-server) (V1 dead since 2026-05-11) — with capable write tools (`create_tasks`, `update_tasks`, up to 50 per call). Writes still go through this script, for three reasons:

1. **Headless.** The MCP server is interactively OAuth-authenticated. `/nightly-issues` runs headless via `claude -p` on an OS schedule, where such servers may be absent — the sync would fail silently on the least-supervised path.
2. **Precedent.** Agent-driven tracker writes already failed here: harness safety classifiers blocked the agent-run deliver stage **3/3** after journaled CLEARs (pattern §7, 2026-07-19, issue #26). `deliver-ticket.mjs` exists because of it.
3. **Testability.** The E2E suite drives tracker writes through fake CLIs. MCP calls cannot be tested that way; this script is tested against a fake Asana API over `ASANA_API_BASE`.

None of this costs what MCP was wanted for: no hosting, no webhooks, no recurring cost either way. Only the caller changes. Adding the MCP server for interactive queries ("what's the status of module 3") is fine — just nothing in the pipeline may depend on it.

## Why names, not search

The script walks `repoTask → module subtasks → ticket subtasks` and matches `[<key>]` prefixes client-side. It never calls Asana's search endpoint, which is unusable for this:

- **premium-only**
- index lag of **10–60 seconds**, and the docs state it is "not suited for use cases that require immediate consistency after writes" — create-then-find inside one run is exactly that
- repeating one query "may return the data in a different order, even if the data do not change"
- a separate **60 req/min** cap

Source: [searchtasksforworkspace](https://developers.asana.com/reference/searchtasksforworkspace). Subtask **list** endpoints are strongly consistent, which is the identical reasoning `publish-tickets.mjs` documents for the tracker. Cost: `1 + N` requests for N modules — trivial against [150 req/min free / 1500 paid](https://developers.asana.com/docs/rate-limits).

A `429` is retried honoring `Retry-After` (capped), because rejected requests still count against the quota, so retrying early makes recovery worse.

## API reference used

All verified 2026-07-30. Re-verify before changing any call.

| Call | Endpoint |
|---|---|
| auth | `Authorization: Bearer <PAT>` — [docs](https://developers.asana.com/docs/personal-access-token) |
| get task | `GET /tasks/{gid}` — [docs](https://developers.asana.com/reference/gettask) |
| list subtasks | `GET /tasks/{gid}/subtasks` — [docs](https://developers.asana.com/reference/getsubtasksfortask) |
| create subtask | `POST /tasks/{gid}/subtasks`, body `{"data":{"name":...}}` — parent from the path — [docs](https://developers.asana.com/reference/createtask) |
| update / complete | **`PUT`** `/tasks/{gid}`, body `{"data":{"completed":true}}`; only provided fields change — [docs](https://developers.asana.com/reference/updatetask) |
| add to project | `POST /tasks/{gid}/addProject` — [docs](https://developers.asana.com/reference/addprojectfortask) |
| rate limits | 150/min free, 1500/min paid, `429` + `Retry-After`, 15 concurrent writes — [docs](https://developers.asana.com/docs/rate-limits) |

Task URL shapes `resolve`/`configure` accept — the org id in a UI URL is **not** the API workspace gid, so the workspace is always read from `GET /tasks/{gid}` instead:

```
https://app.asana.com/1/<org>/project/<project>/task/<task>
https://app.asana.com/1/<org>/task/<task>
https://app.asana.com/0/<project>/<task>            (legacy)
<task gid>                                          (bare id)
```

## Where it fires automatically

Once `/connect-asana` has run, nothing else is manual (issue #126):

| Trigger | Call | Effect |
|---|---|---|
| `/publish-tickets`, `/start-milestone`, `/start-all` — right after issues are published | `sync <module> --create --issues -` | module + ticket subtasks created; names pick up `#<issue>` |
| `deliver-ticket.mjs` — right after the tracker issue closes | `complete <ticket-id> --create` | that ticket's subtask completed |
| `/verify-delivery` | `status <module>` | drift reported as its own line, never as a DoD failure |

The deliver step uses the **same landed-merge precondition** as the tracker close: an unlanded merge completes nothing, because a completed subtask would report delivery that did not happen. Every trigger is a true no-op without `.claude/asana.json` — the deliver step does not even spawn a process, so an unconnected repo pays nothing.

## Known failure modes

| Symptom | Cause | Status |
|---|---|---|
| The script prints `ASANA-SYNC-JSON: … "ok":true` and **then** the process aborts with exit code `3221226505` (`0xC0000409`), stderr showing `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c` | `finish()` called `process.exit(0)` while undici still had handles in teardown. Node 24 + Windows aborts on that; Node 18/20 does not. The work had already succeeded — only the *ending* was wrong, so any caller reading an exit code saw a failure for a sync that worked | **Fixed 2026-08-31.** `finish()` sets `process.exitCode` and lets the loop drain. `[internal]` reproduced 8/8 on Node 24.18.0 / Windows 11; CI never saw it because the matrix was Node 18/20, which is why **24 is now in it** |
| A retry storm (`429`/`5xx`) leaves connections open | the retry path looped without draining the response body, holding its socket | **Fixed 2026-08-31.** The body is drained before retrying — and those were exactly the handles still in teardown above |

## Not implemented

- **No `mode: "project"`** hierarchy (see above).
- **No Asana → repo direction.** Editing a subtask in Asana changes nothing here; the ticket file stays the source of truth, as pattern issue #53 requires.
- **No comments, assignees, due dates, or custom fields.** An Asana custom field holding the issue URL would be filterable in Asana reporting and is the obvious next step, but it needs workspace-admin rights to create.
