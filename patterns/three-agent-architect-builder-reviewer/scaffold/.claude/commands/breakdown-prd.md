---
description: Decompose a PRD into sub-PRDs + template-compliant tickets (three-agent pattern, pre-Gate-1 planning); appends a new phase to an existing PRD tree without touching delivered work
argument-hint: [prd-path] [focus notes, e.g. module-count hint or what to defer]
---

Arguments: `$ARGUMENTS` — an optional **PRD path** followed by optional focus notes for the architect.

**Resolve the PRD first.** If the first token ends in `.md`, that is the PRD path and everything after it is notes; otherwise the PRD is `docs/PRD.md` and the whole argument is notes. STOP with a clear message if the resolved file does not exist — never fall back to a different PRD than the human named.

This is how a project adds work **after Gate 2**: phase 2 gets its own PRD *document* (`docs/PRD-02-<name>.md`), decomposed into the **same** `docs/prd/` tree. The document may be split by phase; the ticket tree must not be. `dag-scan.mjs`, `dag-report.mjs` and `/start-all` each take exactly one root, and a cross-phase `blocked_by` only resolves inside one graph — a second tree would break the single global DAG (catalog issues #71, #112).

## 1. Read the existing state (deterministic — run it in THIS session)

```
node .claude/scripts/prd-phase.mjs context docs/prd --prd <resolved-prd-path>
```

Parse its `PHASE-CONTEXT-JSON` line: `{root, phase, append, modules, nextPrefix, usedIds, existingFiles, planFile}`. It never fails on an empty tree — that is just the first decomposition.

- **`append: false`** — first decomposition. Proceed as normal.
- **`append: true`** — a later phase. The architect gets `nextPrefix`, `usedIds` and `existingFiles` **as data**, and the freeze rule below. Do not paraphrase these lists; pass them through.

## 2. The freeze rule (append mode)

**Files that already exist under `docs/prd/` may not be modified or deleted. Only additions are allowed.**

Delivered tickets' issues are closed, and those files are the record of what was built — rewriting one falsifies the record and cannot re-run the work anyway (`/start-all` skips closed issues). The rule is **per file, not per directory**: adding a *new* ticket to an existing module is fine and expected.

The escape hatch is `--redo` in the notes, for the pre-Gate-1 case where an earlier decomposition was simply wrong and nothing has been delivered from it. It bypasses the check in step 4; say so in the summary when it is used.

## 3. Launch the architect

Launch the **architect** subagent to decompose the resolved PRD.

Input: the resolved PRD path (hard requirement) plus any existing `docs/adr/` entries. In append mode, also the sub-PRDs of existing modules — **read-only, for dependency context**, since new tickets may legitimately be `blocked_by` delivered ones.

Output (planning artifacts only — the architect writes no production code):

1. `docs/prd/<planFile>` — the module split for **this phase**, cut on **file-ownership boundaries** (disjoint file-scopes are what make parallel lanes safe later; shared contracts/schemas go into a foundation module built first), the file-scope allocation table, and the ticket dependency DAG (mirrors each ticket's `blocked_by`/`blocks`). The name comes from step 1's `planFile` — `docs/PRD.md` → `breakdown-plan.md`, `docs/PRD-02-billing.md` → `breakdown-plan-02-billing.md`. **Never overwrite an earlier phase's plan**; that rationale is why the modules are shaped the way they are.
2. Per module `NN-<name>`, numbering from step 1's `nextPrefix`: `docs/prd/NN-<name>/README.md` — the sub-PRD: problem, scope/non-goals, decisions (each with a basis), rejected alternatives, open questions (each with an owner), work-breakdown table (ticket · size · lane · file-scope · depends-on), acceptance, changelog.
3. `docs/prd/NN-<name>/tickets/<ID>-<slug>.md` — every ticket follows `templates/ticket.template.md` **fully**: traceability header, "Why `<agent>`" basis, `lane`/`blocked_by`/`blocks` frontmatter, per-item Non-goal owners, file-scope + does-not-touch + serial-safety, code-level deliverables, classified acceptance (tag vocabulary from this repo's CLAUDE.md), test plan, feedback obligation. Every ticket must be cold-startable.

**Ticket ids must not collide with `usedIds`.** A collision is caught later by `dag-core` (`duplicate ticket id X (A and B)`), but that is a hard failure of the whole graph — cheaper to not create it.

**A new ticket may declare `blocked_by` on a delivered ticket from an earlier phase.** That edge is honored by the scheduler and drawn in `dag.html`; it does not re-run the delivered ticket.

## 4. Enforce the freeze (deterministic — run it in THIS session)

```
node .claude/scripts/prd-phase.mjs check docs/prd
```

Non-zero exit = the architect modified or deleted pre-existing files. **STOP and report the violation list**; do not present the breakdown for sign-off. `dag.html` is exempt (it is regenerated every run).

Its `FREEZE-CHECK-JSON` may report **`checked: false`** — not a git repository, or no commits yet. That is not a pass: it means the check could not run. **Say so explicitly in the summary**; reporting an unrun check as a passed one is exactly the failure this repo keeps hitting.

## 5. Render the execution plan (deterministic — run it in THIS session)

It only reads the tickets the architect just wrote — no agent judgement involved:

```
node .claude/scripts/dag-report.mjs docs/prd
```

It writes `docs/prd/dag.html` (self-contained, open it in a browser) and prints a summary plus a `DAG-REPORT-JSON:` line. **It renders the whole tree — every phase in one graph**, so an appended phase shows alongside the delivered one with cross-phase edges drawn. If it exits non-zero the decomposition is defective — a `blocked_by` pointing at a ticket id that does not exist, or a dependency cycle. Report the error and stop; do not hand a broken DAG to Gate 1.

## 6. Present and STOP

- which PRD was decomposed, and whether this was a first decomposition or an appended phase (name the new modules);
- modules, ticket count, open questions;
- the freeze-check result — including `checked: false` and its reason, if that is what happened;
- the execution shape from the report — per module: lanes, waves, and any module flagged **fully serial**;
- the **recommended concurrency**, quoted as the exact command to run: `/start-all autonomous <N>`;
- the rounds lost to the module barrier, if the report prints any. State it as a **decomposition** fact about `/start-milestone` (one module at a time, by definition), not about `/start-all`, which schedules globally.

Call out a fully-serial module explicitly. It means that module's tickets form one `blocked_by` chain and it can only ever use one lane — that is a **file-scope decomposition** problem to fix now, while the tickets are still cheap to change, not a scheduling detail to discover mid-run.

This output is the input to Gate 1 — the human's review plus `/start-milestone` (or `/start-all`) is the sign-off. On an appended phase, `/start-all` publishes and runs only the new tickets: earlier phases' issues are closed and filtered out. Never begin implementation from this command.

Hard rule: the decomposition runs in the **architect** subagent, never inline in this session. If the subagent cannot be launched or fails, report that and stop — do not absorb its role.
