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
| [three-agent-architect-builder-reviewer](patterns/three-agent-architect-builder-reviewer/README.md) | trialed | 2026-07-17 | Architect plans → Builder implements → independent Reviewer (fresh context, different model tier) clears or bounces; `/start-milestone` runs a whole module autonomously |

## Commands (three-agent-architect-builder-reviewer)

Installed into your project by `adopt`; run them in Claude Code. Full list is generated on the [catalog site](https://ruihang2017.github.io/agent-templates/) from the same source.

| Command | Argument | What it does |
|---|---|---|
| `/breakdown-prd` | `[focus notes]` | Decompose `docs/PRD.md` into sub-PRDs + template-compliant tickets (pre-Gate-1 planning). |
| `/start-milestone` | `<module dir> [supervised\|autonomous] [concurrency]` | Gate 1 for one module — publish its tickets as tracker issues, then run the milestone pipeline (parallel lanes when `concurrency > 1`). |
| `/start-all` | `[supervised\|autonomous] [concurrency]` | Gate 1 for the **whole PRD** — compute the module DAG, publish every module, run all modules in dependency order. |
| `/plan-ticket` | `<ticket-id>` | Architect stage on a ticket. |
| `/build-ticket` | `<ticket-id>` | Builder stage on a planned ticket. |
| `/review-ticket` | `<ticket-id> [ref]` | Reviewer stage on a built ticket (fresh context required). |
| `/verify-delivery` | `<ticket-id>` | Post-merge Definition-of-Done check — verifies delivery instead of assuming it. |
| `/nightly-issues` | `[max-issues]` | Unattended sweep — triage open issues, auto-fix the fixable ones through the pipeline, post a morning report (headless `claude -p`). |

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

- **Applying a pattern to your project** (new — even a bare `PRD.md` — or existing): [ADOPTING.md](ADOPTING.md) — one command: `node scripts/adopt.mjs <pattern> <target-dir>`
- Operating manual, pattern schema, grounding rules: [CLAUDE.md](CLAUDE.md)
- Adding a pattern: start from [templates/pattern-README.template.md](templates/pattern-README.template.md), process in [CLAUDE.md](CLAUDE.md) § "Adding a new pattern"
- E2E testing for the pattern chain: [testbed/README.md](testbed/README.md) — `node testbed/e2e/run-e2e.mjs` is the merge gate for scaffold changes

## CI & releasing

CI ([`.github/workflows/test.yml`](.github/workflows/test.yml)) runs the E2E suite on every PR and push to `main`, across ubuntu + windows × Node 18/20 — the merge gate is enforced server-side and cross-platform.

Releases publish from a version tag ([`.github/workflows/publish.yml`](.github/workflows/publish.yml)): bump `package.json`, then

```
git tag vX.Y.Z && git push origin vX.Y.Z   # X.Y.Z = the version in package.json
```

CI re-runs the E2E gate, checks the tag matches `package.json`, and publishes to npm. **One-time setup:** add an `NPM_TOKEN` repo secret (Settings → Secrets and variables → Actions).

## License

MIT — see [LICENSE](LICENSE). Carve-out: files installed **into your project** by `adopt.mjs` (the scaffold, templates, and anything generated from them) may be used in your projects without attribution.
