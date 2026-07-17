# agent-templates

Catalog of reusable multi-agent development architecture patterns. Each entry is a design write-up plus drop-in scaffolding (subagent definitions, slash commands, CLAUDE.md snippets) so a new project reuses a proven pattern instead of redesigning one.

## Quickstart — from a bare `PRD.md` to a running pipeline

```
cd path\to\my-project        # contains PRD.md; git init + remote done; gh/glab authenticated
npx github:Ruihang2017/agent-templates adopt three-agent-architect-builder-reviewer .
```

(Public repo — the npx form works for anyone, no credentials. From a checkout instead: `node scripts/adopt.mjs three-agent-architect-builder-reviewer <target-dir>`.)

1. Review `CLAUDE.md`: add project facts, keep **Operating mode: `supervised`**; fill the PR template's Constraint check from your non-negotiables.
2. In Claude Code, inside the project: **`/breakdown-prd`** — the Architect turns `docs/PRD.md` into sub-PRDs + tickets, then stops for your review.
3. **Gate 1** — review the breakdown, then **`/start-milestone docs/prd/00-<module> supervised`**: tickets publish as tracker issues; each ticket runs plan → build → fresh-context review to CLEAR, pausing for your merge.
4. When it holds, flip to `autonomous` — whole milestones run hands-off. **Gate 2** = your smoke test at the end. Full guide: [ADOPTING.md](ADOPTING.md).

| Pattern | Status | As of | Summary |
|---|---|---|---|
| [three-agent-architect-builder-reviewer](patterns/three-agent-architect-builder-reviewer/README.md) | trialed | 2026-07-17 | Architect plans → Builder implements → independent Reviewer (fresh context, different model tier) clears or bounces; `/start-milestone` runs a whole module autonomously |

- **Applying a pattern to your project** (new — even a bare `PRD.md` — or existing): [ADOPTING.md](ADOPTING.md) — one command: `node scripts/adopt.mjs <pattern> <target-dir>`
- Operating manual, pattern schema, grounding rules: [CLAUDE.md](CLAUDE.md)
- Adding a pattern: start from [templates/pattern-README.template.md](templates/pattern-README.template.md), process in [CLAUDE.md](CLAUDE.md) § "Adding a new pattern"
- E2E testing for the pattern chain: [testbed/README.md](testbed/README.md) — `node testbed/e2e/run-e2e.mjs` is the merge gate for scaffold changes
