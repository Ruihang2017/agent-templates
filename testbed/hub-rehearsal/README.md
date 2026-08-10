# hub-rehearsal — Level-1 target for `hub-and-spoke-orchestrator-executors`

A small real project used to rehearse the whole pattern against the **real** Codex CLI.
Not useful software; its only job is to be implementable and to fail loudly when it is
implemented wrongly.

```
node testbed/hub-rehearsal/rehearse.mjs [--concurrency 2] [--keep] [--codex <bin>]
```

**This spends real tokens.** It invokes the executor once per brief, plus once per repair
round. Nothing in `run-e2e.mjs` calls it — the Level-0 gate stays deterministic and free.
Run it deliberately, when the executor integration itself needs proving.

## What is here

| Path | What it is |
|---|---|
| `docs/PRD.md` | The specification. The single source of truth for everything else here |
| `docs/briefs/*.md` | Four briefs, decomposed from the PRD by an Opus 5 hub following `/hub-brief` |
| `test/*.test.mjs` | The project's tests, written from the PRD **before** any implementation |
| `package.json` | Zero dependencies, `node --test` |
| `rehearse.mjs` | The runner |
| `src/` | **Deliberately absent.** The spokes create it |

## Why it is shaped this way

A single-brief rehearsal proves the executor can be invoked. It proves nothing about the
pattern. This target adds the parts that only appear at scale:

- **A dependency graph.** `MNY-01` and `CAT-01` have no dependencies; `RPT-01` needs both;
  `CLI-01` needs `MNY-01`. So wave 1 is two briefs and wave 2 is two briefs, and wave 2
  cannot start until wave 1 is merged.
- **Disjoint file ownership.** One module per brief, so the scope audit has something real
  to be right about, and a spoke that strays is genuinely detectable.
- **Contracts that can fail.** Exact error messages, integer-cent money (no floats),
  ordered categorisation rules, and two different errors from the same CLI flag. A
  plausible-but-wrong implementation fails rather than passing.

Two traps are deliberate, and both were caught by the tests rather than by inspection:

- `"Airport Cafe"` contains both `air` and `cafe`. Rule order makes it `travel`. An
  unordered lookup passes every single-rule case and fails this one.
- `--min` produces `parseArgs: --min needs a value` when the value is missing, but
  `parseAmount: malformed amount` when the value is present and bad. Rewrapping the second
  is the natural mistake.

## The runner never touches this repository

The project is copied to a temp directory and `git init`-ed there, so the `spoke/*`
branches and worktrees land in a throwaway repo. The catalog repo never grows a spoke
branch. Same rule as the three-agent rehearsal: a rehearsal never writes a real default
branch.

Pass `--keep` to leave the workspace behind for inspection; its path is printed.

## What a passing run proves, and what it does not

**Proves:** the driver's flags are accepted by the real executor; a hub-written brief is
implementable by a `low`-effort executor; wave scheduling and concurrent worktrees work;
the collect gate merges only what it verified; the project's own suite is green afterwards.

**Does not prove:** that the hub would catch its own wrong brief. The same session wrote
the PRD, the tests and the briefs, so every contract agrees with itself by construction —
which is exactly the circularity the pattern's README §2 describes. This rehearsal is
evidence about the machinery, never about the judgement.

Recorded results are in the pattern's README §4 and §7.
