# Adopting a pattern

How to apply a pattern from this catalog to a **new** project (even a folder holding nothing but a `PRD.md`) or an **existing** one.

## 0. Pick the pattern

Check the index in [README.md](README.md), then the pattern's own §1 **When to use / when not to use** — take the "not" side seriously. Check the pattern's expiry trigger (metadata table); do not copy an expired model/effort table without re-verifying it.

## 1. Install — one command

From the public npm registry (anonymous, works for anyone):

```
npx agent-templates@latest adopt three-agent-architect-builder-reviewer C:\path\to\your-project
```

Pin an exact version for reproducibility (`npx agent-templates@0.1.0 …`) — a published version is a verified snapshot of the catalog's recommendations. Alternatives: `npx github:Ruihang2017/agent-templates …` (tracks the repo, no release needed; npx caches git installs — `--prefer-online` picks up updates), or from a checkout: `node scripts/adopt.mjs three-agent-architect-builder-reviewer <target-dir>`.

Idempotent (re-runs skip what exists; `--force` overwrites). It installs the scaffold `.claude/` (agents with pinned model/effort, stage commands, write guard, workflows, publish script), the universal `templates/ticket.template.md`, the platform tracker templates into `.github/` or `.gitlab/`, creates `docs/prd|adr|plans/`, copies a root `PRD.md` to `docs/PRD.md`, and seeds or appends `CLAUDE.md` from the pattern snippet (marker-checked, never duplicated).

**Platform (GitHub vs GitLab)** is resolved before anything is installed — from the origin remote host, else a repo-local signal (`.gitlab-ci.yml` → GitLab, existing `.github/` → GitHub). If neither is present (e.g. a fresh repo with only a `PRD.md`), adopt **does not guess**: run interactively it asks; run non-interactively (an agent or CI) it exits without installing and asks you to pass `--platform gh|glab`. So on a bare repo, either set the remote first or pass `--platform`. The resolved value is written to the `Tracker:` line in `CLAUDE.md`, which the pipeline reads.

**Upstream issue escalation is opt-in.** By default the installed `CLAUDE.md` carries **no** instruction to file pattern-level problems against any catalog — no external repo slug is written into your repo (safe for commercial and private projects). Pass `--upstream` to include the bullet pointing at the catalog you adopted from, or `--upstream <owner/repo>` to point it at your own fork or internal catalog.

## 2. New project from a bare PRD.md — end to end

Preconditions: git repo + remote, Node ≥ 18, Claude Code, and an **authenticated tracker CLI**. For GitLab that means `glab` with a Personal Access Token carrying the **`api`** scope, installed via `glab auth login --stdin < token.txt` — full walkthrough, including why not `--token` on the command line and why the 365-day expiry matters for the nightly sweep, in the pattern's [INSTALL.md § Tracker CLI + token setup](patterns/three-agent-architect-builder-reviewer/scaffold/INSTALL.md#tracker-cli--token-setup). **You install the token into the CLI yourself; it never goes to the agent.** The pipeline then acts as you on the forge, and every MR it opens carries a visible banner saying the change was written and merged by AI.

