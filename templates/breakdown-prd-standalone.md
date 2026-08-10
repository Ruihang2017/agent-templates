<!-- STANDALONE PRD-DECOMPOSITION PROMPT — a reference text, not wired into anything.
     Nothing installs, reads, or executes this file: `adopt.mjs` copies only
     `ticket.template.md` and `tracker/` out of templates/. It is here to be copied by hand.

     Use it when a project needs /breakdown-prd-quality tickets but CANNOT adopt the
     pattern — because it already has its own subagent setup, its own directory layout, or
     no Claude Code Workflow tool. Paste the body below into whatever planning role that
     project already has, and adapt the paths.

     If a project CAN adopt the pattern, use `/breakdown-prd` instead. It does strictly
     more: deterministic phase/freeze handling (prd-phase.mjs), a rendered execution DAG
     with a recommended concurrency (dag-report.mjs), and — the part that matters —
     MECHANICAL enforcement of graph correctness (dag-scan.mjs fails on cycles and dangling
     blocked_by). This file can only ask the model to check those itself, which is strictly
     weaker; the § "Before you present" pass exists to make that gap explicit rather than
     invisible.

     Source of the rules: templates/ticket.template.md plus the three-agent pattern's
     architect definition. If the ticket template changes, re-derive this file from it —
     it is a copy, and copies drift.

     Added 2026-08-07 (catalog issue #154). Not a pattern; not on the catalog site. -->

# PRD decomposition — standalone prompt

You are decomposing a PRD into sub-PRDs and tickets. You are **planning, not building**:
you write planning artifacts only, never production code, tests, or config. When the
decomposition is done you **stop** and hand it to a human for sign-off. Beginning
implementation from this prompt is a failure, however obvious the first ticket looks.

## Inputs

- The PRD (path given to you). If it does not exist, stop and say so — never silently
  decompose a different file.
- Any existing architecture-decision records, design docs, or prior sub-PRDs. Read them.
  They constrain you; a ticket that contradicts a recorded decision is a defect.
- The existing codebase. Explore it before deciding module boundaries. Boundaries guessed
  from the PRD alone will not match where the code actually is.

## Outputs

1. **A breakdown plan** — the module split, the file-ownership allocation table, and the
   ticket dependency graph.
2. **One sub-PRD per module** — problem, scope, non-goals, decisions (each with its basis),
   rejected alternatives, open questions (each with an owner), the work-breakdown table,
   acceptance, changelog.
3. **One file per ticket**, in the format below.

Adapt the paths to your repo's conventions. Nothing below depends on a particular layout.

---

## How to cut modules

Cut on **file ownership**, not on feature names.

Two tickets may run in parallel only if their write-sets are disjoint. So the module split
is a partition of the filesystem, and the question for every boundary is "who writes these
files", not "do these features feel related".

- Anything shared by several modules — schemas, contracts, types, config loaders — goes
  into **one foundation module that is built first**. Duplicating a shared contract across
  modules to avoid a dependency is how you get two incompatible versions of it.
- If a module's tickets form one straight `blocked_by` chain, it can never use more than
  one lane. That is a **decomposition problem to fix now**, while tickets are cheap to
  change — not a scheduling detail to discover mid-run.
- Prefer more, smaller tickets over fewer large ones, but never split a ticket in a way
  that puts one behavioral guarantee in two tickets. A half-enforced invariant is worse
  than an unimplemented one.

---

## Ticket format

```markdown
---
id: MOD-NN            # unique, stable, never reused
title: Short imperative title
module: NN-module
size: S               # S | M | L
blocked_by: []        # ticket ids this cannot start before — the machine-readable DAG
blocks: []            # ticket ids waiting on this
---

# MOD-NN — Short imperative title

Implements <PRD §X FR-Y> per <decision record, with status/owner/date>.
Or: "No decision record — the decision is already made in <ref>; this is build ticket
<n of m> against it."
Depends on: <links mirroring blocked_by; delete if none>

## Background + basis

Why this ticket exists. **Cite every claim** — a PRD section, a decision record, a merged
PR. A conclusion may not appear from nowhere. **Quote the load-bearing sentences** rather
than paraphrasing, so the implementer does not have to re-derive intent and cannot
re-derive it differently.

Carry known caveats forward explicitly ("accepted for now: X — documented, not enforced,
per PRD §Y") instead of re-litigating or silently dropping them.

## Goal

One paragraph: the artifact or behavior to produce and where it lands, stated so that
completion is mechanically checkable.

## Non-goals

Each exclusion **names its owner or standing reason**, so nobody has to guess whether it
was forgotten:

- No schema files — those are MOD-02.
- No auth on init — stays documented-not-enforced per PRD §9.4. Do not add it as a side
  effect of this ticket.

## File-scope (write-owns)

Exact paths or globs this ticket may write, **plus an explicit does-not-touch list**.

State the serial-safety analysis: which tickets last touched these files, whether that work
is merged, and that no in-flight ticket contends for them.

- <paths this ticket owns>
- Does not touch: <paths owned elsewhere — name the owning ticket>

Internal organization inside the scope is the implementer's choice.

## Deliverables

Numbered, at **code-level precision**: exact functions and exports, call sites, ordering
constraints ("directly after X, before Y"), naming, and the behavioral guarantee
("either fully visible or fully absent"). Fix the boundary and the load-bearing mechanics;
leave internals free.

## Acceptance

Every criterion is a checkbox with exactly one class tag. Defaults — adapt to your repo:
`[machine]` a runnable check · `[fixture]` a replay of recorded data · `[human]`
irreducibly human judgment.

- [ ] `[machine]` <criterion — with the exact command and expected result>
- [ ] `[machine]` <project test-suite command> green

Declare absent classes explicitly ("No `[human]` criteria — pure logic"). If the ticket
must resolve an open question, make the **writeback itself** an acceptance item.

## Test plan

The exact steps a reviewer runs. Name the harness, the mocks, the fixtures, and an
existing test file whose construction pattern to copy. Say what is asserted, on what.
Every `[machine]`/`[fixture]` row must be reproducible offline.

## Feedback obligation

1. If implementation falsifies this spec, update **this ticket** (and the sub-PRD or
   decision record) first, then change code. Silent divergence is an incomplete ticket.
2. Enumerate the foreseeable frictions, each with its exact writeback target: "if X cannot
   be expressed as Y → update `docs/design-Z.md` first, before touching `src/W` — a
   surface bigger than this ticket must not change silently."
3. If a decided protocol is outright falsified, that overturns a team decision — escalate
   for re-review. Never swap the approach silently inside the ticket.
```

---

## The seven rules that actually determine quality

Everything above is structure. These are what make the difference between a ticket that
executes cleanly and one that produces an argument.

### 1. Cold-startable, or it is defective

The implementer will be a fresh agent with **no access to this conversation**. If executing
the ticket requires anything said while planning, the ticket is broken. Inline the needed
facts *and* link their authoritative source.

Test it on yourself: read only the ticket file. Can you start? If you reach for something
you know only from planning, put that in the ticket.

### 2. The ticket is the source of truth (WHAT); plans are HOW

An implementation plan may record the concrete path — change list, tests, risks. It may
**never** carry spec the ticket lacks. On any disagreement the ticket wins. If planning
reveals the ticket is wrong, the fix is a change to the **ticket**, not a patch in the plan.

### 3. Acceptance criteria must be able to fail

This is the one most often got wrong, and it is worth more than the other six combined.

An acceptance criterion that passes against today's code proves nothing. Before writing
each one, ask: **what would make this fail?** If you cannot answer, it is decoration.

Specific traps, all seen in practice:

- **"Exits non-zero"** — a missing file also exits non-zero. Assert the *reason*: the
  specific error code, or a machine-readable field, not just the exit status.
- **Asserting on the code's own report** — "the summary says 0 duplicates" passes for code
  that created duplicates and then miscounted them. Assert on the *external* observable:
  what the API/filesystem/database actually contains.
- **A condition that is already true for unrelated reasons** — "flag X is false after Y"
  is worthless if X is false for three other reasons too. Either assert the specific cause,
  or move the check somewhere with no such blind spot.
- **A gate that cannot discriminate** — if a check would pass on both the correct and the
  broken version, it is not a check.

So: for each `[machine]` criterion, state **what breaking would make it fail**. That one
line forces the criterion to be real, and it tells the reviewer how to verify the test
itself rather than trusting it.

### 4. Non-goals carry owners

"Not in scope" without an owner reads as an oversight, and a helpful implementer will add
it. "No X — that is MOD-04" cannot be misread. This is the cheapest scope control there is.

### 5. File-scope is a contract, not a hint

The does-not-touch list is what makes parallel work safe and what makes review tractable.
A ticket that writes outside its scope has silently taken ownership of files another ticket
is holding. State the serial-safety analysis explicitly — it forces you to check.

### 6. The dependency graph must be real

`blocked_by` is machine-readable. Before presenting, verify by hand:

- every id in every `blocked_by` and `blocks` **exists**;
- `blocked_by` and `blocks` are **mutually consistent** (if A blocks B, B is blocked_by A);
- there is **no cycle** — walk it;
- no **duplicate ids** anywhere in the tree.

A dangling reference or a cycle fails the whole graph, and it is far cheaper to catch now
than when a run deadlocks.

### 7. Size is a review budget, not an effort estimate

A ticket is too large when its diff can no longer be reviewed carefully in one sitting.
Split on that, not on how long it takes to write.

---

## Before you present: self-verification

Your project has no script to catch these, so do the pass explicitly and **report the
result, including anything you could not check**.

1. **Graph** — dangling refs, cycles, duplicate ids, `blocked_by`/`blocks` consistency.
2. **Scope overlap** — take the union of every ticket's write-set. Any path claimed by two
   tickets that are not ordered by `blocked_by` is a collision. List them.
3. **Cold start** — pick the two most complex tickets, read only the ticket, and confirm
   you could start. Say which two you checked.
4. **Acceptance** — for each ticket, confirm at least one criterion would fail against
   today's code. Name any ticket where you could not construct such a criterion; that is
   usually a sign the goal is not yet concrete.
5. **Serial modules** — flag any module whose tickets form one chain.
6. **Coverage** — every PRD requirement maps to at least one ticket. List anything in the
   PRD you deliberately deferred, with the reason.

State plainly what you could **not** verify. An unrun check reported as a passed one is
worse than no check.

## Then present and stop

- modules created, ticket count, open questions with owners;
- the self-verification results, including anything unverified;
- any module flagged fully serial, and what you would change;
- anything in the PRD you deferred and why.

Then **stop**. This output is the input to a human review. Do not begin implementation.
