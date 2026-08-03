# agent-templates

[![npm](https://img.shields.io/npm/v/agent-templates)](https://www.npmjs.com/package/agent-templates) · [![test](https://github.com/Ruihang2017/agent-templates/actions/workflows/test.yml/badge.svg)](https://github.com/Ruihang2017/agent-templates/actions/workflows/test.yml) · **[Catalog site →](https://ruihang2017.github.io/agent-templates/)**

Catalog of reusable multi-agent development architecture patterns. Each entry is a design write-up plus drop-in scaffolding (subagent definitions, slash commands, CLAUDE.md snippets) so a new project reuses a proven pattern instead of redesigning one.

## Quickstart — from a bare `PRD.md` to a running pipeline

```
cd path\to\my-project        # contains PRD.md; git init + remote done; gh/glab authenticated
npx agent-templates@latest adopt three-agent-architect-builder-reviewer .
```

(Also works: `npx github:Ruihang2017/agent-templates …` for the unreleased latest, or `node scripts/adopt.mjs …` from a checkout.)

1. Review `CLAUDE.md`: add project facts, keep **Operating mode: `supervised`**; fill the PR template's Constraint check from your non-negotiables.
2. In Claude Code, inside the project: **`/breakdown-prd`** — the Architect turns `docs/PRD.md` into sub-PRDs + tickets, then stops for your review.
3. **Gate 1** — review the breakdown, then **`/start-milestone docs/prd/00-<module> supervised`**: tickets publish as tracker issues; each ticket runs plan → build → fresh-context review to CLEAR, pausing for your merge.
4. When it holds, flip to `autonomous` — whole milestones run hands-off. **Gate 2** = your smoke test at the end. Full guide: [ADOPTING.md](ADOPTING.md).

### Adding work after Gate 2

A project doesn't end at Gate 2. The next phase gets its own PRD **document** — the ticket **tree** stays single, because `/start-all` schedules one global DAG and a cross-phase dependency only resolves inside it.

```
docs/PRD-02-billing.md                       # write the next phase's PRD
/breakdown-prd docs/PRD-02-billing.md        # appends modules; delivered work is frozen
/start-all autonomous 4                      # phase 1's issues are closed -> only the new tickets run
```

`/breakdown-prd` hands the Architect the next module prefix and the ticket ids already in use, then enforces against git that nothing pre-existing under `docs/prd/` was modified or deleted — only added. A new ticket may be `blocked_by` a delivered one. Gate 1 and Gate 2 run again for the new phase.

### Updating an existing install

Re-run adopt with `--force` to pull the latest catalog version. A plain re-run only adds new files (existing ones are skipped); `--force` overwrites changed ones. Because it overwrites (including `.claude/settings.json`), commit first, then review the diff and re-apply any local customizations:

```
git add -A && git commit -m "checkpoint before agent-templates update"
npx agent-templates@latest adopt three-agent-architect-builder-reviewer . --force
git diff        # re-apply your customizations (esp. .claude/settings.json)
```

`--force` refreshes the scaffold and tracker/settings files. It does **not** rewrite the `CLAUDE.md` pipeline section or `.gitattributes` (both marker-guarded, so a re-run reports them as already present) — if a release changes the pipeline rules in the snippet, re-apply those by hand.

| Pattern | Status | As of | Summary |
|---|---|---|---|
| [three-agent-architect-builder-reviewer](patterns/three-agent-architect-builder-reviewer/README.md) | trialed | 2026-08-04 | Architect plans → Builder implements → independent Reviewer (fresh context, different model tier) clears or bounces; `/start-milestone` runs a whole module autonomously |

## Commands (three-agent-architect-builder-reviewer)

Installed into your project by `adopt`; run them in Claude Code. Full list is generated on the [catalog site](https://ruihang2017.github.io/agent-templates/) from the same source.

| Command | Argument | What it does |
|---|---|---|
| `/breakdown-prd` | `[prd-path] [focus notes]` | Decompose a PRD (default `docs/PRD.md`) into sub-PRDs + template-compliant tickets (pre-Gate-1 planning). Point it at a phase PRD to append work after Gate 2. |
| `/start-milestone` | `<module dir> [supervised\|autonomous] [concurrency]` | Gate 1 for one module — publish its tickets as tracker issues, then run the milestone pipeline (parallel lanes when `concurrency > 1`). |
| `/start-all` | `[supervised\|autonomous] [concurrency]` | Gate 1 for the **whole PRD** — compute the module DAG, publish every module, run all modules in dependency order. |
| `/plan-ticket` | `<ticket-id>` | Architect stage on a ticket. |
| `/build-ticket` | `<ticket-id>` | Builder stage on a planned ticket. |
| `/review-ticket` | `<ticket-id> [ref]` | Reviewer stage on a built ticket (fresh context required). |
| `/verify-delivery` | `<ticket-id>` | Post-merge Definition-of-Done check — verifies delivery instead of assuming it. |
| `/nightly-issues` | `[max-issues]` | Unattended sweep — triage open issues, auto-fix the fixable ones through the pipeline, post a morning report (headless `claude -p`). |
| `/connect-asana` | `[asana-task-url]` | **Optional integration** (installed for every pattern, inert until run) — bind this repo to an Asana task so milestones and tickets mirror as Asana subtasks. See [integrations/asana](integrations/asana/README.md). |

### Parallel delivery (opt-in)

`/start-milestone` and `/start-all` take an optional **`concurrency`** (default `1`). One number decides the shape:

- **`1` (default)** — sequential: one ticket at a time (plan → build → review → deliver). The original behaviour, unchanged.
- **`N` (autonomous only)** — independent (non-blocking) tickets run **concurrently**, scheduled from the ticket dependency DAG by the deterministic workflow (not ad-hoc main-session juggling).

```
/start-milestone docs/prd/01-foundation autonomous 4   # up to 4 parallel lanes within the module
/start-all autonomous 4                                # parallel within each module; modules stay sequential in DAG order
```

How a parallel run stays correct:

- Each independent ticket runs in its **own isolated git worktree** — builder and reviewer work there (the reviewer detached-checkouts the builder's commit), so concurrent lanes never clash on the working tree. The Architect writes the plan on the main tree and its content is passed to the isolated builder (a worktree can't see the git-ignored plan).
- **Deliver is serialized** — merges to the default branch never overlap; a hidden file-scope overlap surfaces as a merge conflict → abort → escalate, so nothing lands broken.
- A failed ticket **cascades to skip its dependents**; an impossible dependency (a cycle) fails loudly instead of hanging. `supervised` is forced to `1` (it opens a PR and waits for a human merge).

Two honest limits: `concurrency > 1` **multiplies concurrent token spend** (opt in per run), and real parallelism is **bounded by the DAG** — a deep dependency chain can't parallelize, a wide fan-out can — and by the harness's `min(16, cores − 2)` concurrent-agent cap. The design was validated by a sandbox git experiment before it shipped.

## Integrations (universal — installed with every pattern)

Optional add-ons that ship with all patterns and arrive **inert**: the files install, and nothing happens until you run their `/connect-*` command.

| Integration | Command | What it does |
|---|---|---|
| [asana](integrations/asana/README.md) | `/connect-asana` | Mirrors milestones and tickets into Asana as subtasks of an existing Asana task, and completes a ticket's subtask when it is delivered. Needs an `ASANA_TOKEN` env var. |

Asana is a **reporting mirror, never a gate** — it is deliberately not part of the Definition of Done, so an expired token can never fail a delivered ticket. All writes go through a deterministic script rather than Asana's MCP server; the reasons (headless runs, the issue #26 classifier precedent, testability) are in the integration's README.

- **Applying a pattern to your project** (new — even a bare `PRD.md` — or existing): [ADOPTING.md](ADOPTING.md) — one command: `node scripts/adopt.mjs <pattern> <target-dir>`
- Operating manual, pattern schema, grounding rules: [CLAUDE.md](CLAUDE.md)
- Adding a pattern: start from [templates/pattern-README.template.md](templates/pattern-README.template.md), process in [CLAUDE.md](CLAUDE.md) § "Adding a new pattern"
- E2E testing for the pattern chain: [testbed/README.md](testbed/README.md) — `node testbed/e2e/run-e2e.mjs` is the merge gate for scaffold changes

## CI & releasing

CI ([`.github/workflows/test.yml`](.github/workflows/test.yml)) runs the E2E suite on every PR and push to `main`, across ubuntu + windows × Node 18/20 — the merge gate is enforced server-side and cross-platform.

Releases publish from a version tag ([`.github/workflows/publish.yml`](.github/workflows/publish.yml)): bump `package.json` via a PR, merge, then

```
git tag vX.Y.Z && git push origin vX.Y.Z   # X.Y.Z = the version in package.json
```

CI re-runs the E2E gate, checks the tag matches `package.json`, and publishes to npm.

**Track record, so you know what to expect:** as of 2026-07-29 this workflow has run twice and **published nothing** — `v0.8.0` and `v0.9.0` both failed with `npm error code EOTP`. Both times the workflow was correct (gates passed, tarball built, registry refused the token) and the version shipped by the manual fallback below. Treat the tag path as the intended route, not a proven one, until a run goes green.

**One-time setup:** add an `NPM_TOKEN` repo secret (Settings → Secrets and variables → Actions). It must be a **Granular Access Token** with *Read and write* on this package — **not** a Classic token. npm restricts classic tokens that bypass 2FA for direct publishing, so with the wrong type CI passes both gates, builds the tarball, and only then fails with `npm error code EOTP` ("requires a one-time password"), which no CI runner can supply. That is the single most likely cause of a tagged release failing at the last step — and it is not detectable earlier: `npm whoami` succeeds for both token types and `npm publish --dry-run` never touches auth.

**Retrying a failed release:** don't delete or re-push the tag, and don't bump the version — the tag already points at the right commit. Fix the secret, then Actions → **publish** → **Run workflow** → enter the tag (e.g. `v0.9.0`). The tag-matches-version gate still runs, so a dispatch against the wrong ref fails closed.

**Manual fallback** — this is how every release since 0.7.0 has actually shipped, so it is a supported step, not a workaround. From a clean checkout of the tag:

```
git checkout main && git pull            # HEAD must be the tagged commit
npm publish                              # prompts for your OTP interactively
```

Publishing locally works precisely where CI cannot: you can answer the one-time-password prompt. Afterwards, confirm with `npm view agent-templates version`.

## License

MIT — see [LICENSE](LICENSE). Carve-out: files installed **into your project** by `adopt.mjs` (the scaffold, templates, and anything generated from them) may be used in your projects without attribution.
