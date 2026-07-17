---
id: SMK-01
title: Add subtract() to the calc library
module: 00-smoke
size: S
agent: builder
status: ready
date: 2026-07-17
---

# SMK-01 — Add subtract() to the calc library

Parent sub-PRD: [00-smoke README](../README.md). Master spec: [PRD](../../../PRD.md).

## Background + basis

The calc library ships `add` and `multiply` ([master PRD](../../../PRD.md) §Scope).
`subtract` is the smallest possible extension that still forces a real code + test
change, which is all this smoke ticket exists to do.

## Goal

`src/calc.mjs` exports `subtract(a, b)` returning `a - b`, covered by tests.

## Non-goals

- No `divide` — that is SMK-02.
- No input validation — inputs are numbers by convention in this library.

## File-scope (write-owns)

- `src/calc.mjs`
- `tests/calc.test.mjs` (the subtract test cases only)

## Deliverables

1. `subtract(a, b)` exported from `src/calc.mjs`.
2. Test cases covering a positive, a negative, and a zero result.

## Acceptance checklist (classified)

- [ ] `[machine]` `subtract(5, 3) === 2`, `subtract(3, 5) === -2`, `subtract(4, 4) === 0` are asserted by tests.
- [ ] `[machine]` `npm test` green.

No `[fixture]` or `[human]` criteria — pure logic ticket.

## Test plan

- Run `npm test`; confirm the new subtract cases exist and pass.

## Writeback obligation

If implementation falsifies this spec, update this ticket / the sub-PRD first
(version +0.1, changelog line), then change the code. Silent divergence = incomplete.
