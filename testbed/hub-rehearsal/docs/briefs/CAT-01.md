---
id: CAT-01
title: Implement merchant categorisation
blocked_by: []
file_scope:
  - src/categorize.mjs
test_cmd: node --test test/categorize.test.mjs
---

# CAT-01 — Implement merchant categorisation

Implements PRD FR-2. Independent of MNY-01: it shares no files and needs none of its
exports, so the two run concurrently.

## Contract

Create `src/categorize.mjs`, an ES module with exactly one named export and no default
export.

```js
export function categorize(merchant) { /* string -> 'travel' | 'food' | 'software' | 'other' */ }
```

- A non-string input **throws** `new TypeError('categorize: not a string')` — that exact message.
- Matching is **case-insensitive** and by **substring**, not by whole word or prefix.
- The rules are applied **in this order**, and the first match wins:

| Order | Category | Matches if the name contains any of |
|---|---|---|
| 1 | `travel` | `air`, `hotel`, `rail` |
| 2 | `food` | `cafe`, `coffee`, `restaurant` |
| 3 | `software` | `saas`, `hosting`, `github` |
| 4 | `other` | (nothing matched) |

**The order is load-bearing and is asserted on**, because names collide:

- `"Airport Cafe"` contains both `air` and `cafe` and must be `travel`, not `food`.
- `"Cafe Hosting"` contains both `cafe` and `hosting` and must be `food`, not `software`.

Implementing this as an unordered lookup will pass the single-rule cases and fail the
collisions.

## Deliverables

1. `src/categorize.mjs` exporting `categorize` exactly as specified.
2. Nothing else. No default export, no side effects at import time.

## Done when

`node --test test/categorize.test.mjs` exits 0.

## Out of scope

- Do not modify anything under `test/`.
- No `src/money.mjs` (MNY-01), no `src/report.mjs` (RPT-01), no `src/cli.mjs` (CLI-01).
- No dependencies and no `package.json` change.
