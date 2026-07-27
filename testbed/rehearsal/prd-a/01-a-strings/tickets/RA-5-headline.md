---
id: RA-5
title: Add headline(input)
module: 01-a-strings
lane: 01-a-strings
size: S
agent: builder
status: ready
date: 2026-07-27
blocked_by: [RA-1, RA-2]
blocks: []
---

# RA-5 — Add `headline(input)`

No ADR — this is a Level-1 rehearsal ticket for catalog issue #75. Its only purpose is to
exercise the three-agent pipeline end to end on a task small enough that the Builder cannot
plausibly fail for domain reasons. Parent sub-PRD: [01-a-strings README](../README.md).
**Why `builder`:** a single pure function plus its tests — a narrowly-scoped addition to an
existing directory, not a new subsystem.

## Background + basis

The rehearsal measures **orchestration**, not code difficulty: stage order, reviewer
independence in a fresh context, worktree isolation under parallel lanes, and delivery
bookkeeping. Every ticket therefore owns a disjoint file scope, so concurrent lanes cannot
collide at merge — that isolation is precisely what is under test.

## Deliverables

1. `testbed/rehearsal/src/headline.mjs` — export `headline` as a **named ESM export**.
2. `testbed/rehearsal/tests/headline.test.mjs` — tests using `node:test` and `node:assert/strict`, importing from `../src/headline.mjs`.

Behaviour: Compose the two already-delivered helpers: slugify the input, turn `-` back into spaces, then title-case the result. Import them from `../src/slugify.mjs` and `../src/title-case.mjs` — do NOT reimplement either.

## File scope

- **Touches:** `testbed/rehearsal/src/headline.mjs`, `testbed/rehearsal/tests/headline.test.mjs`
- **Does not touch:** anything else in the repository. Do not edit another ticket's files, and
  never `.claude/`, `patterns/`, `scripts/`, `templates/`, or `testbed/e2e/`.
- **Serial-safety:** none required — this file scope is disjoint from every sibling ticket, which
  is what makes the ticket safe to run in a parallel lane.

## Acceptance

- [ ] `headline('hello, world!') === 'Hello World'`
- [ ] `headline('  A -- B  ') === 'A B'`
- [ ] `node --test testbed/rehearsal/tests/` passes with the new test file included.
- [ ] The export is **named** (not default), and importing the module has no side effects.
- [ ] Imports the already-delivered helpers (RA-1, RA-2) instead of reimplementing them.

## Test plan

Unit only. Cover every case listed under Acceptance, including the empty/boundary input. No
integration or E2E work is in scope for this ticket — `testbed/e2e/` is explicitly out of scope.

## Feedback obligation

If this ticket is ambiguous, or its acceptance cannot be met as written, stop and report it
rather than widening the scope. A rehearsal ticket that needed interpretation is itself a
finding worth recording on issue #75.
