# Adopting a pattern

How to apply a pattern from this catalog to a **new** project (even a folder holding nothing but a `PRD.md`) or an **existing** one.

## 0. Pick the pattern

Check the index in [README.md](README.md), then the pattern's own §1 **When to use / when not to use** — take the "not" side seriously. Check the pattern's expiry trigger (metadata table); do not copy an expired model/effort table without re-verifying it.

## 1. Install — one command

Without cloning the catalog (npm's git-specifier support; private repos ride your existing git credentials):

```
npx github:Ruihang2017/agent-templates adopt three-agent-architect-builder-reviewer C:\path\to\your-project
```

Pin a branch or tag for reproducibility: `npx github:Ruihang2017/agent-templates#main …`. Note npx caches git installs — add `--yes --prefer-online` (or clear the npx cache) to pick up catalog updates.

Or from a checkout of this catalog:

```
node scripts/adopt.mjs three-agent-architect-builder-reviewer C:\path\to\your-project
```

Idempotent (re-runs skip what exists; `--force` overwrites). It installs the scaffold `.claude/` (agents with pinned model/effort, stage commands, write guard, workflows, publish script), the universal `templates/ticket.template.md`, the platform tracker templates (`--platform gh|glab`, autodetected from the origin remote) into `.github/` or `.gitlab/`, creates `docs/prd|adr|plans/`, copies a root `PRD.md` to `docs/PRD.md`, and seeds or appends `CLAUDE.md` from the pattern snippet (marker-checked, never duplicated).

## 2. New project from a bare PRD.md — end to end

Preconditions: git repo + remote, authenticated tracker CLI (`gh auth login` / `glab auth login`), Node ≥ 18, Claude Code.

1. `git init`, create the remote (e.g. `gh repo create`), commit `PRD.md`.
2. Run `adopt.mjs` (above) — then commit the scaffolding.
3. Review `CLAUDE.md`: add your project facts and non-negotiables above the pipeline section; keep **Operating mode: `supervised`** for now. Fill the **Constraint check** section of `.github/PULL_REQUEST_TEMPLATE.md` (or the GitLab MR template) from those non-negotiables.
4. In Claude Code, in the project: **`/breakdown-prd`** — the Architect decomposes `docs/PRD.md` into `docs/prd/breakdown-plan.md` + sub-PRDs + template-compliant tickets (disjoint file-scopes, dependency DAG), then stops.
5. **Gate 1 — your product judgment moment.** Review the breakdown: module boundaries, non-goals, the DAG, open questions. Edit/ask until right. Then sign off by running **`/start-milestone docs/prd/00-<module> supervised`** — tickets publish as tracker issues and the pipeline runs the first ticket to a CLEAR verdict, then stops for your merge. Re-run to continue (closed issues are skipped automatically).
6. **Graduate**: when the supervised runs hold, flip `CLAUDE.md` to `Operating mode: autonomous` — from then on, one `/start-milestone` runs the whole module: plan → build → fresh-context review (bounce-capped) → merge on CLEAR → issue closed → Definition-of-Done verified, with no per-ticket approvals.
7. **Gate 2**: when the PRD's tasks are done, you smoke-test the result. That is your only test duty — the agents own unit/integration/E2E throughout.
8. Optional: arm the **nightly sweep** (pattern `INSTALL.md` § Nightly sweep) — overnight issue triage/fix/report while the machine is on.

## 3. Existing project

Same `adopt.mjs` run — skip-existing protects your files. The differences:

- `CLAUDE.md` gets the snippet **appended**: read the merged result once and resolve contradictions with your existing rules (the pipeline rules assume no agent judges its own work).
- An existing `.claude/settings.json` is kept; merge the scaffold's `hooks.PreToolUse` (write guard) and `permissions.allow` entries by hand.
- Formalize `docs/PRD.md` for the area you will pipeline first — it can cover a single module; you do not need to spec the whole codebase to start.
- Retrofit gradually: run one small module through `supervised` mode end to end before trusting `autonomous`. Your existing test suite becomes the Builder/Reviewer suite from day one.

## 4. Distributing the catalog to your team

Three tiers, in order of effort:

1. **npx from git (now, zero infra):** anyone with read access to this repo runs the `npx github:…` command above — their git credentials authenticate; nothing is published anywhere. Good for a team that already shares the repo.
2. **GitHub Packages (versioned, still private):** publish scoped releases (`@<org>/agent-templates`) to the org's GitHub npm registry — teammates authenticate with their GitHub tokens and can pin exact versions (`npx @<org>/agent-templates@0.2.0 …`), which pairs well with the catalog's expiry discipline (a version = a verified snapshot of recommendations).
3. **Public npm** — only if the catalog is meant to leave the company.

Also worth deciding once: this repo currently lives under a personal account (`Ruihang2017`). If the team is the audience, moving it to the org account gives access control, continuity, and org-level tokens for tier 2. Maintainer's call — recorded as an open follow-up in issue #11.

## 5. Day-2 operations

- `/verify-delivery <ticket>` after every merge (automatic in autonomous mode) — delivery is verified, never assumed.
- Nightly sweep for open issues; hand-written issues follow the installed templates so triage can convert them.
- **Pattern-level problems go upstream**: if the pipeline itself misbehaves, file an issue on this catalog (templates provided) — its own nightly sweep triages pattern-tweak requests.
- Re-verify the pattern's model/effort table when its expiry triggers (successor model or +6 months).
