---
title: Testbed calc library — master PRD
status: accepted
owner: agent-templates maintainer
date: 2026-07-17
version: 0.1
---

# Testbed calc library — master PRD

Purpose: a deliberately tiny, real project used to exercise the three-agent
Architect–Builder–Reviewer pattern end to end (Level-1 live E2E in
`testbed/README.md`). The product is a pure-function calculator library with a
`node --test` suite.

## Scope

- v0.1 ships `add` and `multiply` (already implemented).
- Module `00-smoke` adds `subtract` (SMK-01) and `divide` with a division-by-zero
  guard (SMK-02) — sized so a full pipeline run stays cheap.

## Acceptance

- `npm test` green after every merged ticket.
- Every ticket flows through the three-agent pipeline; no direct-to-main commits.

## Non-goals

- Anything beyond pure functions (no I/O, no CLI, no deps) — the project exists
  to test the pipeline, not to be useful.
