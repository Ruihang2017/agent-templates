# Changelog

What changed for someone **using** this catalog. The full decision record — why each change was made, what evidence backed it, and what is still unmeasured — lives in each pattern's README § 7 provenance log and § 4 pitfalls.

## 0.14.0 — 2026-08-18

**Breaking, and it needs a re-adopt.** `npx agent-templates@latest adopt three-agent-architect-builder-reviewer .` over your existing install. Two workflow files are **retired** and `adopt` now deletes them for you — the removal shows up in your git diff, so review it before committing if you had customised either.

### The delivery agent is gone (#206)

If you ran this pattern, there was a fourth agent you probably never noticed. It had no role file, no `agentType`, no model pin — just an inline prompt. Its whole job was: check a file is non-empty, fill in your PR template, run one command, repeat back the JSON that command printed.

It made no judgement, and having its own context was actively harmful. Because the Reviewer's approval lived in one context and delivery in another, the verdict had to be **handed across and re-typed by a third party** — which safety classifiers read as one agent writing another agent's approval, and blocked. Three times, in one adopting repo, each time stranding a ticket that had already been cleared.

So it is deleted rather than patched. Delivery is now yours: your session, which was idle for the entire run and already held every artifact that agent had to be handed. `/deliver-ticket <id>` is the new command for one ticket; the wave commands run the same procedure for a whole wave.

The remaining agents map exactly onto the three judgements this pattern exists to separate: **architect · builder · reviewer** (plus `triage` for the nightly sweep). The name stopped being an approximation.

### What that changes for you: the pipeline runs in waves

This follows from a constraint rather than a preference. A workflow script has no filesystem and no exec, so the only thing inside a running workflow that could invoke the delivery script was an agent. No agent means no merge inside a run — and a ticket therefore cannot share a run with its blocker, because a dependent builds from a default branch that must already contain its dependency.

Work moves in **waves**: a set of tickets whose blockers have all landed.

```
wave-plan.mjs  ->  Workflow(run-wave)  ->  compose PR bodies  ->  deliver-wave.mjs  ->  repeat
 which tickets      plan / build /          your only            merge, close,
 may run now          review                writing job           clean up
```

**The cost, stated plainly:** a fast ticket now waits for the slowest ticket in its wave before its dependents start. `dag-report.mjs` already modelled the run this way and described its round count as an upper bound ("actual wall-clock is at most this many rounds") — that count is now exact rather than pessimistic.

**What you gain:** the DAG is live for free. `wave-plan.mjs` re-reads `docs/prd` every wave, so a ticket added mid-run is simply in the graph next time it is read. No reload agent, no `rescanEvery` to tune, no runaway guard on reloads.

### Migration

| Was | Now |
|---|---|
| `.claude/workflows/run-milestone.js` | `.claude/workflows/run-wave.js` (retired file auto-removed) |
| `.claude/workflows/start-all.js` | `.claude/workflows/run-wave.js` + `.claude/scripts/wave-plan.mjs` |
| scheduling inside the workflow | `.claude/scripts/wave-plan.mjs` — deterministic, exits non-zero on a broken graph |
| delivery inside the workflow | `.claude/scripts/deliver-wave.mjs` + your session |
| ticket status `delivered` from the workflow | `reviewed-clear` — **nothing has been delivered** until you run the delivery step |

`/start-all`, `/start-milestone` and `/nightly-issues` keep their names and arguments. If you drive the workflows directly rather than through the commands, the args changed — see the header of `run-wave.js`.

### Also fixed

