---
id: MNY-01
title: Implement the money primitives
blocked_by: []
file_scope:
  - src/money.mjs
test_cmd: node --test test/money.test.mjs
---

# MNY-01 — Implement the money primitives

Implements PRD FR-1. This is the foundation module: RPT-01 and CLI-01 both depend on it,
so its contract is fixed here and is not open to reinterpretation downstream.

## Contract

Create `src/money.mjs`, an ES module with exactly two named exports and no default export.

```js
export function parseAmount(text) { /* string -> integer cents */ }
export function formatAmount(cents) { /* integer cents -> string */ }
```

`parseAmount(text)`:

| Input | Result |
|---|---|
| not a string (number, `null`, `undefined`, object) | **throws** `new TypeError('parseAmount: not a string')` |
| `"$1,234.56"` | `123456` |
| `"1234.56"` | `123456` |
| `"7"` | `700` |
| `"$0.05"` | `5` |
| `"0"` | `0` |
| `"1.5"` (one decimal place) | **throws** `new RangeError('parseAmount: malformed amount')` |
| `"1.500"` (three decimal places) | **throws** `new RangeError('parseAmount: malformed amount')` |
| `"abc"`, the empty string, anything else non-matching | **throws** `new RangeError('parseAmount: malformed amount')` |

Accepted shape: an optional leading `$`, an integer part with optional `,` thousands
separators, and **either no decimal part or exactly two decimal digits**. The result is
integer cents; there is no floating-point money anywhere in this module.

`formatAmount(cents)`:

| Input | Result |
|---|---|
| not an integer, or not a number (`1.5`, `"7"`, `null`) | **throws** `new TypeError('formatAmount: not an integer')` |
| `123456` | `"$1,234.56"` |
| `0` | `"$0.00"` |
| `5` | `"$0.05"` |
| `-5` | `"-$0.05"` — the sign goes **before** the `$` |
| `100000000` | `"$1,000,000.00"` |

The error messages above are exact and are asserted on. Do not reword them.

**Invariant:** `parseAmount(formatAmount(n)) === n` for every non-negative integer `n`.

## Deliverables

1. `src/money.mjs` exporting `parseAmount` and `formatAmount` exactly as specified.
2. Nothing else. No default export, no helper exports, no side effects at import time.

## Done when

`node --test test/money.test.mjs` exits 0.

## Out of scope

- Do not modify anything under `test/` — the tests are the contract's checker, not part of
  this brief, and weakening one to go green is a failure.
- No `src/categorize.mjs` (CAT-01), no `src/report.mjs` (RPT-01), no `src/cli.mjs` (CLI-01).
- No dependencies and no `package.json` change — the firewall denies it and none is needed.
- No locale-aware formatting or currencies beyond the single implicit unit (PRD out-of-scope).
