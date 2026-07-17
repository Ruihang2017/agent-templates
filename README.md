# agent-templates

Catalog of reusable multi-agent development architecture patterns. Each entry is a design write-up plus drop-in scaffolding (subagent definitions, slash commands, CLAUDE.md snippets) so a new project reuses a proven pattern instead of redesigning one.

| Pattern | Status | As of | Summary |
|---|---|---|---|
| [three-agent-architect-builder-reviewer](patterns/three-agent-architect-builder-reviewer/README.md) | trialed | 2026-07-17 | Architect plans → Builder implements → independent Reviewer (fresh context, different model tier) clears or bounces; `/start-milestone` runs a whole module autonomously |

- **Applying a pattern to your project** (new — even a bare `PRD.md` — or existing): [ADOPTING.md](ADOPTING.md) — one command: `node scripts/adopt.mjs <pattern> <target-dir>`
- Operating manual, pattern schema, grounding rules: [CLAUDE.md](CLAUDE.md)
- Adding a pattern: start from [templates/pattern-README.template.md](templates/pattern-README.template.md), process in [CLAUDE.md](CLAUDE.md) § "Adding a new pattern"
- E2E testing for the pattern chain: [testbed/README.md](testbed/README.md) — `node testbed/e2e/run-e2e.mjs` is the merge gate for scaffold changes
