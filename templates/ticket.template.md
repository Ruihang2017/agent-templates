<!-- Universal ticket template — all patterns, plus the catalog repo itself.
     Format distilled 2026-07-17 from the team's field-proven tickets: fx-eye-tracking
     discipline, realtime-pilot PIL-15, MeritAI FND-9.
     Copy to docs/prd/<NN-module>/tickets/<ID>-<slug>.md and fill every section.
     Cold-start rule: a ticket is DEFECTIVE if executing it requires the planning
     conversation. Inline the needed facts AND link their authoritative source.
     The body below the frontmatter becomes the tracker issue body verbatim
     (.claude/scripts/publish-tickets.mjs); the file stays the content source of truth. -->
---
id: MOD-NN            # unique + stable; becomes the issue-title prefix "[MOD-NN]" (the dedupe key)
title: Short imperative title
module: NN-module     # = parent directory name under docs/prd/
lane: NN-module       # parallel lane; lanes may run concurrently ONLY with disjoint file-scopes
size: S               # S | M | L
agent: builder        # primary executing stage; justify in the "Why" line below
status: draft         # draft -> ready -> done
date: YYYY-MM-DD
blocked_by: []        # ticket ids this one cannot start before (machine-readable dependency DAG)
blocks: []            # ticket ids waiting on this one
---

# MOD-NN — Short imperative title

Implements <PRD §X FR-Y> per <ADR-NNNN (status, owner, date, via PR #N)> — or: "No ADR —
the decision is already made in <ref>; this is build ticket <n of m> against it."
Parent sub-PRD: [NN-module README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [MOD-NM — other ticket](MOD-NM-other-ticket.md) <!-- mirrors blocked_by; delete if none -->
**Why `builder`:** <one line — the basis for the agent assignment, e.g. "a narrowly-scoped
addition to an existing module, not a new subsystem">.

## Background + basis

<!-- Why this ticket exists. CITE every claim: PRD §, ADR section, stable decision ID, or a
     merged PR — a conclusion may not appear from nowhere. QUOTE the load-bearing sentences
     of the ADR/spec so the Builder does not re-derive intent.
     Carry known caveats forward EXPLICITLY ("accepted for the pilot: X — documented, not
     enforced, per PRD §Y") instead of re-litigating or silently dropping them. -->

## Goal

<!-- One paragraph: the artifact(s)/behavior to produce and where they land — stated so
     completion is mechanically checkable. -->

## Non-goals

<!-- Bullet list. EACH exclusion names its owner or standing reason, so nobody guesses:
     - No schema files — those are MOD-02.
     - No init authentication — stays documented-not-enforced per PRD §9.4. Do not add it
       as a side effect of this ticket. -->

## File-scope (write-owns)

<!-- Exact paths/globs this ticket may write, PLUS the explicit does-not-touch list.
     State the serial-safety analysis: which tickets last touched these files, whether that
     work is merged, and that no in-flight ticket contends for them. Must not overlap any
     other in-flight ticket — disjoint file-scopes are what make parallel lanes safe.
     Internal organization inside the scope is the Builder's choice. -->

- <paths this ticket owns>
- Does not touch: <paths owned elsewhere — name the owning ticket/module>

## Deliverables

<!-- Numbered, code-level precision: exact functions/exports, call sites, ordering
     constraints ("directly after X and before Y"), naming conventions, and the behavioral
     guarantee ("either fully visible or fully absent"). Fix the boundary AND the
     load-bearing mechanics; leave internals free. -->

1. <deliverable>

## Acceptance checklist (classified)

<!-- Every criterion is a checkbox with exactly one class tag. The tag VOCABULARY is
     project-defined in the target repo's CLAUDE.md — defaults: [machine] runnable
     code/logic check · [fixture] replay of recorded data · [human] irreducibly human
     judgment. Field vocabularies in use: [offline]/[live-model] (realtime pilot),
     [machine]/[fixture]/[hardware-human] (fx-eye-tracking).
     Rules: cover the pyramid where applicable — unit / integration / E2E; agents own all
     three levels, the human only smoke-tests at PRD completion. Include the standing
     suite-green item. If the ticket must conclude an open question, make the WRITEBACK
     itself an acceptance item. Mark optional orchestrator-owned live checks "not required
     to merge". Declare absent classes explicitly ("No [human] criteria — pure logic"). -->

- [ ] `[machine]` <criterion> (<cross-ref to AC/decision id>)
- [ ] `[machine]` <project test-suite command> green

## Test plan

<!-- The exact steps the Reviewer runs. NAME the harness/mocks/fixtures and the existing
     test file whose construction pattern to copy. Say what is asserted, on what. Every
     [machine]/[fixture] row must be reproducible offline. -->

## Feedback obligation

<!-- The writeback protocol, made concrete — three layers:
     1. General rule: if implementation falsifies this spec, update this ticket / the
        sub-PRD / the ADR first (version +0.1, changelog line), then change code. Silent
        divergence = incomplete.
     2. ENUMERATE the foreseeable frictions, each with its exact writeback target and path:
        "if X cannot be expressed as Y → update docs/design-Z.md and ADR-NNNN's
        consequences section FIRST, before touching src/W — a bigger surface than this
        ticket's goal must not change silently."
     3. If a decided protocol is outright falsified: that overturns a team decision —
        escalate for re-review; never swap the approach silently inside the ticket. -->
