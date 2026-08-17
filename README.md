# agent-templates

[![npm](https://img.shields.io/npm/v/agent-templates)](https://www.npmjs.com/package/agent-templates) · [![test](https://github.com/Ruihang2017/agent-templates/actions/workflows/test.yml/badge.svg)](https://github.com/Ruihang2017/agent-templates/actions/workflows/test.yml) · **[Catalog site →](https://ruihang2017.github.io/agent-templates/)**

Catalog of reusable multi-agent development architecture patterns. Each entry is a design write-up plus drop-in scaffolding (subagent definitions, commands or skills, and runtime guidance) so a new project reuses a proven pattern instead of redesigning one.

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
| [codex-three-agent-architect-builder-reviewer](patterns/codex-three-agent-architect-builder-reviewer/README.md) | proposed | 2026-08-11 | Codex-native port of the same assurance topology using project custom agents + repo skills; global DAG execution is sequential in v1 because parallel Builders are not worktree-isolated |
| [hub-and-spoke-orchestrator-executors](patterns/hub-and-spoke-orchestrator-executors/README.md) | proposed | 2026-08-10 | One Opus hub writes contract-first briefs → N headless `codex exec` spokes implement one each in isolated worktrees → the same hub audits, reviews and merges. Optimised for cost and throughput; **the review is deliberately not independent** |

**Which one.** First choose the runtime; then choose the assurance/throughput tradeoff:

| | Claude three-agent | Codex three-agent | hub-and-spoke |
|---|---|---|---|
| Reviewer | independent, fresh Claude context | independent, fresh read-only Codex subagent | the same hub session that wrote the contract |
| Implementers | Claude Builder; parallel worktree lanes available | Codex Builder; sequential v1 | N headless Codex executors in parallel |
| Optimised for | assurance + mature automation | assurance on the Codex runtime | throughput and token cost |
| Use it when | a bad merge is expensive and Claude Code is the host | a bad merge is expensive and Codex is the host | a bad merge is cheap to revert, and the work fans out |
| Tracker integration | issues + PRs, full evidence trail | issues + PRs, full evidence trail | none — briefs and branches are the record |

If a bad merge would hurt, use the three-agent pattern. Its independent reviewer is the thing hub-and-spoke trades away.

## Before you adopt

| | Claude three-agent | Codex three-agent | hub-and-spoke |
|---|---|---|---|
| Host | Claude Code | Codex CLI | Claude Code **and** the Codex CLI on `PATH` |
| Node | ≥ 18 | ≥ 18 | ≥ 18 |
| Git | repo with ≥ 1 commit | same | same, plus `git worktree` (git ≥ 2.5) |
| Tracker CLI | `gh` or `glab`, authenticated | same | **none** — it has no tracker |
| Your project needs | a `docs/PRD.md` (or a root `PRD.md` — adopt copies it) | same | same, plus a **per-module** test command |

`adopt` is idempotent and refuses to guess: with no git remote and no `--platform`, it installs **nothing** and tells you to re-run with `--platform gh|glab`. For a tracker-less pattern it does not ask at all.

## What lands in your repo

```
.claude/                       # (or .codex/ + .agents/ for the Codex pattern)
  agents/                      # role definitions — who may write what
  commands/                    # the slash commands below
  scripts/                     # deterministic steps: publish, DAG, deliver
  workflows/                   # the autonomous runners
  settings.json                # permission allowlist + the write guard
CLAUDE.md                      # (or AGENTS.md) pipeline rules, appended once
templates/ticket.template.md   # the ticket format the Architect must follow
.github/ or .gitlab/           # issue + PR/MR templates
docs/PRD.md · docs/prd/ · docs/adr/ · docs/plans/
.gitattributes · .gitignore    # eol pins and scratch rules, appended once
```

Nothing is overwritten on a re-run. `--force` overwrites changed files, including `settings.json` — commit first, then re-apply your customisations from the diff.

## Your first run, and what you will actually see

```
npx agent-templates@latest adopt three-agent-architect-builder-reviewer .
```

**1 · Write the PRD.** `docs/PRD.md`. Requirements and constraints, not a design. The Architect turns it into modules and tickets.

**2 · `/breakdown-prd`** — the Architect reads the PRD, the codebase and any ADRs, then writes `docs/prd/<module>/README.md` sub-PRDs and `docs/prd/<module>/tickets/*.md`, plus `docs/prd/dag.html` — a self-contained dependency graph you open by double-clicking. **It stops there.** It does not write code, and it tells you the concurrency worth passing rather than making you guess.

**3 · Gate 1 — you decide.** Read the tickets. This is the cheapest moment to fix a wrong decomposition; everything downstream assumes it is right. Then:

```
/start-milestone docs/prd/00-foundation supervised
```

Tickets become tracker issues, and one ticket runs plan → build → fresh-context review. `supervised` opens a PR and **stops for your merge**, so you see the shape before trusting it.

**4 · Flip to autonomous.** `/start-all autonomous 4` runs the whole PRD, scheduled from one dependency DAG, four parallel lanes. Each ticket merges only on a CLEAR verdict from a reviewer that never saw the Builder's session.

**5 · Gate 2 — smoke test.** The agents own unit, integration and E2E throughout. You test once, when the PRD's tickets are all delivered.

## What the agents will not do

These are enforced by config and deterministic scripts, not by asking politely:

- **No agent judges its own work.** The Reviewer runs in a fresh context on a different model tier from the Builder.
- **The Architect writes no production code**, and the Builder never merges without a CLEAR verdict.
- **A required-but-unmet check escalates; it never force-lands.** A failed pipeline stops delivery rather than bypassing the gate.
- **Delivery refuses a dirty working tree**, and refuses to open a PR whose diff removes ≥200 lines and ≥5× what it adds — the signature of a stale branch that would revert your default branch.
- **The main session cannot write production files** while a pipeline is installed (a `PreToolUse` guard), so orchestration cannot quietly become implementation.

## When something goes wrong

Every row here is a defect that was reported from a real repo and is now fixed — they are listed because the *symptom* is rarely obvious.

| Symptom | Cause | What to do |
|---|---|---|
| Every ticket ends "not delivered" but the code **is** on `main` and the issues are closed | Delivery was confirmed by git ancestry, which is permanently false under squash-on-merge | Upgrade to ≥ 0.12.0 |
| A merge request appears proposing to delete thousands of lines, with **no conflict** | A leftover `ticket/*` branch cut from an older `main` was re-pushed | Upgrade to ≥ 0.12.0 — delivery now refuses to open it, and `/start-all` cleans up after itself |
| `glab mr merge` fails with `400 SHA must be provided` or `405` | Missing `--sha`; merging before GitLab finished computing mergeability | Upgrade to ≥ 0.12.0 |
| Delivery refuses: "working tree not clean" and `git status` shows only `docs/prd/dag.html` | Windows CRLF vs the LF the generator writes — the file is modified with an **empty** diff | Upgrade to ≥ 0.12.0, then re-adopt so the `.gitattributes` rule lands |
| Duplicate tracker issues, or duplicate Asana subtasks | A paginated list was silently truncated, so existing items read as "never created" | Upgrade to ≥ 0.13.0 |
| A publish fails with `ENAMETOOLONG` on Windows | A large ticket body travelled through the command line | Upgrade to ≥ 0.12.0 |
| Tickets already delivered get planned and built again mid-run | The mid-run DAG rescan did not apply the closed-issue filter | Upgrade to ≥ 0.12.0 |
| The forge is down, or its policy blocks every merge | — | Run with `none`: finish locally, publish afterwards (below) |

Anything else: the pattern READMEs' **§4 Known failure modes** carry the full list with dates and mitigations, and `.github/ISSUE_TEMPLATE/` is wired for reports.

## Skills (codex-three-agent-architect-builder-reviewer)

Install with `npx agent-templates@latest adopt codex-three-agent-architect-builder-reviewer .`, then invoke repo skills in Codex with `$`, for example `$breakdown-prd`, `$run-ticket ABC-1`, or `$start-all supervised`. See the [pattern README](patterns/codex-three-agent-architect-builder-reviewer/README.md) for the complete surface and the sequential-v1 boundary.

## Commands (three-agent-architect-builder-reviewer)

Installed into your project by `adopt`; run them in Claude Code. Full list is generated on the [catalog site](https://ruihang2017.github.io/agent-templates/) from the same source.

| Command | Argument | What it does |
|---|---|---|
| `/breakdown-prd` | `[prd-path] [focus notes]` | Decompose a PRD (default `docs/PRD.md`) into sub-PRDs + template-compliant tickets (pre-Gate-1 planning). Point it at a phase PRD to append work after Gate 2. |
| `/start-milestone` | `<module dir> [supervised\|autonomous] [concurrency]` | Gate 1 for one module — publish its tickets as tracker issues, then run the milestone pipeline (parallel lanes when `concurrency > 1`). |
| `/start-all` | `[supervised\|autonomous] [concurrency] [none]` | Gate 1 for the **whole PRD** — compute the module DAG, publish every module, run all modules in dependency order. Add `none` for local delivery: no tracker, no push, publish afterwards. |
| `/publish-tickets` | `<module dir> [--all]` | Publish only — create the tracker issues (and Asana subtasks if connected), then **stop**. For populating the board before any work starts. |
| `/plan-ticket` | `<ticket-id>` | Architect stage on a ticket. |
| `/build-ticket` | `<ticket-id>` | Builder stage on a planned ticket. |
| `/review-ticket` | `<ticket-id> [ref]` | Reviewer stage on a built ticket (fresh context required). |
| `/verify-delivery` | `<ticket-id>` | Post-merge Definition-of-Done check — verifies delivery instead of assuming it. |
| `/nightly-issues` | `[max-issues]` | Unattended sweep — triage open issues, auto-fix the fixable ones through the pipeline, post a morning report (headless `claude -p`). |
| `/connect-asana` | `[asana-task-url]` | **Optional integration** (installed for every pattern, inert until run) — bind this repo to an Asana task so milestones and tickets mirror as Asana subtasks. See [integrations/asana](integrations/asana/README.md). |

## Commands (hub-and-spoke-orchestrator-executors)

Installed by `npx agent-templates@latest adopt hub-and-spoke-orchestrator-executors .`. This pattern needs the **Codex CLI** on `PATH` — it is a hard dependency, not an accelerator.

| Command | Argument | What it does |
|---|---|---|
| `/hub-brief` | `[prd-path] [focus notes]` | Hub stage 1 — decompose a PRD into contract-first task briefs in `docs/briefs/`, then stop at Gate 1. |
| `/hub-dispatch` | `[briefs-dir] [concurrency] [--dry-run]` | Hub stage 2 — validate every brief, then fan the ready ones out to headless `codex exec`, one isolated worktree each. |
| `/hub-collect` | `[briefs-dir] [--all \| ID ...] [--merge]` | Hub stage 3 — re-audit each spoke branch, re-run its tests, review the diff, merge only what clears the deterministic gate. |

Three properties worth knowing before adopting it:

- **All-or-nothing dispatch.** One invalid brief dispatches nothing. A bad decomposition is a hub problem, and low-effort executors will not notice it.
- **`quarantined` outranks green tests.** A spoke that passed its tests while writing outside its declared file-scope does not merge — passing tests is exactly what would otherwise wave it through.
- **`unverified` is not a pass.** A branch whose tests could not be re-run does not merge.

### Merging a docs change (not a ticket)

The pipeline generates merge requests that are not deliveries: spec amendments, sub-PRD bumps, ticket corrections, README updates. There is a sanctioned path for those, and using it matters for a reason that is easy to miss:

```
node .claude/scripts/merge-docs-mr.mjs --title "docs: amend FR-3" [--body-file notes.md] [--no-merge]
```

**It does not poll.** `glab mr merge` enables auto-merge by default and `gh pr merge --auto` is the GitHub equivalent — issue the merge once and the forge lands it when its checks pass. Left to improvise, an agent writes a wait-for-CI loop instead: one measured run burned **~4,000 tokens** printing a status line every 15 seconds while a documentation merge waited on a 4–9 minute pipeline, and nothing was learned from any line except the last. A phase that produces five docs MRs pays that five times.

It deliberately carries **none** of the ticket machinery — no Reviewer verdict comment, no `Closes #N`, no tracker close, no Definition-of-Done check. That is what distinguishes a docs change from a delivery, and why reusing `deliver-ticket.mjs` here would be wrong: it would record a delivery that never happened.

It does keep the destructive-diff guard. A docs branch cut before a large merge produces the same revert-shaped diff as a stale ticket branch — one measured at `+99 / -7688`.

### Local delivery — finish first, publish later (opt-in)

`/start-all` and `/start-milestone` accept `platform: 'none'`, which drives every ticket to the **local** default branch and touches no forge: no push, no PR/MR, no tracker.

```
/start-all autonomous 1 none
```

Why it exists: every delivery defect this catalog has recorded lives at the forge boundary — a pipeline gate, a protected branch, a 403 MR API, squash-merge ancestry, an expired token — and each one stops the whole run. The pattern's value is the Architect → Builder → fresh Reviewer chain; the forge is how the result is *published*. `none` decouples them.

**Review is unchanged.** A ticket still only merges on CLEAR. What is deferred is publication, not judgement.

What replaces the tracker: a committed ledger at `docs/delivered.json` recording each delivered ticket and the commit it landed as. That is the resume signal — a re-run executes only the new work — and it is what you or an agent read afterwards to know what still needs pushing. The run ends with an explicit handoff naming the exact command to publish, because a mode that quietly accumulates work on one machine is indistinguishable from work nobody can see.

### Two runtimes, one project

A project may install **both** three-agent patterns — Claude Code and Codex — side by side. They do not collide: `.claude/` + `CLAUDE.md` sit beside `.codex/` + `.agents/` + `AGENTS.md`.

```
npx agent-templates@latest adopt three-agent-architect-builder-reviewer .
npx agent-templates@latest adopt codex-three-agent-architect-builder-reviewer .
```

They share exactly what is the *project* rather than the runtime — the `docs/prd/` ticket tree, the `[<id>]` tracker title prefix, `ticket/<ID>` branch names, `docs/plans/`, and the delivery ledger. So a ticket planned in one runtime and built in the other works, and a teammate can switch runtimes mid-project on a token budget without development stalling.

No hybrid pattern is needed, and none is offered: it would add a third scaffold to maintain and a §3 model table pinning two vendors at once, for no capability these two installs lack.

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

**Track record, so you know what to expect.** As of 2026-08-11 the tag path has **published nothing — 0/4**: `v0.8.0`, `v0.9.0` and `v0.10.0` all failed with `npm error code EOTP`, and `v0.11.0`/`v0.12.0` were pushed *after* a manual publish, so they correctly **skipped**. Every release since 0.7.0 shipped by the manual fallback below — 0.8.1, 0.9.0, 0.10.0, 0.11.0, 0.12.0, **5/5**. The three failures were the workflow behaving correctly: both gates passed and the registry refused the token at the last step. The workflow itself is now green (the skip path works end to end, verified on `v0.11.0` and `v0.12.0`), but **it has still never actually published** — treat the tag path as the intended route, not a proven one, until a run publishes.

Three consecutive `EOTP` failures is no longer a suspicion about the `NPM_TOKEN` secret — it is evidence. It is still a Classic token, and only a repo admin can replace it (see **One-time setup** below).

**A tag push runs the workflow from the *tagged commit*, not from `main`.** That is why `v0.10.0` failed even though the already-published skip had already merged: the tag deliberately points at the released tree, which predates the fix. Later tags will use it.

Because manual publishing is the path that actually works, pushing a tag for a version **already on the registry** is now the normal case. A tag push therefore has three possible outcomes, and they mean different things:

| Outcome | Meaning |
|---|---|
| **published** | the tag path worked — first time, if it happens |
| **skipped** | the version was already on the registry, so there was nothing to do. Green, with a notice. This is what tagging after a manual publish looks like, and it is **not** a failure. It works **even while the token is broken**: the check uses `npm view`, which needs no auth on a public package, and it runs before `npm publish` — which is exactly why a broken-token run reports `EOTP` rather than a duplicate-version error. Tagging is therefore decoupled from the token entirely |
| **failed** | a real problem. If the log says `npm error code EOTP`, it is the token type — see below |

The skip is checked only *after* the E2E and tag-matches-version gates, so a mismatched tag still fails closed rather than being waved through. A registry lookup that errors also fails the run: "cannot tell" and "already published" are different answers, and treating the first as the second would silently skip a real publish.

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
