---
description: Hub stage 1 — decompose a PRD into contract-first task briefs that a low-effort headless executor can implement without designing anything
argument-hint: [prd-path] [focus notes, e.g. how many briefs or what to defer]
---

Arguments: `$ARGUMENTS` — an optional **PRD path** followed by optional focus notes.

Resolve the PRD first. If the first token ends in `.md`, that is the PRD path and the rest is notes; otherwise the PRD is `docs/PRD.md`. **Stop with a clear message if the resolved file does not exist** — never silently decompose a different document.

You are the **hub**. This is the one stage where thinking is not being economised, because everything downstream depends on it and nothing downstream will catch your mistakes. The executors run at low reasoning effort in isolated worktrees; they are instructed not to design. That instruction is only safe if you have already made every design decision.

**Write briefs to `docs/briefs/<ID>.md`. Do not write production code in this stage.**

## 1. Read before you cut

Read the PRD, any decision records under `docs/adr/`, and enough of the codebase to know where the code actually lives. Module boundaries guessed from a PRD do not match a real repo.

## 2. Cut on file ownership, not on features

Two briefs may run concurrently only if their write-sets are disjoint, so the decomposition is a partition of the filesystem. For every boundary the question is "who writes these files", never "do these features feel related".

- Anything shared — schemas, types, contracts, config loaders — goes into **one foundation brief that runs first**, and everything else is `blocked_by` it. Duplicating a shared contract to dodge a dependency produces two incompatible versions of it.
- **You** own the structural truth: schemas, types, global state, migrations, public interfaces. Where a brief would have to invent one, write it yourself into the foundation brief instead. A low-effort executor must never be the author of a structure other briefs depend on.
- If a dependency is needed, that is **yours**, not a brief's. The firewall rejects any executor change to `package.json`, `go.mod`, `Cargo.toml`, `Dockerfile`, CI config, and friends, and it rejects any brief whose declared scope names one.

## 3. Write each brief

```markdown
---
id: FND-01
title: Short imperative title
blocked_by: []
file_scope:
  - src/config/**
test_cmd: npm test
---

# FND-01 — Short imperative title

## Contract

The exact interfaces, types, signatures, error shapes and call sites this brief must
produce or consume, written out in full. Quote the PRD or ADR lines they come from.
An executor reading only this section must have nothing left to decide.

## Deliverables

Numbered, at code-level precision: exact exports, where they are called from, ordering
constraints, naming, and the behavioural guarantee.

## Done when

The observable outcome, stated so completion is mechanically checkable — not "the tests
pass" alone, since a test suite can pass for reasons unrelated to this brief.

## Out of scope

Each exclusion names its owner: "no schema changes — that is FND-01".
```

`test_cmd` is the project's **own** one-line test command (`npm test`, `go test ./...`, `pytest -q`, `cargo test`). The driver runs it blind and gates on its exit code, which is what makes the pipeline language-agnostic. Never invent a command the project does not have.

## 4. Check your own decomposition mechanically

Do not eyeball this — run it:

```
node .claude/scripts/dispatch-spokes.mjs --briefs docs/briefs --dry-run
```

The gate rejects the whole set (dispatching nothing) on: a missing or empty required section, an empty or repo-wide `file_scope`, a scope naming a firewall-denied path, a missing `test_cmd`, duplicate ids, a dangling `blocked_by`, a cycle, or two unordered briefs whose scopes can overlap.

Fix the briefs until it is clean. Every one of those failures is yours to fix; none of them is something an executor can work around.

## 5. Then stop

Report: the briefs written, the dependency graph, the dry-run wave plan, anything in the PRD you deferred and why, and any open question with its owner.

**Stop there.** This is Gate 1 — a human reviews the briefs before anything is dispatched.
