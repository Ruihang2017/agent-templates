<!-- Ticket template — three-agent pattern.
     Format adapted from fx-eye-tracking's ticket discipline (read 2026-07-17).
     Copy to docs/prd/<NN-module>/tickets/<ID>-<slug>.md and fill every section.
     Cold-start rule: a ticket is DEFECTIVE if executing it requires the planning
     conversation. Inline the needed facts AND link their authoritative source.
     This file's body (below the frontmatter) becomes the tracker issue body verbatim
     via .claude/scripts/publish-tickets.mjs — the file stays the content source of truth. -->
---
id: MOD-NN            # unique + stable; becomes the issue-title prefix "[MOD-NN]" (the dedupe key)
title: Short imperative title
module: NN-module     # = parent directory name under docs/prd/
size: S               # S | M | L
agent: builder        # primary executing stage; normally builder (the pipeline runs all three)
status: draft         # draft -> ready -> done
date: YYYY-MM-DD
---

# MOD-NN — Short imperative title

Parent sub-PRD: [NN-module README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [MOD-NM — other ticket](MOD-NM-other-ticket.md) <!-- delete this line if no dependencies -->

## Background + basis

<!-- Why this ticket exists. Cite every claim to a PRD section, ADR, or a stable decision ID —
     a conclusion may not appear from nowhere. -->

## Goal

<!-- One paragraph: the artifact(s) to produce and where they land. -->

## Non-goals

<!-- Bullet list. Each exclusion names its owner so nobody guesses:
     "No schema files — those are MOD-02." -->

## File-scope (write-owns)

<!-- Exact paths/globs this ticket may write. Must not overlap any other in-flight ticket —
     disjoint file-scopes are what make parallel lanes safe later.
     Internal organization inside the scope is the Builder's choice. -->

## Deliverables

<!-- Numbered, concrete outputs with required semantics — fix the boundary, not the internals. -->

## Acceptance checklist (classified)

<!-- Every criterion is a checkbox with exactly one class tag:
       - [ ] `[machine]` <criterion, runnable as a command or test> (cross-ref)
     Tags: [machine] = pure code/logic check · [fixture] = replay of recorded data ·
           [human] = irreducibly human judgment (UX feel, real hardware). Minimize [human].
     Declare absent classes explicitly: "No [human] criteria — pure logic ticket." -->

- [ ] `[machine]` ...

## Test plan

<!-- The exact steps/commands the Reviewer will run to verify. The Reviewer never trusts
     reported results — make every check re-runnable. -->

## Writeback obligation

If implementation falsifies this spec, update this ticket / the parent sub-PRD first
(version +0.1, changelog line), then change the code. Silent divergence = incomplete.
