---
name: breakdown-prd
description: Decompose a PRD into Codex three-agent sub-PRDs and tickets, enforce append-only phases, and render the global DAG. Use before Gate 1.
---

Resolve the explicitly named Markdown PRD, or default to `docs/PRD.md`. Never fall back from a missing named file.

Run `node .codex/scripts/prd-phase.mjs context docs/prd --prd <prd>` and parse `PHASE-CONTEXT-JSON`. Spawn `architect` in PRD-decomposition mode. Pass the PRD path, relevant ADR paths, the exact phase context, and any focus notes. In append mode, state that every existing file under `docs/prd/` is frozen; only new files may be added unless the user explicitly supplied `--redo` before Gate 1.

After the Architect returns:

1. Run `node .codex/scripts/prd-phase.mjs check docs/prd`. A non-zero result stops the workflow. Report `checked: false` honestly when git could not enforce the freeze.
2. Run `node .codex/scripts/dag-report.mjs docs/prd`. A dangling dependency or cycle stops the workflow.
3. Report the PRD, first/append mode, modules, ticket count, open questions, freeze result, waves, and any fully serial module.
4. Stop for Gate 1. Do not plan or build a ticket.

This pattern's Codex-native runner is sequential even if `dag.html` exposes wider theoretical parallelism. Say so; never recommend a concurrency value greater than 1 for this pattern.

