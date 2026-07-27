# 01-a-strings — sub-PRD (Level-1 rehearsal, set A)

Scope: 3 tiny pure-function tickets, one source file and one test file each.

Non-goal: anything beyond the listed functions. This module exists to exercise the **pipeline**, not to build a library.

| Ticket | Size | Lane | File scope | Depends on |
|---|---|---|---|---|
| RA-1 | S | 01-a-strings | `testbed/rehearsal/src/slugify.mjs` + `testbed/rehearsal/tests/slugify.test.mjs` | — |
| RA-2 | S | 01-a-strings | `testbed/rehearsal/src/title-case.mjs` + `testbed/rehearsal/tests/title-case.test.mjs` | — |
| RA-5 | S | 01-a-strings | `testbed/rehearsal/src/headline.mjs` + `testbed/rehearsal/tests/headline.test.mjs` | RA-1, RA-2 |

Acceptance: every listed ticket delivered, and `node --test testbed/rehearsal/tests/` green on the rehearsal branch.
