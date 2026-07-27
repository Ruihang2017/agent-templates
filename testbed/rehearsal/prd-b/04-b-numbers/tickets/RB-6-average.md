---
id: RB-6
title: Add average(nums)
module: 04-b-numbers
lane: 04-b-numbers
size: S
agent: builder
status: ready
date: 2026-07-27
blocked_by: [RB-3, RB-4]
blocks: []
---

# RB-6 — Add `average(nums)`

No ADR — this is a Level-1 rehearsal ticket for catalog issue #75. Its only purpose is to
exercise the three-agent pipeline end to end on a task small enough that the Builder cannot
plausibly fail for domain reasons. Parent sub-PRD: [04-b-numbers README](../README.md).
**Why `builder`:** a single pure function plus its tests — a narrowly-scoped addition to an
existing directory, not a new subsystem.

## Background + basis

The rehearsal measures **orchestration**, not code difficulty: stage order, reviewer
independence in a fresh context, worktree isolation under parallel lanes, and delivery
bookkeeping. Every ticket therefore owns a disjoint file scope, so concurrent lanes cannot
collide at merge — that isolation is precisely what is under test.

## Deliverables

1. `testbed/rehearsal/src/average.mjs` — export `average` as a **named ESM export**.
2. `testbed/rehearsal/tests/average.test.mjs` — tests using `node:test` and `node:assert/strict`, importing from `../src/average.mjs`.

Behaviour: Compose the two already-delivered helpers: de-duplicate `nums`, then divide their sum by the de-duplicated count. Return 0 for an empty array. Import them from `../src/sum.mjs` and `../src/unique.mjs` — do NOT reimplement either.

## File scope

- **Touches:** `testbed/rehearsal/src/average.mjs`, `testbed/rehearsal/tests/average.test.mjs`
- **Does not touch:** anything else in the repository. Do not edit another ticket's files, and
  never `.claude/`, `patterns/`, `scripts/`, `templates/`, or `testbed/e2e/`.
- **Serial-safety:** none required — this file scope is disjoint from every sibling ticket, which
  is what makes the ticket safe to run in a parallel lane.

## Acceptance

- [ ] `average([1,2,3]) === 2`
- [ ] `average([2,2,4]) === 3`
- [ ] `average([]) === 0`
- [ ] `node --test "testbed/rehearsal/tests/*.test.mjs"` passes with the new test file included.
- [ ] The export is **named** (not default), and importing the module has no side effects.
- [ ] Imports the already-delivered helpers (RB-3, RB-4) instead of reimplementing them.

## Test plan

Unit only. Cover every case listed under Acceptance, including the empty/boundary input. No
integration or E2E work is in scope for this ticket — `testbed/e2e/` is explicitly out of scope.

## Feedback obligation

If this ticket is ambiguous, or its acceptance cannot be met as written, stop and report it
rather than widening the scope. A rehearsal ticket that needed interpretation is itself a
finding worth recording on issue #75.
