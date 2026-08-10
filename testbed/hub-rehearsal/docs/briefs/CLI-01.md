---
id: CLI-01
title: Implement CLI argument parsing
blocked_by: [MNY-01]
file_scope:
  - src/cli.mjs
test_cmd: node --test test/cli.test.mjs
---

# CLI-01 — Implement CLI argument parsing

Implements PRD FR-4. Blocked by MNY-01 only: it imports `parseAmount` and nothing else.
Independent of CAT-01 and RPT-01, so it runs concurrently with RPT-01.

## Contract

Create `src/cli.mjs`, an ES module with exactly one named export and no default export.

```js
import { parseAmount } from './money.mjs'

export function parseArgs(argv) { /* string[] -> Options */ }
```

**Parsing only.** No file I/O, no network, no `process.exit`, and no reading
`process.argv` — the array is passed in.

Returns:

```js
{ file: string | null, category: string | null, min: number | null, json: boolean }
```

| Flag | Takes a value | Maps to |
|---|---|---|
| `--file <path>` | yes | `file`, the raw string |
| `--category <name>` | yes | `category`, the raw string |
| `--min <amount>` | yes | `min`, the value passed through `parseAmount`, so `--min 10` is `1000` and `--min '$1,234.56'` is `123456` |
| `--json` | no | `json: true` |

- Absent options are `null`. `json` defaults to `false`.
- `parseArgs([])` returns `{ file: null, category: null, min: null, json: false }`.
- An unrecognised flag **throws** `new RangeError('parseArgs: unknown flag --nope')` — the
  message embeds the offending flag exactly as it appeared.
- A value-taking flag at the end of the array with nothing after it **throws**
  `new RangeError('parseArgs: --file needs a value')` — again embedding the flag.
- A malformed `--min` value propagates the `RangeError` from `parseAmount` **unchanged**
  (`parseAmount: malformed amount`), rather than being rewrapped as a `parseArgs` error.

That last row is the one most likely to be got wrong: two different error messages come
out of the same flag, depending on whether the value is missing or malformed.

## Deliverables

1. `src/cli.mjs` exporting `parseArgs` exactly as specified, importing `parseAmount` from
   `./money.mjs`.
2. Nothing else. No default export, no side effects at import time.

## Done when

`node --test test/cli.test.mjs` exits 0.

## Out of scope

- Do not modify `src/money.mjs` (MNY-01) — escalate instead of editing.
- Do not modify anything under `test/`.
- No `src/report.mjs` (RPT-01). No dependencies and no `package.json` change.
- No command execution and no output formatting — this brief parses arguments and stops.
