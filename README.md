# agent-templates

Catalog of reusable multi-agent development architecture patterns. Each entry is a design write-up plus drop-in scaffolding (subagent definitions, slash commands, CLAUDE.md snippets) so a new project reuses a proven pattern instead of redesigning one.

| Pattern | Status | As of | Summary |
|---|---|---|---|
| [three-agent-architect-builder-reviewer](patterns/three-agent-architect-builder-reviewer/README.md) | trialed | 2026-07-17 | Architect plans → Builder implements → independent Reviewer (fresh context, different model tier) clears or bounces; `/start-milestone` runs a whole module autonomously |

- Operating manual, pattern schema, grounding rules: [CLAUDE.md](CLAUDE.md)
- Adding a pattern: start from [templates/pattern-README.template.md](templates/pattern-README.template.md), process in [CLAUDE.md](CLAUDE.md) § "Adding a new pattern"