1. `git init`, create the remote (e.g. `gh repo create`), commit `PRD.md`.
2. Run `adopt.mjs` (above) — then commit the scaffolding.
3. Review `CLAUDE.md`: add your project facts and non-negotiables above the pipeline section; keep **Operating mode: `supervised`** for now. Fill the **Constraint check** section of `.github/PULL_REQUEST_TEMPLATE.md` (or the GitLab MR template) from those non-negotiables.
4. In Claude Code, in the project: **`/breakdown-prd`** — the Architect decomposes `docs/PRD.md` into `docs/prd/breakdown-plan.md` + sub-PRDs + template-compliant tickets (disjoint file-scopes, dependency DAG), then stops. (It takes an optional PRD path — that is how later phases are added; see step 9.)
4b. Optional, *after* you have read the breakdown: **`/publish-tickets docs/prd/00-<module>`** creates the tracker issues (and Asana subtasks, if connected) and stops, so the board exists before any work starts — useful for sprint planning or handing tickets to people. It authorizes issue creation but is **not** Gate 1 sign-off to build; step 5 still is.
5. **Gate 1 — your product judgment moment.** Review the breakdown: module boundaries, non-goals, the DAG, open questions. Edit/ask until right. Then sign off by running **`/start-milestone docs/prd/00-<module> supervised`** — tickets publish as tracker issues and the pipeline runs the first ticket to a CLEAR verdict, then stops for your merge. Re-run to continue (closed issues are skipped automatically).
6. **Graduate**: when the supervised runs hold, flip `CLAUDE.md` to `Operating mode: autonomous` — from then on, one `/start-milestone` runs the whole module: plan → build → fresh-context review (bounce-capped) → merge on CLEAR → issue closed → Definition-of-Done verified, with no per-ticket approvals.
7. **Gate 2**: when that PRD's tasks are done, you smoke-test the result. That is your only test duty — the agents own unit/integration/E2E throughout.
8. Optional: arm the **nightly sweep** (pattern `INSTALL.md` § Nightly sweep) — overnight issue triage/fix/report while the machine is on.
8b. Optional: mirror the work into **Asana**. `adopt` already installed the integration; it does nothing until you export `ASANA_TOKEN` and run **`/connect-asana <asana-task-url>`**, pointing it at an existing Asana task that stands for this repo. Modules then become subtasks of it and tickets become subtasks of those. Asana is a reporting mirror, **never a gate** — it is deliberately outside the Definition of Done, so a token problem cannot fail a delivered ticket (it escalates instead). Mapping, the API reference, and the accepted cost of that subtask depth: [integrations/asana/README.md](integrations/asana/README.md).
9. **The next phase.** Gate 2 ends a *delivery*, not the project. Write `docs/PRD-02-<name>.md`, run **`/breakdown-prd docs/PRD-02-<name>.md`**, then **`/start-all`** again. The new phase decomposes into the **same** `docs/prd/` tree — one root is what lets `/start-all` schedule a single global DAG and lets a new ticket be `blocked_by` a delivered one. Everything already delivered is frozen (the command checks it against git) and filtered out of the run because its issues are closed. Gates 1 and 2 repeat for the new phase.

## 3. Existing project

Same `adopt.mjs` run — skip-existing protects your files. The differences:

**Updating to a newer catalog version:** a plain re-run only adds files that don't exist yet; it will not update a file the previous version already installed. To pull the latest, re-run with `--force` (it overwrites, including `.claude/settings.json`), so commit first and review the diff to re-apply local customizations:

```
git add -A && git commit -m "checkpoint before agent-templates update"
npx agent-templates@latest adopt three-agent-architect-builder-reviewer . --force
git diff
```

`--force` refreshes the scaffold and tracker/settings files, but not the `CLAUDE.md` pipeline section or `.gitattributes` (both marker-guarded) — re-apply any pipeline-rule changes from a release by hand.


- `CLAUDE.md` gets the snippet **appended**: read the merged result once and resolve contradictions with your existing rules (the pipeline rules assume no agent judges its own work).
- An existing `.claude/settings.json` is kept; merge the scaffold's `hooks.PreToolUse` (write guard) and `permissions.allow` entries by hand. Integration rules are the exception — adopt merges those additively (e.g. the Asana script's allow entry), because an un-allowlisted deterministic script prompts on every call and would break autonomous and headless runs.
- Formalize `docs/PRD.md` for the area you will pipeline first — it can cover a single module; you do not need to spec the whole codebase to start.
- Retrofit gradually: run one small module through `supervised` mode end to end before trusting `autonomous`. Your existing test suite becomes the Builder/Reviewer suite from day one.

## 4. Distributing the catalog

The repo is public, so distribution has two tiers:

1. **npx from git — works for everyone, today, zero infra.** The `npx github:…` command above needs no credentials and no publishing. Pin `#main` or a tag for reproducibility.
2. **Public npm — the release tier (LIVE).** Published as [`agent-templates`](https://www.npmjs.com/package/agent-templates) (MIT, maintainer decision 2026-07-17, issue #15). Anonymous installs, semver pinning that pairs with the catalog's expiry discipline (a published version = a verified snapshot of the recommendations), and a natural companion to a future GitHub Pages catalog site.

**Why not GitHub Packages:** its npm registry requires an access token **even to install public packages** — "You need an access token to publish, install, and delete private, internal, and public packages" (GitHub docs, *Working with the npm registry*, verified live 2026-07-17) — and it supports scoped names only. That defeats frictionless public sharing; it remains the right choice only for private-org registries, which this catalog no longer needs.

## 5. Day-2 operations

- `/verify-delivery <ticket>` after every merge (automatic in autonomous mode) — delivery is verified, never assumed.
- Nightly sweep for open issues; hand-written issues follow the installed templates so triage can convert them.
- **Pattern-level problems go upstream**: if the pipeline itself misbehaves, file an issue on this catalog (templates provided) — its own nightly sweep triages pattern-tweak requests.
- Re-verify the pattern's model/effort table when its expiry triggers (successor model or +6 months).
