---
title: 00-smoke — pipeline smoke module
status: ready
owner: agent-templates maintainer
date: 2026-07-17
version: 0.1
---

# 00-smoke — pipeline smoke module

Two intentionally small tickets that exercise every pipeline stage (plan, build,
fresh-context review, deliver) without material token cost. Parent spec:
[master PRD](../../PRD.md).

## Work breakdown

| Ticket | Title | Size | File-scope (write-owns) | Depends on |
|---|---|---|---|---|
| SMK-01 | Add subtract() | S | `src/calc.mjs`, `tests/calc.test.mjs` (subtract cases only) | — |
| SMK-02 | Add divide() with zero guard | S | `src/calc.mjs`, `tests/calc.test.mjs` (divide cases only) | SMK-01 |

Note: the two tickets share files on purpose — they run **sequentially** through
the milestone runner (fail-fast default), which is exactly the dependency shape
the runner must handle. Parallel-lane testing needs disjoint file-scopes and is
out of this module's scope.

## Acceptance

- Both tickets delivered through `/start-milestone docs/prd/00-smoke` with zero
  human edits between Gate 1 and Gate 2.
- `npm test` green on the default branch afterwards.

## Changelog

- 0.1 (2026-07-17): initial two-ticket smoke module.
