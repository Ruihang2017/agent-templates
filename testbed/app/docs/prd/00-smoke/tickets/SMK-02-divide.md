---
id: SMK-02
title: Add divide() with a zero guard
module: 00-smoke
size: S
agent: builder
status: ready
date: 2026-07-17
---

# SMK-02 — Add divide() with a zero guard

Parent sub-PRD: [00-smoke README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [SMK-01 — Add subtract()](SMK-01-subtract.md) (sequential file-scope on the same files).

## Background + basis

Division introduces the first failure-mode decision in the library (divide by
zero), giving the Reviewer a real edge case to check — the reason this ticket
exists ([00-smoke README](../README.md) §Work breakdown).

## Goal

`src/calc.mjs` exports `divide(a, b)` returning `a / b`, throwing a `RangeError`
when `b === 0`, covered by tests.

## Non-goals

- No BigInt/precision handling — plain IEEE 754 semantics.

## File-scope (write-owns)

- `src/calc.mjs`
- `tests/calc.test.mjs` (the divide test cases only)

## Deliverables

1. `divide(a, b)` exported from `src/calc.mjs`; `divide(x, 0)` throws `RangeError` with a message naming the operation.
2. Test cases covering a normal division and the zero-divisor throw.

## Acceptance checklist (classified)

- [ ] `[machine]` `divide(10, 4) === 2.5` asserted by tests.
- [ ] `[machine]` `divide(1, 0)` throws `RangeError` (asserted with `assert.throws`).
- [ ] `[machine]` `npm test` green.

No `[fixture]` or `[human]` criteria — pure logic ticket.

## Test plan

- Run `npm test`; confirm the divide cases exist and pass, including the throw case.

## Writeback obligation

If implementation falsifies this spec, update this ticket / the sub-PRD first
(version +0.1, changelog line), then change the code. Silent divergence = incomplete.
