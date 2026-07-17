# testbed — E2E testing for the pattern chain

Two levels. Level 0 is the repo's mechanical merge gate; Level 1 is the live
pattern rehearsal on a real (tiny) project.

## Level 0 — deterministic E2E (zero tokens, zero network)

```
node testbed/e2e/run-e2e.mjs
```

| Suite | What it proves |
|---|---|
| `suite-integrity` | Every scaffold file exists; agent frontmatter pins exactly the model/effort the pattern README documents; wiring files parse; no forbidden runtime APIs in workflow scripts |
| `suite-guard` | The write guard denies main-session Edit/Write with a dispatch instruction, passes subagent calls, never blocks on garbage input, honors the `.claude/allow-main-writes` override |
| `suite-publish` | `publish-tickets.mjs` against fake `gh`/`glab` CLIs (via `GH_BIN`/`GLAB_BIN`): idempotent exact-prefix matching, ambiguity handling, create + number capture, label retry, failure keeps the machine-readable summary and exits 1, degraded no-CLI paths |
| `suite-runner` | The ACTUAL `run-milestone.js`, executed with stubbed `agent()`: happy path, bounce-then-clear, bounce-cap escalation, reviewer-failure handling (no phantom fixes), hallucinated-DoD gating, supervised stop, wrong-branch/wrong-plan-path failures, config validation, reviewer prompt isolation |
| `app` | The Level-1 target app's own test suite is green |

**Repo rule:** Level 0 must be green before merging any scaffold change.

## Level 1 — live pipeline rehearsal (real agents, costs tokens)

The `app/` directory is a deliberately tiny real project (calc library, `node --test`)
with a ready smoke module: `docs/prd/00-smoke` (SMK-01 subtract, SMK-02 divide).

Procedure (manual, run when scaffolding changes materially or before promoting the
pattern's status):

1. Copy `testbed/app/` to a scratch directory outside this repo; `git init`, commit,
   and create a scratch GitHub/GitLab repo with an authenticated `gh`/`glab`.
2. Install the scaffold per `patterns/three-agent-architect-builder-reviewer/scaffold/INSTALL.md`.
3. Run `/start-milestone docs/prd/00-smoke supervised` and follow the pipeline through
   both tickets; then `/verify-delivery` each.
4. Record the outcome (date, model versions, anything that failed) in the pattern
   README §4/§7 as an `[internal]` observation. A green first run is the promotion
   trigger from `trialed` to `adopted`.

## Testing policy (why this directory exists)

Team policy (2026-07-17): in every pattern, the **agents** own unit, integration,
and E2E tests — run manually or wired into the pipeline as fits the project. The
human's only test duty is the final smoke test once the PRD's tasks are all done
(Gate 2). This testbed is the pattern catalog holding itself to that same bar.
