<!-- asana-integration:start -->
## Asana mirror (optional)

**Asana: `unconfigured`** — run `/connect-asana` to bind this repo to an Asana task. Until then every Asana step is a no-op and nothing below applies.

Asana is a **reporting mirror of the pipeline, never a gate on it.**

- **`/connect-asana [asana-task-url]`** — bind this repo to an existing Asana task, or report the current binding. Writes `.claude/asana.json` (commit it — gids and names only, no secret).
- Mapping: this repo = the Asana task · a milestone/module = a **subtask** of it, named `[<module>] <title>` · a ticket/issue = a **subtask of that subtask**, named `[<id>] <title> · #<issue>`. `[<key>]` is the idempotency key; the `#<issue>` suffix is for humans and nothing looks tasks up by it.
- All Asana reads and writes go through **`.claude/scripts/asana-sync.mjs`** — the only sanctioned path, same rule as `publish-tickets.mjs` for issues. Agents never call the Asana API directly and never hand-edit `.claude/asana.json`.
- **Token:** `ASANA_TOKEN` env var only. Never a command argument, never committed, never pasted into a session — an Asana PAT acts as the whole user. Whatever runs the pipeline needs it in *its own* environment, including a scheduled nightly sweep.
- **Fail-soft contract:** exit `1` from `asana-sync.mjs` means it was invoked wrong. **Every Asana failure exits `0`** and is reported in the `ASANA-SYNC-JSON` line's `errors`. Asana is **not** part of the Definition of Done and must never be added to it — an expired token cannot be allowed to fail a delivered ticket. In exchange, any step that calls it **must relay `errors` into its escalations**: fail-soft means do not block, never do not mention.
- Direction is one-way. Editing a subtask in Asana changes nothing here; the ticket file stays the source of truth.

Details, API reference, and the accepted cost of the subtask depth: the catalog's `integrations/asana/README.md`.
<!-- asana-integration:end -->
