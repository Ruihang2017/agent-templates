# Level-1 rehearsal fixture

Two isomorphic ticket sets the catalog runs **live** through the three-agent pipeline — real
agents, real branches, real merges — to exercise orchestration end to end. Level 0
(`testbed/e2e/`) proves the scheduler with stubbed agents; this proves the agents.

| Set | PRD root | Runs at | Shape |
|---|---|---|---|
| A | `prd-a/` | `concurrency: 1` | 4 independent tickets, then 2 that each join a pair |
| B | `prd-b/` | `concurrency: 4` | identical shape, disjoint files |

The sets are isomorphic and disjoint on purpose: after a run delivers, its issues close and the
resume filter correctly drops those tickets, so the *same* set cannot be run twice for a
comparison.

Predicted by the scheduler model: **6 waves at concurrency 1, 2 waves at concurrency 4.**

Tickets are deliberately trivial (one pure function plus its tests each). A rehearsal that fails
should fail because of the *pipeline*, not because the Builder found the domain hard.

**Runs target a sacrificial branch, never `main`** — `defaultBranch` flows from the workflow
args through to `deliver-ticket.mjs --default-branch`, so ticket branches, PRs, and merges all
land on the rehearsal branch and `main` is never written by an agent.

`src/` and `tests/` are where delivered tickets land; `tests/harness.test.mjs` only exists so
`node --test` has a target before the first delivery.
