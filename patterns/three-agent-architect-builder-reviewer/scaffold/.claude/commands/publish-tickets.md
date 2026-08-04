---
description: Publish a module's tickets as tracker issues (and Asana subtasks if connected), then STOP — no pipeline run
argument-hint: <module dir, e.g. docs/prd/01-foo> [--all]
---

Arguments: `$ARGUMENTS` — a module directory (MODULE below), or `--all` for every module under `docs/prd/`.

Publish only. This is `/start-milestone` step 2 without step 3: issues get created, Asana subtasks get created if the repo is connected, and then you stop. Use it when the board should exist before any work starts — planning a sprint, handing tickets to people, or reviewing the DAG on the tracker.

Typing this command **is** the human authorization to create tracker issues. It is not Gate 1 sign-off to start building; that is still `/start-milestone` or `/start-all`.

**Never absorb the role:** you orchestrate. Every issue and every Asana write goes through the deterministic scripts below. Do not create issues by hand — fabricated issue numbers are the reason this path is a script (catalog issue #26).

## Steps

1. **Verify inputs.** `MODULE/README.md` exists and `MODULE/tickets/*.md` is non-empty; every ticket carries the frontmatter `templates/ticket.template.md` requires. Anything missing → STOP and list exactly what. Do not fix it — that is Architect-stage work. With `--all`, resolve every module dir under `docs/prd/` and check each; report all problems before stopping.

2. **Dry run.** `node .claude/scripts/publish-tickets.mjs MODULE` and show the mapping. If the summary has `error` entries → STOP and report them.

3. **Create.** Re-run with `--create --platform <gh|glab>` — read `platform` from the CLAUDE.md **`Tracker:`** line (adopt.mjs set it), never guess it. Idempotent: the `[<id>]` title prefix dedupes, so re-running is safe. STOP on any `error` entries. Save stdout — step 4 needs it.

   A `drift: true` entry means a **closed** issue whose body no longer matches its ticket. Report it; do not fix it. Either the ticket was edited after delivery (a human decides whether to re-run it) or the issue predates a body-format change (`--sync` refreshes that one).

4. **Mirror to Asana, if connected.** Skip entirely when `.claude/asana.json` does not exist — no output, no calls. Otherwise run:

   ```
   node .claude/scripts/asana-sync.mjs sync MODULE --create --issues <step 3 stdout file>
   ```

   so subtask names carry `#<issue>`. Read the `ASANA-SYNC-JSON` line. Relay every `errors` entry verbatim, then continue — **never stop for an Asana failure.** Asana is a reporting mirror, not a gate, and the script exits 0 on every Asana problem by design.

5. **Report and STOP.** Per ticket: created / already existed / failed / drifted. Then the Asana mirror line if applicable. Then say plainly that **nothing has been built** and name the next step: `/start-milestone MODULE` for one module, or `/start-all` for the whole PRD.

Do not call the Workflow tool. Do not plan, build, or review anything. If the human wanted work to start, they will run one of the start commands.
