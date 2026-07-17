# agent-templates — Operating Manual

> Auto-loaded into every session in this repo. Conversation with the user may be in Chinese; **every file committed to this repo MUST be in English** (docs, scaffolding, comments, identifiers).

## What this repo is

A library/catalog of the multi-agent development architecture patterns this team reuses across projects. Each pattern is a **self-contained, reusable unit**: a design write-up plus actual working scaffolding (CLAUDE.md snippets, subagent definitions, slash commands) that a new project copies directly instead of redesigning the architecture from scratch.

This repo ships documentation and scaffolding only — no application code.

## Layout

```
CLAUDE.md                              # this file — the operating manual
README.md                              # human-facing pattern index
templates/
  pattern-README.template.md           # mandatory starting point for every new pattern
patterns/<pattern-name>/               # kebab-case; one directory per pattern
  README.md                            # the write-up — MUST follow the schema below
  scaffold/                            # drop-in files a target repo copies, then adapts
```

Worked example — `patterns/three-agent-architect-builder-reviewer/` is the canonical entry; **every future pattern must match its format**:

```
patterns/three-agent-architect-builder-reviewer/
├── README.md                          # schema-compliant write-up (the format reference)
└── scaffold/
    ├── INSTALL.md                     # how to drop the scaffold into a target repo
    ├── claude-md-snippet.md           # block to append to the target repo's CLAUDE.md
    └── .claude/
        ├── agents/
        │   ├── architect.md
        │   ├── builder.md
        │   └── reviewer.md
        └── commands/
            ├── plan-ticket.md
            ├── build-ticket.md
            ├── review-ticket.md
            └── verify-delivery.md
```

## Pattern README schema (all sections required, in this order)

| Section | Must contain |
|---|---|
| Metadata table (under the title) | Pattern name · status (`proposed` / `trialed` / `adopted` / `deprecated`) · as-of date · expiry trigger · sign-off |
| 1. When to use / when not to use | Concrete task shapes, both directions — not adjectives |
| 2. Agent roles & boundaries | Per agent: what it does / what it must never do; who judges whom |
| 3. Model + effort assignment | Table: role · model · effort · reasoning · source label per claim. Heading carries the as-of date |
| 4. Known failure modes / pitfalls | Symptom · the specific context/harness it was observed in · mitigation · date recorded. "None recorded yet" is a valid honest entry; an invented one is not |
| 5. Upstream / downstream integration | How work enters (master PRD → sub-PRD → ticket, ADRs) and what leaves (PR, review verdict, docs) |
| 6. Scaffold | What is in `scaffold/` and how to install it |
| 7. Provenance & change log | Dated entries: what changed, on what basis, by whom |

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
3. Open a PR. Status starts at `proposed`.
4. Sign-off to merge: the repo maintainer (Horace Hou) approves schema compliance and grounding. Promotion to `adopted` additionally requires the pattern having run on ≥1 real ticket in a real project, named in the provenance log.
5. Any later change to a model/effort recommendation updates the table **and** the as-of date **and** adds a provenance-log entry — in the same commit.

## Grounding rules — binding on every agent working in this repo, including Claude

1. **No training-data impressions.** Every model/effort recommendation must be grounded in currently verifiable official documentation (link it), or be explicitly labeled `[unverified]` — "unverified third-party data / needs testing". If you cannot verify it right now, label it; never launder a hunch into a recommendation.
2. **Official conclusions ≠ harness observations.** Keep "conclusion from official docs / system cards" and "phenomenon observed under one specific benchmark harness" visibly distinct (use the source labels). A single-harness observation is never written up as a general conclusion — scope it with harness, conditions, and date.
3. **As-of dates move with recommendations.** Model capability and effort behavior change across versions; every recommendation is traceable, expirable, and updatable — never a permanent conclusion. Whenever a recommendation changes, its as-of date changes in the same commit.
4. **Staleness (default policy, maintainer-adjustable):** a model/effort table expires when a successor to any listed model ships, or 6 months after its as-of date, whichever comes first. Expired ≠ wrong — it means "re-verify before citing or copying into a new project".
5. **English only** in committed files; Chinese is for conversation, never for the repo.
