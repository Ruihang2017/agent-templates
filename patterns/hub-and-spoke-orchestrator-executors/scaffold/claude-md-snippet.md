<!-- agent-templates:hub-and-spoke:start -->
## Delivery pipeline — hub-and-spoke (agent-templates)

This repo delivers work through one **hub** (this Claude session) and N **spokes** (headless `codex exec` runs, one isolated git worktree each). The hub is the only expensive model in the loop and it keeps a single context for the whole run.

**Stages**

| Command | Who runs | What it does |
|---|---|---|
| `/hub-brief` | hub, `high` effort | PRD → contract-first task briefs in `docs/briefs/`. Stops at Gate 1 for human review. |
| `/hub-dispatch` | deterministic script | Validates every brief, then fans the ready ones out to `codex exec` in parallel worktrees. |
| `/hub-collect` | hub, same session | Re-audits each spoke branch, re-runs its tests, reviews the diff, merges what clears the gate. |

**Rules that are not negotiable**

1. **The hub never writes inside `.claude/worktrees/`.** `.claude/settings.json` denies it. To fix a spoke's work, check its branch out in the main tree.
2. **The hub owns all structural truth** — schemas, types, migrations, public interfaces, and every dependency change. Spokes implement contracts; they never author one.
3. **Spokes may never touch dependency, lock, build, CI, or agent-config files.** The firewall in `.claude/scripts/firewall.mjs` enforces this after the fact, and `/hub-brief` rejects any brief whose declared scope names one.
4. **A brief set is dispatched all-or-nothing.** If any brief fails validation, none are dispatched — an invalid decomposition is a hub problem, and low-effort executors will not notice it.
5. **`quarantined` outranks a green test run.** A spoke that passed its tests while writing outside its scope does not merge. Never widen a brief's `file_scope` to match what a spoke actually did.
6. **`unverified` is not a pass.** A branch whose tests could not be re-run does not merge.
7. **A merge conflict between spokes is aborted, not resolved.** It means the decomposition was wrong; re-cut the briefs.

**Known limit of this pipeline, stated so nobody has to rediscover it:** the hub reviews diffs written against a contract the hub itself wrote, in the same session. That review is *not* independent, and it will not catch a wrong contract that was faithfully implemented. The deterministic checks in `collect.mjs` are independent; the hub's judgement is not. Work that cannot afford this — security-sensitive paths, shared services, anything where a bad merge is expensive — belongs in a pattern with a separate reviewer, not this one.

**Testing:** the agents own the whole test pyramid. Spokes write and run unit and integration tests inside their brief's scope; `collect.mjs` re-runs the project's `test_cmd` before any merge. The human tests exactly once — the Gate 2 smoke test after the PRD's briefs are all delivered.

**Human gates:** Gate 1 = review the briefs after `/hub-brief`, before any dispatch. Gate 2 = smoke test after the last merge. Between those two, the pipeline runs unattended.
<!-- agent-templates:hub-and-spoke:end -->
