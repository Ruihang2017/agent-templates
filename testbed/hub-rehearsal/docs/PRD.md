# PRD — `spend`, a tiny expense-report library

A deliberately small but **not trivial** target for Level-1 rehearsals of the
`hub-and-spoke-orchestrator-executors` pattern. It exists to exercise the pattern, not to
be useful software.

It is shaped to stress the parts of the pattern that a single-brief rehearsal cannot:

- a **foundation module** every other module depends on (so wave scheduling is real);
- **three independent modules** in the second wave (so concurrency is real);
- **disjoint file ownership** (so the scope audit has something to be right about);
- exact, checkable contracts including **error messages** (so a plausible-but-wrong
  implementation fails rather than passing).

Money is handled in integer **cents** throughout. Floating-point currency is the classic
source of "looks right, is wrong", and forbidding it gives the contracts something real to
pin down.

## FR-1 — Money primitives

`src/money.mjs`, an ES module.

| Export | Signature | Behaviour |
|---|---|---|
| `parseAmount` | `(text: string) => number` | Parses a decimal currency string into integer cents. Accepts an optional leading `$`, optional thousands separators, and exactly zero or two decimal places. `"$1,234.56"` → `123456`. `"7"` → `700`. Throws `TypeError('parseAmount: not a string')` for a non-string input, and `RangeError('parseAmount: malformed amount')` for anything that does not match — including one decimal place (`"1.5"`) and three (`"1.500"`). |
| `formatAmount` | `(cents: number) => string` | Formats integer cents as `$` + a thousands-separated decimal with exactly two places. `123456` → `"$1,234.56"`. `-5` → `"-$0.05"`. `0` → `"$0.00"`. Throws `TypeError('formatAmount: not an integer')` for a non-integer or non-number. |

`parseAmount(formatAmount(n)) === n` must hold for every non-negative integer `n`.

## FR-2 — Categorisation

`src/categorize.mjs`, an ES module.

| Export | Signature | Behaviour |
|---|---|---|
| `categorize` | `(merchant: string) => string` | Maps a merchant name to one of `travel`, `food`, `software`, `other`. Matching is **case-insensitive** and by substring. Rules, applied in this order: `travel` if the name contains `air`, `hotel`, or `rail`; `food` if it contains `cafe`, `coffee`, or `restaurant`; `software` if it contains `saas`, `hosting`, or `github`; otherwise `other`. Throws `TypeError('categorize: not a string')` for a non-string input. |

Order matters and is part of the contract: `"Airport Cafe"` is `travel`, not `food`.

## FR-3 — Report aggregation

`src/report.mjs`, an ES module. Depends on FR-1 and FR-2.

An expense is `{ merchant: string, amount: string }`, where `amount` is in the format
`parseAmount` accepts.

| Export | Signature | Behaviour |
|---|---|---|
| `summarize` | `(expenses: Expense[]) => Summary` | Returns `{ total: number, byCategory: Record<string, number>, count: number }`, all money in integer cents. `byCategory` contains **only** categories that actually occurred, and its keys are sorted alphabetically. An empty input returns `{ total: 0, byCategory: {}, count: 0 }`. Throws `TypeError('summarize: not an array')` for a non-array. Malformed amounts propagate the `RangeError` from `parseAmount` unchanged. |

## FR-4 — CLI argument parsing

`src/cli.mjs`, an ES module. Depends on FR-1. **Parsing only** — no I/O, no `process.exit`.

| Export | Signature | Behaviour |
|---|---|---|
| `parseArgs` | `(argv: string[]) => Options` | Returns `{ file: string \| null, category: string \| null, min: number \| null, json: boolean }`. Recognises `--file <path>`, `--category <name>`, `--min <amount>` (parsed through `parseAmount`, so `--min 10` is `1000`), and the boolean `--json`. Unknown flags throw `RangeError('parseArgs: unknown flag <flag>')`. A value-taking flag with no value throws `RangeError('parseArgs: <flag> needs a value')`. Absent options are `null`; `json` defaults to `false`. |

## Non-functional

- Node >= 18, ES modules, **zero runtime dependencies**.
- Every module is independently importable; no module may import from another except as FR-3 and FR-4 state.
- The full suite is `node --test`. Each module additionally has its own test file, so a
  module can be verified before its siblings exist.

## Out of scope

- Reading or writing files, network access, currencies other than one implicit unit,
  locale-aware formatting, and rounding policy beyond "amounts are already integer cents".
