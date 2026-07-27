# 02-a-numbers — sub-PRD (Level-1 rehearsal, set A)

Scope: 3 tiny pure-function tickets, one source file and one test file each.

Non-goal: anything beyond the listed functions. This module exists to exercise the **pipeline**, not to build a library.

| Ticket | Size | Lane | File scope | Depends on |
|---|---|---|---|---|
| RA-3 | S | 02-a-numbers | `testbed/rehearsal/src/clamp.mjs` + `testbed/rehearsal/tests/clamp.test.mjs` | — |
| RA-4 | S | 02-a-numbers | `testbed/rehearsal/src/chunk.mjs` + `testbed/rehearsal/tests/chunk.test.mjs` | — |
| RA-6 | S | 02-a-numbers | `testbed/rehearsal/src/paginate.mjs` + `testbed/rehearsal/tests/paginate.test.mjs` | RA-3, RA-4 |

Acceptance: every listed ticket delivered, and `node --test testbed/rehearsal/tests/` green on the rehearsal branch.
