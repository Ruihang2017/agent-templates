# agent-templates — Operating Manual

> Auto-loaded into every session in this repo. Conversation with the user may be in Chinese; **every file committed to this repo MUST be in English** (docs, scaffolding, comments, identifiers).

## What this repo is

A library/catalog of the multi-agent development architecture patterns this team reuses across projects. Each pattern is a **self-contained, reusable unit**: a design write-up plus actual working scaffolding (CLAUDE.md snippets, subagent definitions, slash commands) that a new project copies directly instead of redesigning the architecture from scratch.

This repo ships documentation, scaffolding, and a testbed. The only application code is the testbed's toy target app.

**Target operating model** (what patterns are hardened toward): for a project that fits a pattern, humans decide at exactly two gates — upstream (master PRD → sub-PRDs → generated tickets, signed off before the pipeline starts) and downstream (a smoke test of the delivered work). Between those gates the multi-agent workflow runs autonomously. Consequences for this repo: not every project fits every pattern ("when not to use" is a required section, take it seriously), and role boundaries are enforced mechanically wherever possible — hooks and permission config over prose exhortation, because prose alone has already been observed to fail.

**Testing policy** (`[team-policy]`, 2026-07-17, binding on every pattern): the agents own the whole test pyramid — unit, integration, and E2E — run manually or wired into the pipeline as fits the project. The human's only test duty is the final smoke test once the PRD's tasks are all done (Gate 2).

## Layout

```
CLAUDE.md                              # this file — the operating manual
README.md                              # human-facing pattern index
ADOPTING.md                            # how users apply a pattern to new/existing projects
LICENSE                                # MIT (scaffold-output carve-out noted in README § License)
package.json                           # published npm package `agent-templates` (bin + files whitelist)
scripts/
  cli.mjs                              # npx entry point: list · adopt (dispatches to adopt.mjs)
  adopt.mjs                            # one-command pattern installer (idempotent; E2E-tested)
  build-site.mjs                       # generates the GitHub Pages catalog page from pattern data (never hand-edit output)
templates/                             # UNIVERSAL — shared by all patterns and by this repo itself
  pattern-README.template.md           # mandatory starting point for every new pattern
  ticket.template.md                   # the ticket format (field-proven: fx / PIL-15 / FND-9 standard)
  tracker/                             # tracker-native templates: github/ + gitlab/ — issues (bug-report,
                                       #   task, decision-record) and the PR/MR template
patterns/<pattern-name>/               # kebab-case; one directory per pattern
  README.md                            # the write-up — MUST follow the schema below
  scaffold/                            # drop-in files a target repo copies, then adapts
testbed/                               # E2E for the pattern chain (see testbed/README.md)
  e2e/run-e2e.mjs                      # Level 0: deterministic, zero-token — the merge gate for scaffold changes
  app/                                 # Level 1: tiny real target project for live pipeline rehearsals
.claude/                               # self-hosted pattern machinery — byte-synced scaffold copies (see "How this repo develops itself")
.github/ISSUE_TEMPLATE/                # issue templates (from the scaffold) — pattern-tweak requests from other projects land here
```

Worked example — `patterns/three-agent-architect-builder-reviewer/` is the canonical entry; **every future pattern must match its format**:

```
patterns/three-agent-architect-builder-reviewer/
├── README.md                          # schema-compliant write-up (the format reference)
└── scaffold/
    ├── INSTALL.md                     # how to drop the scaffold into a target repo
    ├── claude-md-snippet.md           # block to append to the target repo's CLAUDE.md
    └── .claude/
        ├── settings.json              # PreToolUse write guard wiring
        ├── hooks/
        │   └── guard-main-session-writes.mjs
        ├── scripts/
        │   └── publish-tickets.mjs
        ├── workflows/
        │   ├── run-milestone.js
        │   └── nightly-issues.js
        ├── agents/
        │   ├── architect.md
        │   ├── builder.md
        │   ├── reviewer.md
        │   └── triage.md
        └── commands/
            ├── breakdown-prd.md
            ├── plan-ticket.md
            ├── build-ticket.md
            ├── review-ticket.md
            ├── verify-delivery.md
            ├── start-milestone.md
            └── nightly-issues.md
```

## Pattern README schema (all sections required, in this order)

| Section | Must contain |
|---|---|
| Metadata table (under the title) | Pattern name · status (`proposed` / `trialed` / `adopted` / `deprecated`) · as-of date · expiry trigger · sign-off |
| 1. When to use / when not to use | Concrete task shapes, both directions — not adjectives |
| 2. Agent roles & boundaries | Per agent: what it does / what it must never do; who judges whom |
| 3. Model + effort assignment | Table: role · model · effort · reasoning · source label per claim. Heading carries the as-of date |
| 4. Known failure modes / pitfalls | Symptom · the specific context/harness it was observed in · mitigation · date recorded. "None recorded yet" is a valid honest entry; an invented one is not |
| 5. Upstream / downstream integration | How work enters (master PRD → sub-PRD → ticket, ADRs), what leaves (PR, review verdict, docs), and the **human gates** — where humans decide, and where they must not be needed |
| 6. Scaffold | What is in `scaffold/` and how to install it |
| 7. Provenance & change log | Dated entries: what changed, on what basis, by whom |

