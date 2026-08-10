---
id: RPT-01
title: Implement report aggregation
blocked_by: [MNY-01, CAT-01]
file_scope:
  - src/report.mjs
test_cmd: node --test test/report.test.mjs
---

# RPT-01 — Implement report aggregation

Implements PRD FR-3. Blocked by MNY-01 and CAT-01: it *imports* both modules, so neither
contract may be re-derived here. Read them; do not reinvent them.

## Contract

Create `src/report.mjs`, an ES module with exactly one named export and no default export.

```js
import { parseAmount } from './money.mjs'
import { categorize } from './categorize.mjs'

export function summarize(expenses) { /* Expense[] -> Summary */ }
```

An expense is `{ merchant: string, amount: string }` where `amount` is in whatever form
`parseAmount` accepts. A summary is:

```js
{ total: number, byCategory: Record<string, number>, count: number }
```

All money is **integer cents**, produced by `parseAmount`. Do not parse amounts yourself.

| Case | Result |
|---|---|
| not an array (`null`, an object, a string) | **throws** `new TypeError('summarize: not an array')` |
| the empty array | `{ total: 0, byCategory: {}, count: 0 }` |
| a normal list | `total` = sum of all amounts in cents; `count` = number of expenses; `byCategory` = per-category sums |
| an expense whose `amount` is malformed | the `RangeError` from `parseAmount` **propagates unchanged** — do not catch it, do not rewrap it, do not skip the row |

`byCategory` rules, both asserted on:

1. It contains **only** categories that actually occurred. A category with no expenses is
   absent, not present with `0`.
2. Its keys are in **alphabetical order**. `Object.keys(summary.byCategory)` is compared
   directly against a sorted array, so insertion order matters — build the object with its
   keys sorted.

Categories come from `categorize(expense.merchant)`, including its ordering rules — so
`"Airport Cafe"` counts toward `travel`.

## Deliverables

1. `src/report.mjs` exporting `summarize` exactly as specified, importing `parseAmount`
   from `./money.mjs` and `categorize` from `./categorize.mjs`.
2. Nothing else. No default export, no side effects at import time.

## Done when

`node --test test/report.test.mjs` exits 0.

## Out of scope

- Do not modify `src/money.mjs` (MNY-01) or `src/categorize.mjs` (CAT-01) — if either
  looks wrong, that is an escalation, not an edit. Fixing a dependency from inside this
  brief silently takes ownership of a file another brief owns.
- Do not modify anything under `test/`.
- No `src/cli.mjs` (CLI-01). No dependencies and no `package.json` change.