- **The Reviewer writes its own review record** to `.claude/tmp/<id>-verdict.md`. Nothing re-types it anywhere: the workflow carries the path, your session checks the file is non-empty, `deliver-ticket.mjs` posts it. A missing or empty record is now a **refusal to deliver** — an unevidenced review must not become a merge (#201).
- **Local delivery (`none`) was broken in two ways.** The mid-run reload read the ledger at `.claude/delivered.json` while `deliver-ticket.mjs` writes `docs/delivered.json`, so every delivered ticket read as open and got re-planned and re-built; and the completion check required `issueClosed` in a mode that has no tracker, so a ticket that delivered correctly was reported `delivery-incomplete`. Both are gone with the retired files.
- **A failed ticket no longer stops its wave.** A wave is independent by construction, so there is nothing inside it to cascade to; its dependents surface as `unreachable` at the next boundary, named with the blocker that failed them, never silently dropped.
- **A mistyped `--module` exits non-zero** instead of reporting "nothing left to run". A run that executed zero tickets must never read as complete.
- **The write guard is narrower where it should be and unchanged everywhere else.** The main session may now write under `.claude/tmp/` — that is where it composes the PR body — and nowhere else. Containment is checked with `path.relative`, so `.claude/tmp/../../src/app.ts` is still denied.
- **`adopt` removes retired files.** Declared in `scaffold/pattern.json`; previously nothing told a re-adopt that an old file had become wrong.
- **The Codex pattern deliberately keeps its `delivery` actuator.** Its primary thread runs `sandbox_mode = "read-only"` and physically cannot write a file or run git, so the role exists for a mechanical reason rather than an architectural one; opening that sandbox would trade a real enforcement mechanism for symmetry, and `workspace-write` is separately reported unusable on restricted Windows hosts (#203). It gains `wave-plan.mjs` and `deliver-wave.mjs` under the existing parity gate, and its skills now take the ready set from the planner instead of reading `blocked_by` in prose.

Suite: 1647 checks. The three retired suites (`suite-runner`, `suite-parallel`, `suite-startall`) were replaced by `suite-wave`, `suite-waveplan` and `suite-deliverwave` — ported, not dropped, because removing a scheduler must not quietly remove the checks that made it trustworthy.

## 0.13.2 — 2026-08-12

**Scaffold change — re-adopt to get it.** `deliver-ticket.mjs` changes in both runtimes, and the Codex pattern's `run-ticket` skill and `delivery` agent contract change. `npx agent-templates@latest adopt <pattern> .` over your existing install.

Both fixes are the same defect wearing two hats: a report that reads complete while describing something that did not happen — in the two places a human actually reads.

### Fixed — supervised delivery said two untrue things on one run (#192)

If you run `deliver-ticket.mjs --no-merge` (supervised mode, and the on-ramp we recommend for a first pipeline), the PR it opened carried an AI-attribution block reading that the change was *"written and merged by AI"*. Nothing had been merged — the entire point of the mode is that the PR waits for you. Anyone trusting that sentence reviewed a change believing it was already live, which inverts the decision they were being asked to make.

The same run reported `planExists: false` for a plan sitting on disk, because the check was computed after the early exits. An unperformed check reported as a failed one is worse than no check: it spends your attention on a defect that does not exist, and teaches you to discount the rest of the summary.

Now: the marker is conditional on the mode and states plainly that the PR is open and awaiting human review; `planExists` is evaluated before any exit; and a genuinely missing plan is a refusal rather than a footnote under an otherwise-clean summary.

### Fixed — the Codex pattern shipped two contracts that contradicted each other (#193)

`run-ticket` step 5 told the orchestrating thread to have the `delivery` agent *compose* your repository's PR/MR template. `delivery.toml` defines that same agent as a mechanical actuator at low reasoning effort that may write only **supplied** text and must not invent a verdict or a body. Whichever document an operator followed, the other was violated.

It resolves one way only. A complete PR body carries the bounce count, the Reviewer's actual findings, the Builder's declared deviations, the test evidence and the known gaps — none of which `delivery` ever sees. Asking it to compose meant asking a deliberately low-effort role to produce fluent, plausible review history for the one document you read *instead of* re-running the pipeline.

Now: the orchestrating thread composes the body from named stage artifacts (the skill carries a section→source table), any fact absent from an artifact must be written as unavailable **with a reason** rather than inferred, and `delivery` writes the supplied bytes verbatim. `delivery.toml` refuses a compose request outright.

### Also

The E2E suite asserts both sides of the #193 contract — a one-sided assertion is how those two documents drifted apart with every gate green — and the suite's own `assertAiMarker` was rewritten, because it had been asserting the false "merged" wording and was therefore part of the defect rather than a witness to it. Suite: 1620/1620.

## 0.13.1 — 2026-08-12

**No scaffold change.** Nothing under `.claude/`, `.codex/`, `.agents/` or `integrations/` differs from 0.13.0, so there is nothing to re-adopt — this is the catalog site and the README. Upgrade only if you read the docs from the package.

### Changed — the site is a landscape layout now

It was built at `max-width: 880px`: a phone layout stretched down a desktop monitor, on a catalog people read in a browser next to an editor. Almost every section laid out **down** the page when it had room to lay out **across**.

| | Was | Now |
|---|---|---|
| Container | `max-width:880px` | `min(1560px, 94vw)` |
| Nav | none | sticky bar — section links, GitHub, npm |
| Hero | panel + narrow sidebar, stats stacked below | three columns (title / install / facts), stats as one horizontal band |
| Pattern selection | a row of pills above one column | a sticky rail beside a detail panel, each entry saying what the pattern is *for* |
| Commands | one wrapping line | a two-column reference: signature + arguments, then description |
| Breakpoints | 1 | 5 |

Landscape-**first**, not landscape-only: the rail collapses above the panel below 1100px and the hero collapses below 1360px.

### Changed — the docs stop making you guess

The site and the README could not answer four questions an adopter actually has. They can now:

- **What do I need before adopting** — host, Node, git, tracker CLI and what your project must already contain, per pattern.
- **What lands in my repo** — the installed file tree. Nobody should have to run `adopt` to find out what it writes.
- **What will I actually see** — a step-by-step first run, including that `/breakdown-prd` *stops* and waits for you.
- **What do I do when it breaks** — a symptom → cause → fix table built from defects real adopters hit. The symptoms are listed because they are rarely obvious: *"every ticket reports not-delivered but the code is on `main` and the issues are closed"* does not read like a squash-merge ancestry bug.

Also added: **what the agents will not do** — the boundaries enforced by config and deterministic scripts rather than by prose. And each pattern panel now carries **its own** install command, so the copyable command always matches the pattern you are reading; previously one command sat in the hero regardless.

Local delivery and two-runtime coexistence shipped in 0.13.0 but existed only in this changelog. Both are now explained on the site with their exact commands.

## 0.13.0 — 2026-08-12

### Upgrading from 0.12.0

```
git add -A && git commit -m "checkpoint before agent-templates update"
npx agent-templates@latest adopt three-agent-architect-builder-reviewer . --force
git diff
```

`--force` again: the changes are in `.claude/scripts/`, `.claude/workflows/` and `integrations/asana/`, which a plain re-run skips.

**If you use the Asana integration, upgrade.** A parent with more than 100 subtasks was silently truncated and the missing ones recreated — see below.

### New — finish the PRD without a tracker, publish afterwards

`/start-all` accepts `platform: 'none'`. Every ticket merges to the **local** default branch and nothing touches a forge: no push, no PR/MR, no tracker.

```
/start-all autonomous 1 none
```

The reason is not convenience. Every delivery defect this catalog has recorded lives at the forge boundary — a missing `--sha` (#152), the mergeability race (#135), squash ancestry (#152), leftover branches opening reverting merge requests (#151), a protected default branch (#139), a 403 MR API (#56), one generated file leaving the tree dirty (#153) — and **every one of them stopped the whole run**. The pattern's value is the Architect → Builder → fresh Reviewer chain; the forge is how the result is *published*. Coupling them means an outage, an expired token or a pipeline policy blocks development.

**Review is unchanged.** A ticket still only merges on CLEAR. What is deferred is publication, not judgement.

What replaces the tracker: a **committed** ledger at `docs/delivered.json` recording each delivered ticket and the commit it landed as. That is the resume signal — a re-run executes only the new work — and it is what you or an agent read afterwards to know what still needs pushing. It is committed rather than gitignored on purpose: a scratch file would vanish on the first clean checkout, which is exactly when someone needs it.

The run ends with an explicit handoff naming the exact command to publish. A mode that quietly accumulates work on one machine and says nothing is indistinguishable from work nobody can see.

### New — run both three-agent patterns in one project

A project may install the Claude and the Codex three-agent patterns **side by side**. Tested rather than asserted: zero file collisions — `.claude/` + `CLAUDE.md` beside `.codex/` + `.agents/` + `AGENTS.md`.

```
npx agent-templates@latest adopt three-agent-architect-builder-reviewer .
npx agent-templates@latest adopt codex-three-agent-architect-builder-reviewer .
```

They share exactly what is the *project* rather than the runtime — the `docs/prd/` ticket tree, the `[<id>]` tracker prefix, `ticket/<ID>` branch names, `docs/plans/`, and the delivery ledger. A ticket planned in one runtime and built in the other works, so teammates with different tools can work the same project and one person can switch runtimes on a token budget without development stalling.

**No hybrid pattern is offered.** It would add a third scaffold to maintain and a model table pinning two vendors at once, for no capability these two installs lack.

### Fixed — Asana silently truncated at 100 subtasks and recreated the rest

`listSubtasks` asked for `limit=100` and stopped, and the API helper discarded the response envelope including `next_page`. Asana caps a page at 100, so a parent with more than 100 subtasks returned a **truncated** list — and every caller treats "not in the list" as "does not exist yet" and creates it.

This is **catalog issue #132 verbatim**, through a different API: there, `glab issue list --all` returned 30 issues and one `--create` produced 43 duplicates on a 44-ticket repo. Self-reinforcing the same way — each duplicate consumes a window slot, pushing a real subtask further out of view next run.

The list is now paginated in full, and every condition under which completeness *cannot be known* throws rather than returning a short list: a full page with no `next_page`, a continuation token that yields no new rows, or exceeding the page cap. Asana remains fail-soft — it is a reporting mirror, never a gate, so these surface in `ASANA-SYNC-JSON.errors` and cannot fail a delivered ticket.

Worth stating plainly for anyone maintaining a fork: **no test caught this because the fake Asana API returned every child in one response, ignoring `limit`.** A test double more capable than the real API cannot exercise a truncation bug.

### Fixed — a flaky assertion in the merge gate was a real defect

`suite-deliver`'s squash-merge test failed intermittently with nothing but a git warning to go on. `git init --bare` sets `HEAD` to `refs/heads/master` and pushing `main` never moves it, so the test fixture's origin permanently advertised a branch that did not exist and every clone of it landed on an **unborn** branch.

Only affects the catalog's own test suite, but recorded because a flaky test in the merge gate trains everyone — human and agent — to re-run rather than investigate.

### Changed — the release track record in the README

It said "0/3, as of 2026-08-06". It is now 0/4 published by CI with 5/5 by hand, and the workflow itself is green — the already-published skip path works, verified on `v0.11.0` and `v0.12.0` — while still having **never actually published**.

## 0.12.0 — 2026-08-11

### Upgrading from 0.11.0 — read this first

**If you run the three-agent pattern on GitLab, upgrade.** Four field-reported defects meant that on a pipeline-gated, squash-on-merge GitLab project **no ticket could deliver unattended**, and a fifth could publish a ticket against the *wrong* issue. None of them were visible from the runner's own reporting.

```
git add -A && git commit -m "checkpoint before agent-templates update"
npx agent-templates@latest adopt three-agent-architect-builder-reviewer . --force
git diff
```

`--force` is required: every fix below is in `.claude/scripts/` or `.claude/workflows/`, which a plain re-run skips because the files already exist.

**Windows users on any tracker should also upgrade** — see the `dag.html` entry.

### Fixed — GitLab delivery could not complete

Reported from a real adopter's repo, and worth reading as one causal chain rather than four bugs:

- **`glab mr merge` was called without `--sha`**, which GitLab rejects with `400 SHA must be provided`. Modern `glab` defaults `--auto-merge` on, and auto-merge requires one. Both call sites now pass the head — which is also a correctness win: the merge lands only if the branch head still matches the reviewed commit, so a push arriving after the CLEAR verdict fails safe instead of merging unreviewed work.
- **The merge raced GitLab's mergeability computation**, returning `405`. Delivery now polls `detailed_merge_status` — waiting on `checking` / `unchecked` / `preparing` / `ci_still_running`, refusing immediately on `conflict` / `not_approved` / `ci_must_pass` and friends, bounded by a timeout because this runs unattended. A failed pipeline still escalates and **never** force-lands.
- **The failure note was a guess.** "required checks pending, conflict, or approval required" covered three unrelated causes at once, and three separate delivery agents chased protected-branch and approval theories off the back of it, all wrong. The note now names the observed `detailed_merge_status` verbatim.
- **Delivery was confirmed by git ancestry, which is permanently false under squash-on-merge.** Observed on five merge requests at once: all merged, all issues auto-closed by `Closes #N`, and the script reported `not-delivered` for every one. That is worse than a clean failure — the code is in `main`, the issue is closed, and the scheduler believes the ticket failed, so **a resume re-runs delivered work**. Detection now tries ancestry first (non-squash repos are unchanged), then falls back to the MR being merged **and** its squash/merge commit being *reachable* from the target. Status alone is deliberately not sufficient: a forge can report a merge that did not land.

### Fixed — merge requests that silently revert `main`

The most dangerous defect reported against this catalog so far, because it fails **inverted**. Every other failure here ends at "the ticket did not deliver", which a human sees. This one ends at a normal-looking, **conflict-free** merge request whose effect is a large deletion. Four sat open in a real repo — one of them **-12,095 lines** — found only because a human scrolled the merge request list.

The chain: `/start-all` left `ticket/<ID>` branches behind; under squash-on-merge the tip is never an ancestor of `main`; a later delivery pass therefore saw the branch as undelivered, re-pushed it, and opened a merge request against a `main` that had moved on.

Two independent defences:

- **Delivery refuses** to open a PR/MR whose diff against the target removes ≥200 lines *and* ≥5× what it adds. A refusal, not a warning — the whole failure mode is that nothing reported anything. The thresholds exist so an ordinary deleting ticket still delivers; a guard that trips constantly gets turned off.
- **`/start-all` cleans up after itself** — prunes the run's worktrees and deletes the branches of *delivered* tickets only. A failed ticket's branch is evidence and stays. What it could not clean escalates.

### Fixed — the mid-run rescan re-ran delivered tickets

`/start-all` filters out tickets whose issue is closed; that is the resume filter, and what makes a re-run after a pause or a new PRD phase execute only new work. **The mid-run rescan never applied it**, so a delivered ticket was pulled back into the running schedule — re-planned and re-built against a codebase that already contains its work. The reporter's workaround was `rescanEvery: 0`, i.e. turning the live-DAG feature off.

Both filter points now share one rule, and rescan drops are **reported** — silently removing work is indistinguishable from work that ran.

### Fixed — publishing on GitLab

- **A large ticket body could not publish.** It travelled through argv as `--description`, and Windows caps a command line at 32,767 characters, so a 40 KB ticket failed with `ENAMETOOLONG`. Issue writes now go through `glab api --field description=@<file>`, so the body is never an argument at any length. (Verified against glab 1.108.0: there is no `--description-file`, and `-d -` opens an editor.)
- **The issue number could bind to the *wrong* issue.** The old code scraped it from a URL and fell back to matching `#(\d+)` anywhere in the output; GitLab now returns `/-/work_items/N` on some versions, so the fallback could catch an unrelated number. The number is now read from the API's `iid` field, and the loose fallback is **removed, not narrowed** — failing to find a number is recoverable (`--sync` backfills it), binding the wrong one is not.

### Fixed — Windows: one generated file blocked every delivery

`docs/prd/dag.html` is committed by `adopt` and rewritten by `dag-report.mjs` on every run, including mid-run. With no eol rule a Windows checkout wants CRLF while the generator writes LF, so the file sits **permanently modified with an empty diff** — and delivery refuses to merge on a dirty tree. It presents as *one ticket failing at random*, depending on whether the DAG happened to be regenerated first.

Fixed at the cause (a `.gitattributes` rule under its own marker, so an existing install gains it on re-adopt) **and** at the symptom (a clean-tree exemption), because the `.gitattributes` block is marker-guarded and a repo adopted earlier would not otherwise pick it up.

### Changed — `adopt` no longer demands a tracker a pattern never uses

A pattern now declares whether it needs one, in `scaffold/pattern.json`. `hub-and-spoke-orchestrator-executors` has no tracker integration, yet adopting it into a repo with no git remote failed until you supplied a `--platform` value nothing would ever read — and then installed issue/MR templates the pattern never mentions.

Declaration rather than inference, and the default is `true`: a pattern that says nothing keeps the old, stricter behaviour, so this cannot weaken the gate for the pattern that needs it.

### New pattern: `codex-three-agent-architect-builder-reviewer` (status `proposed`)

Adds a Codex-native port of the independent Architect → Builder → fresh Reviewer topology. Project custom agents live in `.codex/agents/`, reusable entry points are repository skills under `.agents/skills/`, and target guidance is installed into `AGENTS.md`. The existing deterministic phase, DAG, tracker-publication, and delivery gates are carried over under `.codex/scripts/`.

The initial runner is deliberately sequential: it rejects `concurrency > 1` because parallel Codex Builders share the checkout and this pattern does not yet provide per-agent worktree isolation. The status remains `proposed` until maintainer sign-off and a Level-1 rehearsal.

Two defects were found in review before it shipped, both worth knowing if you copy from it: the Architect and Builder pinned `model = "gpt-5.6"`, which is a tier *family* rather than a model id (Codex exposes `gpt-5.6-sol` / `-terra` / `-luna`), so both would have failed at spawn; and the E2E suite had hardcoded that same value, i.e. a green gate over a configuration that could not run.

The Codex scaffold reuses the Claude pattern's deterministic scripts as hand-maintained copies under `.codex/scripts/`. A parity gate in the E2E suite compares them by **code** — whole-line comments stripped, runtime paths normalised — so runtime-specific rationale may differ but behaviour may not. Without it, fixing a delivery bug in one runtime would leave the other silently broken with every suite still green, because each suite reads only its own copy.

`adopt.mjs` now installs runtime-native scaffold roots and guidance (`.claude` + `CLAUDE.md`, or `.codex`/`.agents` + `AGENTS.md`) without leaking Claude-only integrations into a Codex-only target.

## 0.11.0 — 2026-08-10

### Upgrading from 0.10.0 — read this first

**If you use `three-agent-architect-builder-reviewer`, nothing about your pipeline changed.** No agent, command, script or effort pin was touched. A plain re-adopt picks up the new `next-steps.txt` and nothing else; you do not need `--force`.

The whole release is a **second pattern** plus the tooling and catalog-site work that having two patterns forced. Two of those fixes were latent bugs that only a second pattern could expose, and both affect anyone adopting anything:

- **`adopt` no longer re-appends the CLAUDE.md pipeline section on every re-run.** The idempotency marker was the hardcoded three-agent heading, so adopting any *other* pattern never found it and appended the whole block again each time. Now derived from the snippet's own first heading.
- **`adopt`'s NEXT STEPS are per-pattern.** They named three-agent commands regardless of what was installed — i.e. told you to run commands that did not exist.

### New pattern: `hub-and-spoke-orchestrator-executors` (status `proposed`)

A second point on the cost/assurance curve. One Claude Opus 5 **hub** decomposes a PRD into contract-first briefs, N headless `codex exec` **spokes** implement one brief each at low reasoning effort in isolated git worktrees, and the *same* hub session then audits, reviews and merges.

```
npx agent-templates@latest adopt hub-and-spoke-orchestrator-executors .
```

**Read this before adopting it.** The hub reviews diffs written against a contract the hub itself wrote, in the same context. That review is **not independent** — it is the thing this pattern trades away for cost and throughput, and it will not catch a wrong brief that was faithfully implemented. If a bad merge is expensive, keep using `three-agent-architect-builder-reviewer`, whose independent reviewer exists for exactly that case. The comparison table is in the README.

Requires the **Codex CLI** on `PATH`; there is no fallback without it.

What is mechanical rather than advisory:

- **All-or-nothing dispatch** — one invalid brief dispatches nothing (missing/empty contract section, repo-wide or denied `file_scope`, missing `test_cmd`, duplicate ids, dangling `blocked_by`, cycles, unordered briefs with overlapping scopes).
- **A global file firewall** — no spoke may write dependency, lock, build, CI, secret, or agent-config files, whatever its brief says. Deny is checked before scope, so a `**` scope cannot launder a lockfile edit.
- **`quarantined` outranks green tests** — a spoke that passed its tests while writing outside its scope does not merge.
- **`unverified` is not a pass** — a branch whose tests could not be re-run does not merge.
- **Executor completion is read from its result artifact, never from its exit code** — `codex exec`'s exit codes are undocumented (checked 2026-08-10), so trusting them would be an assumption.

Covered by a new E2E suite (`testbed/e2e/suite-hub.mjs`) driving the real scripts against a controllable stand-in executor.

### It has actually been run — and what that did and did not prove

`testbed/hub-rehearsal/` is a committed, re-runnable Level-1 target: a 4-module PRD, four briefs, a strict test suite written before any implementation, and no `src/`. `node testbed/hub-rehearsal/rehearse.mjs` drives it against the **real** Codex CLI in a temp clone. It spends real tokens and is never called by the free, deterministic Level-0 gate.

First full run — `codex-cli 0.147.0`, `--concurrency 2`: **4/4 briefs delivered across 2 waves, 0 repair rounds, 0 quarantines, 19/19 project tests green**, every spoke writing exactly one file inside its declared scope.

It found four real defects before you could:

1. **The output schema violated the provider's strict-mode rule**, so *every* dispatch failed with HTTP 400 before the model ran. `required` must list every key in `properties`; an optional field has to be nullable. A stand-in executor can never reach the provider's validator, so only a real run could find this.
2. **A failing executor was undiagnosable** — its stderr was discarded, so a one-line schema mistake surfaced as "no parseable result artifact" with no cause.
3. **A whole-suite `test_cmd` is wrong for multi-brief work.** The full suite cannot pass until the last brief lands, so every earlier brief burns its repair cap on failures that are not its fault. `/hub-brief` now requires `test_cmd` scoped to the brief's own module.
4. **The Windows `.cmd`-shim advice was wrong** for the official installer, which ships a real `codex.exe` that `spawn` resolves with no shell.

**What it did not prove, stated because the pattern's whole risk lives here:** the same session wrote the PRD, the tests and the briefs, so every contract agreed with itself by construction. That is exactly the circularity described above. This is evidence about the *machinery*, never about the *judgement* — which is why the status stays `proposed` and why promotion needs a real project.

### Catalog site — patterns are now tabs

Everything below the pattern cards used to be three-agent only, unlabelled. With two patterns that actively misled: you could read the hub-and-spoke card and scroll into `/breakdown-prd`, `/start-milestone`, a lane demo and a nightly sweep — none of which exist in the pattern whose card you just read, and worse, all of which imply a review guarantee it does not provide.

- One tab per pattern, one visible pane; the quickstart command follows the tab.
- Tab order is by **status**, so a `proposed` pattern is never the landing tab — placement reads as a recommendation.
- The hub pane now **shows** its artifact: what a brief contains, how big one is, and the real 2-wave schedule — rendered from the committed rehearsal briefs using the pattern's own parser and scheduler, so the page cannot show a brief shape the validator would reject or an order the driver would not produce.
- A mapping section for people switching: what each three-agent command maps to, and which have **no** equivalent (`/plan-ticket`, `/review-ticket`, `/publish-tickets`, `/nightly-issues`).

**Command names are deliberately not reused across patterns.** Someone who knows `/breakdown-prd` expects an independent reviewer downstream; reusing the name would import that expectation into a pipeline that has none.

### Fixed — affects existing installs

- **`adopt` derives the CLAUDE.md idempotency marker from the snippet** instead of hardcoding the three-agent heading. The hardcoded marker was correct only while the catalog had one pattern; adopting any other one would fail to find it and re-append the whole pipeline section on **every** re-run.
- **`adopt`'s NEXT STEPS are now per-pattern** (`scaffold/next-steps.txt`). Printing one pattern's steps after installing another names commands that do not exist. The no-PRD note is pattern-agnostic for the same reason.
- **The site's shared hero no longer states things that are true of only one pattern.** "Role boundaries enforced by hooks" is the three-agent mechanism; hub-and-spoke uses permission deny rules. "Nightly sweep" needs a tracker, which hub-and-spoke has none of. Both were correct with one pattern in the catalog and silently became false with two.

### Known rough edge

`adopt` still requires a tracker platform (`--platform gh|glab`, or an inferable git remote) even for `hub-and-spoke-orchestrator-executors`, which has no tracker integration and never reads the value. Pass `--platform gh` in a repo with no remote. Tracked as catalog issue #158.

## 0.10.0 — 2026-08-06

### Upgrading from 0.9.0 — read this first

```
git add -A && git commit -m "checkpoint before agent-templates update"
npx agent-templates@latest adopt three-agent-architect-builder-reviewer . --force
git diff
```

Two things a re-adopt does **not** do for you:

**1. Add test-runner ignores for `.claude/worktrees/`.** Required at `concurrency > 1`. `adopt` now git-ignores that path, but `.gitignore` is invisible to jest, vitest, pytest, eslint, tsc, bundlers and watchers — and at `concurrency > 1` the harness puts a full checkout of your repo under it *per isolated agent*. Without a runner-level ignore, a root test command can discover tests **inside** those checkouts, so the Builder runs other in-flight tickets' tests and `--test-cmd` measures the wrong tree for the Definition of Done. Add whichever applies:

```jsonc
// jest.config      testPathIgnorePatterns: ['/\\.claude/worktrees/']
// vitest.config    exclude: ['**/.claude/worktrees/**']
// pytest.ini       norecursedirs = .claude
// .eslintignore    .claude/worktrees/
// tsconfig.json    "exclude": [".claude/worktrees"]
```

**2. Preserve your agent effort pins.** `--force` overwrites `.claude/agents/*.md`, so it adopts the new pins: Architect `high`, Builder `medium`, Reviewer `high`, Triage `high` — each one level below 0.9.0. This is a deliberate cost decision (pattern § 3), and § 4 records honestly that it is **unmeasured**: the Builder now runs below its model's documented default on work the vendor scopes as non-routine, and the Reviewer has no effort margin left over the code it judges. Watch your bounce rate. To keep the old pins, re-adopt **without** `--force`, or restore the four agent files from your diff.

A plain re-run (no `--force`) still picks up the new integration files, the CLAUDE.md sections, the `.gitignore` rules, and the `settings.json` permission merge — those are additive and marker-guarded.

### Fixed

- **GitLab repos past 30 issues silently created duplicate issues.** The dedup oracle was one un-paginated `glab issue list`; `--all` is a *state* filter, not a pagination flag, and `--per-page` defaults to 30. Everything beyond the first page read as "never published" and was created again, and each duplicate pushed a real issue further out of the window. One field run: 44 tickets, 44 issues, **43 duplicates from a single `--create`**. Now paginated, sorted oldest-first, and every truncation path throws instead of returning a short list. Also added a pre-create guard that refuses to run against a tracker that already contains duplicates. (#132)
- **At `concurrency > 1`, every delivery was refused.** The harness places each isolated agent's worktree at `.claude/worktrees/wf_<runId>-<agentIndex>/` — inside your repo, untracked — so `deliver-ticket.mjs`'s clean-tree guard saw a dirty tree and would not merge. One field run: 7 tickets produced 16 worktrees and nothing could be delivered. Now git-ignored and exempted from the guard. See the upgrade note above for the half that is still yours to do. (#141)
- **`glab mr`/`gh pr` bodies always carry an AI banner now.** Previously the two body paths that adopted repos actually take — a pre-composed `--body-file` and your own MR template — carried no visible marker, so an MR written and merged by the pipeline looked like ordinary human work. The banner states that the change was AI-written and machine-merged, and that the account shown as author is the token's owner rather than the code's author. (#137)
- **Releases are retryable.** A failed publish can be re-run against the same tag from the Actions tab instead of deleting and re-pushing it. (#119)

### Added

- **Asana mirror** (`/connect-asana`). Optional, installed with every pattern, and completely inert until you configure it. Milestones and tickets become Asana subtasks, and a delivered ticket's subtask is completed automatically. It is a **reporting mirror, never a gate** — deliberately outside the Definition of Done, so an expired Asana token can never fail a ticket that actually shipped. Needs an `ASANA_TOKEN` environment variable; the token never goes to an agent. (#124, #126)
- **`/publish-tickets <module> [--all]`** — create the tracker issues (and Asana subtasks) and stop. For populating the board before any work starts. It authorizes issue creation but is *not* Gate 1 sign-off to build. (#126)
- **Integration-branch fallback for a protected default branch.** Opt-in via an `Integration branch:` line in CLAUDE.md. In autonomous mode, a merge your default branch refuses *because it is protected* lands on that branch (`ai-staging` by convention) instead of stalling every ticket. It fires **only** on a protection refusal — a failing pipeline or missing approval still escalates, and the classifier fails closed on anything it does not recognise. Work delivered there closes its issue but **does not pass the Definition of Done**, and one handoff MR is opened at the end of the run and never merged. (#139)
- **Real GitLab CLI and token setup guidance** — required scope (`api` alone), `glab auth login --stdin` rather than a token on the command line, self-managed hosts, and the 365-day expiry that silently breaks an unattended nightly sweep. The rule throughout: you install the token into the CLI yourself, and it never goes to an agent. (#137)

### Packaging

- `integrations/` was missing from the published files whitelist, so the Asana integration would have shipped absent while `adopt` exited 0 and told users to run `/connect-asana`. Caught pre-flight; never released. The real fix is a new packaging test that asserts every path `adopt` reads is present in the actual `npm pack` manifest, derived from disk so future additions are covered without anyone updating a list. (#143)

### Note on publishing

The tagged-release workflow has still never completed successfully — `v0.8.0` and `v0.9.0` both failed at the registry with `EOTP` because the CI token cannot publish without an interactive one-time password. Both versions shipped by hand. See README § "CI & releasing" before assuming a tag is enough.

## 0.9.0 and earlier

Not recorded here. See the git history and the pattern's README § 7 provenance log.
