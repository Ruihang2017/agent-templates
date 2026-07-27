# 03-b-strings — sub-PRD (Level-1 rehearsal, set B)

Scope: 3 tiny pure-function tickets, one source file and one test file each.

Non-goal: anything beyond the listed functions. This module exists to exercise the **pipeline**, not to build a library.

| Ticket | Size | Lane | File scope | Depends on |
|---|---|---|---|---|
| RB-1 | S | 03-b-strings | `testbed/rehearsal/src/kebab.mjs` + `testbed/rehearsal/tests/kebab.test.mjs` | — |
| RB-2 | S | 03-b-strings | `testbed/rehearsal/src/camel.mjs` + `testbed/rehearsal/tests/camel.test.mjs` | — |
| RB-5 | S | 03-b-strings | `testbed/rehearsal/src/identifier.mjs` + `testbed/rehearsal/tests/identifier.test.mjs` | RB-1, RB-2 |

Acceptance: every listed ticket delivered, and `node --test testbed/rehearsal/tests/` green on the rehearsal branch.
