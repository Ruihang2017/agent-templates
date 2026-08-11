---
name: verify-delivery
description: Verify the post-merge Definition of Done for a Codex three-agent ticket. Use after delivery or when auditing completion.
---

Resolve the ticket and print a pass/fail table based only on checks performed in this run:

1. `docs/plans/<id>.md` exists.
2. A CLEAR verdict is attached as a PR/MR comment.
3. The full suite passes on the merged default branch.
4. The PR/MR is merged into the default branch, not an integration branch.
5. The tracker issue is closed.
6. Any spec correction is written back to the ticket and republished; the plan is never used as the spec.

In supervised mode, propose a mechanical repair and wait for explicit approval. In autonomous mode, ask `delivery` to perform a deterministic repair when one exists. Never mark an unchecked item passed, and never treat CLEAR alone as delivered.