Status glossary: `proposed` = drafted, not signed off · `trialed` = signed off as the team standard, awaiting its first real-ticket run · `adopted` = has run ≥ 1 real ticket in a real project, named in the provenance log · `deprecated` = superseded, kept for history.

Upstream docs convention assumed by patterns (exemplar: `fx-eye-tracking`): `docs/PRD.md` (master PRD) → `docs/prd/<module>/README.md` (sub-PRDs) → `docs/prd/<module>/tickets/*.md` (tickets = future issue bodies), plus `docs/adr/` for hard-to-reverse decisions.

## Source labels (mandatory on every model/effort claim)

| Label | Meaning |
|---|---|
| `[official]` | Anthropic docs / system card / model page — verifiable at a URL today |
| `[vendor-benchmark]` | Anthropic-reported benchmark number |
| `[third-party]` | External benchmark or report — name the source |
| `[internal]` | Our own observation — name the harness, project, and date |
| `[unverified]` | Unverified third-party data / needs testing |
| `[team-policy]` | A deliberate team decision — a choice, not a capability claim |

## Adding a new pattern

1. Copy `templates/pattern-README.template.md` → `patterns/<kebab-name>/README.md`. Fill every section; delete none.
2. Build `scaffold/` with actually-runnable files. Verify every config key (agent/command frontmatter, settings) against current Claude Code docs at write time — not from memory.
3. `node testbed/e2e/run-e2e.mjs` must be green before merging any scaffold change; when you add scaffold surface (new files, new orchestration logic), extend the E2E suites to cover it.
4. Open a PR. Status starts at `proposed`.
5. Sign-off to merge: the repo maintainer (Horace Hou) approves schema compliance and grounding. Promotion to `adopted` additionally requires the pattern having run on ≥1 real ticket in a real project, named in the provenance log.
6. Any later change to a model/effort recommendation updates the table **and** the as-of date **and** adds a provenance-log entry — in the same commit.

## How this repo develops itself

1. **Issues are the decision record; commits are only the change record.** Every unit of work starts as a GitHub issue stating what + why (use the universal templates — work items follow `task`/`bug-report`, records follow `decision-record`). The work lands via a PR referencing it (`Closes #N`), written against `.github/PULL_REQUEST_TEMPLATE.md` (byte-synced from `templates/tracker/github/`). **No direct merges to main.** Bootstrap exception: the rounds merged on 2026-07-17 before this rule existed are backfilled as `decision-record` issues #1–#4.
2. **Self-hosted nightly sweep.** This repo runs the pattern's own `/nightly-issues`: other projects file pattern-tweak requests here (templates in `.github/ISSUE_TEMPLATE/`), and the sweep triages — and where fixable, fixes — them overnight. The machinery at `.claude/` (four agents, two workflows, `nightly-issues` + `verify-delivery` commands) is a **byte-synced copy of the scaffold**, enforced by the E2E integrity suite: change the scaffold first, then re-copy.
3. **This repo's test suite** is `node testbed/e2e/run-e2e.mjs` — the Builder/Reviewer run it exactly like any project's tests.
4. The scaffold's main-session write guard is **not installed here** — interactive doc-editing with the maintainer is this repo's norm. Revisit if orchestrator role leakage appears in this repo's own pipeline runs.
5. Labels in use: `decision-record` · `triage:invalid` · `nightly:escalated` · `needs-human`.

## Grounding rules — binding on every agent working in this repo, including Claude

1. **No training-data impressions.** Every model/effort recommendation must be grounded in currently verifiable official documentation (link it), or be explicitly labeled `[unverified]` — "unverified third-party data / needs testing". If you cannot verify it right now, label it; never launder a hunch into a recommendation.
2. **Official conclusions ≠ harness observations.** Keep "conclusion from official docs / system cards" and "phenomenon observed under one specific benchmark harness" visibly distinct (use the source labels). A single-harness observation is never written up as a general conclusion — scope it with harness, conditions, and date.
3. **As-of dates move with recommendations.** Model capability and effort behavior change across versions; every recommendation is traceable, expirable, and updatable — never a permanent conclusion. Whenever a recommendation changes, its as-of date changes in the same commit.
4. **Staleness (default policy, maintainer-adjustable):** a model/effort table expires when a successor to any listed model ships, or 6 months after its as-of date, whichever comes first. Expired ≠ wrong — it means "re-verify before citing or copying into a new project".
5. **English only** in committed files; Chinese is for conversation, never for the repo.
