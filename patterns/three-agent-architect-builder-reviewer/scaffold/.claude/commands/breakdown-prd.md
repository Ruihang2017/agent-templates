---
description: Decompose docs/PRD.md into sub-PRDs + template-compliant tickets (three-agent pattern, pre-Gate-1 planning)
argument-hint: [focus notes, e.g. module-count hint or what to defer]
---

Launch the **architect** subagent to decompose the master PRD. Optional focus notes from the human: `$ARGUMENTS`

Input: `docs/PRD.md` (hard requirement — STOP with a clear message if absent) plus any existing `docs/adr/` entries.

Output (planning artifacts only — the architect writes no production code):

1. `docs/prd/breakdown-plan.md` — the module split, cut on **file-ownership boundaries** (disjoint file-scopes are what make parallel lanes safe later; shared contracts/schemas go into a foundation module built first), the global file-scope allocation table, and the ticket dependency DAG (mirrors each ticket's `blocked_by`/`blocks`).
2. Per module `NN-<name>`: `docs/prd/NN-<name>/README.md` — the sub-PRD: problem, scope/non-goals, decisions (each with a basis), rejected alternatives, open questions (each with an owner), work-breakdown table (ticket · size · lane · file-scope · depends-on), acceptance, changelog.
3. `docs/prd/NN-<name>/tickets/<ID>-<slug>.md` — every ticket follows `templates/ticket.template.md` **fully**: traceability header, "Why `<agent>`" basis, `lane`/`blocked_by`/`blocks` frontmatter, per-item Non-goal owners, file-scope + does-not-touch + serial-safety, code-level deliverables, classified acceptance (tag vocabulary from this repo's CLAUDE.md), test plan, feedback obligation. Every ticket must be cold-startable.

When the architect returns, run the deterministic execution-plan report **in this session** (it only reads the tickets the architect just wrote — no agent judgement involved):

```
node .claude/scripts/dag-report.mjs docs/prd
```

It writes `docs/prd/dag.html` (self-contained, open it in a browser) and prints a summary plus a `DAG-REPORT-JSON:` line. If it exits non-zero the decomposition is defective — a `blocked_by` pointing at a ticket id that does not exist, or a dependency cycle. Report the error and stop; do not hand a broken DAG to Gate 1.

Then present the breakdown summary and **STOP**:

- modules, ticket count, open questions;
- the execution shape from the report — per module: lanes, waves, and any module flagged **fully serial**;
- the **recommended concurrency**, quoted as the exact command to run: `/start-all autonomous <N>`.

Call out a fully-serial module explicitly. It means that module's tickets form one `blocked_by` chain and it can only ever use one lane — that is a **file-scope decomposition** problem to fix now, while the tickets are still cheap to change, not a scheduling detail to discover mid-run.

This output is the input to Gate 1 — the human's review plus `/start-milestone` (or `/start-all`) is the sign-off. Never begin implementation from this command.

Hard rule: this stage runs in the **architect** subagent, never inline in this session. If the subagent cannot be launched or fails, report that and stop — do not absorb its role.
