---
description: Hub stage 3 — re-audit each spoke branch, re-run its tests, review the diff, and merge only what clears the deterministic gate
argument-hint: [briefs-dir] [--all | ID ...] [--merge]
---

Arguments: `$ARGUMENTS` — optional briefs directory (default `docs/briefs`), the spoke ids or `--all`, and `--merge` when you intend to land them.

## Read this first: your review is not independent

You wrote the contract these branches implement. If a spoke escalated, you may also have repaired the code yourself. You are now reviewing that work in the same session that produced it, which means you and the diff share a blind spot — a misreading in the contract reappears as approval of the code that faithfully implements the misreading.

This is a **known, accepted property of this pattern**, not an oversight (pattern README section 4). It is the price paid for keeping one context and one expensive model. Two consequences follow, and they are not optional:

1. **The deterministic gate outranks your opinion.** `collect.mjs` checks scope, firewall, emptiness, and the test exit code with no stake in the outcome. If it says `blocked`, the branch does not land, however convinced you are that the code is fine.
2. **Review against the PRD and the code, not against your own brief.** Re-read the PRD section the brief cites, then ask whether the *brief itself* was right. That is the failure this topology cannot otherwise catch, so it is the one to spend attention on.

## 1. Run the gate

```
node .claude/scripts/collect.mjs --briefs docs/briefs --all
```

| State | Meaning |
|---|---|
| `clear` | audit passed **and** the test command was run here and exited 0 |
| `unverified` | audit passed but the tests could not be run (the worktree is gone) |
| `blocked` | audit failed, the branch is empty, or the tests ran and failed |

`unverified` is not a pass and never merges. Re-create the worktree and re-run rather than arguing it is probably fine.

## 2. Review each `clear` branch

```
git diff <base>...spoke/<ID>
```

Read the diff against the PRD and the existing code, in this order:

1. **Contract adherence** — does the diff match the types, signatures and error shapes the brief fixed? A drifted signature is the failure most likely to survive a green test run.
2. **Idempotency** — under a retry, a duplicate delivery, or two concurrent callers, does this corrupt state or deadlock?
3. **Secrets and error handling** — is anything hardcoded that should not be? Is a failure path swallowed silently?
4. **Was the brief right?** The one check nothing else in this pipeline performs.

If the diff is wrong, fix it on the spoke branch yourself or re-cut the brief and re-dispatch. Do not merge and fix afterwards.

## 3. Merge what survives

```
node .claude/scripts/collect.mjs --briefs docs/briefs --all --merge
```

Merges are `--no-ff`, one branch at a time, and refuse to run against a dirty working tree. **A merge conflict is aborted, not resolved**: two spokes contending for the same path means the decomposition was wrong, and resolving the conflict by hand would hide the decomposition error that produced it. Re-cut those briefs instead.

## 4. Clean up and report

```
git worktree remove .claude/worktrees/<ID>
git branch -d spoke/<ID>
```

Report: what merged, what did not and why, what you changed yourself, and anything you could **not** verify — stated as unverified rather than assumed. Then hand back to the human for the Gate 2 smoke test.
