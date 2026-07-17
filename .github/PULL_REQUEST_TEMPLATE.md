## Summary

<!-- What does this PR do? One sentence. -->

## Related issue / ticket

<!-- Closes #N — plus the ticket id, e.g. [MOD-NN]. The ticket FILE stays the content
     source of truth; the issue holds state. -->

## Type

<!-- Check one; matches conventional-commit prefixes. -->

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `refactor` — restructuring, no behavior change
- [ ] `docs` — documentation / ADR only
- [ ] `test` — new or updated tests
- [ ] `ci` / `chore` — tooling, maintenance

## Changes

<!-- Bullets: what changed AND why. Include what was tried and rejected if it shaped the result. -->

-

## Design note

<!-- Hard-to-reverse or non-obvious changes: link the ADR (docs/adr/NNNN-*.md) — add one if
     this is a durable decision. Otherwise summarize inline: problem · affected components ·
     contract/schema changes · risks. -->

## Pipeline evidence

<!-- Assumes the installed pattern; the three-agent pattern's items are shown — adapt if
     this repo runs a different pattern. -->

- [ ] Plan: `docs/plans/<ticket-id>.md` (link)
- [ ] Builder: REAL test output attached (unit / integration / E2E as the ticket requires) — never "should pass"
- [ ] Reviewer verdict: **CLEAR**, from a fresh context (link or paste the note; bounces: <n>)
- [ ] Deviations from the plan recorded (or "none")
- [ ] Post-merge: `/verify-delivery <ticket-id>` runs — the issue closes only after it passes

## Constraint check

<!-- At install time, copy this repo's non-negotiables from its CLAUDE.md here as
     checkboxes. Tick what this PR touches; mark the rest N/A. Two universal items: -->

- [ ] No hardcoded secrets (keys, tokens, credentials) in code / config / logs / docs
- [ ] Docs / ADR / ticket updated if behavior or a decision changed (feedback obligation)

## Evidence

<!-- Test output, before/after screenshots (UI), command + output (CLI/API), or a short repro. -->
