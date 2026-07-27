# 04-b-numbers — sub-PRD (Level-1 rehearsal, set B)

Scope: 3 tiny pure-function tickets, one source file and one test file each.

Non-goal: anything beyond the listed functions. This module exists to exercise the **pipeline**, not to build a library.

| Ticket | Size | Lane | File scope | Depends on |
|---|---|---|---|---|
| RB-3 | S | 04-b-numbers | `testbed/rehearsal/src/sum.mjs` + `testbed/rehearsal/tests/sum.test.mjs` | — |
| RB-4 | S | 04-b-numbers | `testbed/rehearsal/src/unique.mjs` + `testbed/rehearsal/tests/unique.test.mjs` | — |
| RB-6 | S | 04-b-numbers | `testbed/rehearsal/src/average.mjs` + `testbed/rehearsal/tests/average.test.mjs` | RB-3, RB-4 |

Acceptance: every listed ticket delivered, and `node --test testbed/rehearsal/tests/` green on the rehearsal branch.
