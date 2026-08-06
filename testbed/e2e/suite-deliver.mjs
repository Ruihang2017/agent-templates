// E2E for deliver-ticket.mjs: real temp git repos + a bare origin + the fake
// tracker CLIs. Asserts the delivery contract — no-ff merge, idempotent re-run,
// conflict abort leaving a clean tree, push, verified issue close, and the
// deterministic DoD combination (catalog issue #26).

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'deliver'
const SCRIPT = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/deliver-ticket.mjs', import.meta.url))
const FAKE_GH = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url))
const FAKE_GLAB = fileURLToPath(new URL('./fake-glab.mjs', import.meta.url))

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

// Windows: git object files can lag a beat before deletable; a leftover temp dir
// must never fail the suite.
const cleanup = (root) => {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
}

function makeRepo({ withOrigin = true, withPlan = true, pushOptionMr = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-deliver-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'e2e@example.com'])
  git(repo, ['config', 'user.name', 'E2E'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'README.md'), 'base\n')
  if (withPlan) {
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'plans', 'T-01.md'), 'plan\n')
  }
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])
  if (withOrigin) {
    const origin = join(root, 'origin.git')
    execFileSync('git', ['init', '-q', '--bare', origin], { encoding: 'utf8' })
    if (pushOptionMr) {
      // emulate GitLab: advertise push options + a pre-receive hook that prints the MR
      // URL (relayed to the client as "remote:" lines) when push options are present.
      execFileSync('git', ['-C', origin, 'config', 'receive.advertisePushOptions', 'true'], { encoding: 'utf8' })
      const hook = join(origin, 'hooks', 'pre-receive')
      writeFileSync(hook, '#!/bin/sh\ncat >/dev/null\nif [ "${GIT_PUSH_OPTION_COUNT:-0}" -gt 0 ]; then\n  echo "To create a merge request for this branch, visit:"\n  echo "  https://gitlab.example.com/acme/repo/-/merge_requests/42"\nfi\nexit 0\n')
      chmodSync(hook, 0o755)
    }
    git(repo, ['remote', 'add', 'origin', origin])
    git(repo, ['push', '-q', '-u', 'origin', 'main'])
  }
  git(repo, ['checkout', '-q', '-b', 'ticket/T-01'])
  writeFileSync(join(repo, 'feature.txt'), 'feature\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', '[T-01] feature'])
  git(repo, ['checkout', '-q', 'main'])
  return { root, repo }
}

function deliver(repo, args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GH_BIN: `node ${FAKE_GH}`, GLAB_BIN: `node ${FAKE_GLAB}`, ...env },
  })
  const line = (r.stdout || '').split('\n').reverse().find((l) => l.startsWith('DELIVER-SUMMARY-JSON: '))
  return { r, sum: line ? JSON.parse(line.slice('DELIVER-SUMMARY-JSON: '.length)) : null }
}

// D-series exercises the DIRECT (no-forge) fallback path explicitly; the PR path is
// the default via auto-detect and is covered by the P-series below.
const BASE_ARGS = ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--delivery', 'direct']

export async function run() {
  // D1: happy path (gh) — no-ff merge, push to origin, verified close, DoD green
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const { r, sum } = deliver(repo, BASE_ARGS, { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'D1 exit 0', r.status, 0)
      check(S, 'D1 summary printed', !!sum, r.stdout + r.stderr)
      check(S, 'D1 merged + issueClosed + dodPassed', sum && sum.merged && sum.issueClosed && sum.dodPassed, sum && sum.notes)
      check(S, 'D1 real --no-ff merge commit', /^merge: \[T-01\]/.test(git(repo, ['log', '-1', '--merges', '--format=%s'])))
      eq(S, 'D1 origin main updated', git(repo, ['rev-parse', 'HEAD']).trim(), execFileSync('git', ['-C', join(root, 'origin.git'), 'rev-parse', 'main'], { encoding: 'utf8' }).trim())

      // D2: idempotent re-run — already-merged recognized, flags stay true
      const again = deliver(repo, BASE_ARGS, { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'D2 re-run exit 0', again.r.status, 0)
      check(S, 'D2 alreadyMerged + all flags hold', again.sum && again.sum.checks.alreadyMerged && again.sum.merged && again.sum.issueClosed && again.sum.dodPassed)
    } finally {
      cleanup(root)
    }
  }

  // D3: no --issue — looked up by the "[<id>]" title prefix
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const { sum } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--delivery', 'direct'], {
        FAKE_GH_CLOSED_STATE: closed,
        FAKE_GH_LIST: JSON.stringify([{ number: 42, title: '[T-01] feature' }, { number: 43, title: '[T-02] other' }]),
      })
      check(S, 'D3 issue found by prefix and closed', sum && sum.issueClosed && sum.dodPassed, sum && sum.notes)
    } finally {
      cleanup(root)
    }
  }

  // D4: dirty working tree — refuses to merge, definitive summary, exit 0
  {
    const { root, repo } = makeRepo()
    try {
      writeFileSync(join(repo, 'uncommitted.txt'), 'wip\n')
      const { r, sum } = deliver(repo, BASE_ARGS)
      eq(S, 'D4 exit 0', r.status, 0)
      check(S, 'D4 refuses: merged false + note', sum && !sum.merged && !sum.dodPassed && /not clean/.test(sum.notes))
    } finally {
      cleanup(root)
    }
  }

  // D5: merge conflict — aborted, tree left clean, merged false
  {
    const { root, repo } = makeRepo()
    try {
      writeFileSync(join(repo, 'feature.txt'), 'conflicting main version\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'main edit that conflicts'])
      const closed = join(root, 'closed.txt')
      const { r, sum } = deliver(repo, BASE_ARGS, { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'D5 exit 0', r.status, 0)
      check(S, 'D5 merged false with merge-failed note', sum && !sum.merged && /merge failed/.test(sum.notes))
      eq(S, 'D5 tree clean after abort', git(repo, ['status', '--porcelain']).trim(), '')
      // a failed merge must NEVER close the issue — closed = "delivered" to resume filtering
      check(S, 'D5 tracker close skipped on failed merge', sum && !sum.issueClosed && !existsSync(closed) && /skipping tracker close/.test(sum.notes))
    } finally {
      cleanup(root)
    }
  }

  // D6: issue close fails — merged true, issueClosed false, DoD red
  {
    const { root, repo } = makeRepo()
    try {
      const { sum } = deliver(repo, BASE_ARGS, { FAKE_GH_FAIL_CLOSE: '1' })
      check(S, 'D6 merged but not closed -> dod red', sum && sum.merged && !sum.issueClosed && !sum.dodPassed)
    } finally {
      cleanup(root)
    }
  }

  // D7: plan file missing — DoD red even with merge + close green
  {
    const { root, repo } = makeRepo({ withPlan: false })
    try {
      const closed = join(root, 'closed.txt')
      const { sum } = deliver(repo, BASE_ARGS, { FAKE_GH_CLOSED_STATE: closed })
      check(S, 'D7 planExists false -> dod red', sum && sum.merged && sum.issueClosed && !sum.checks.planExists && !sum.dodPassed)
    } finally {
      cleanup(root)
    }
  }

  // D8: glab platform — text close/view path
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const { sum } = deliver(repo, [...BASE_ARGS, '--platform', 'glab'], { FAKE_GLAB_CLOSED_STATE: closed })
      check(S, 'D8 glab delivery green', sum && sum.merged && sum.issueClosed && sum.dodPassed, sum && sum.notes)
    } finally {
      cleanup(root)
    }
  }

  // D9: no origin remote — push not required, DoD can still pass
  {
    const { root, repo } = makeRepo({ withOrigin: false })
    try {
      const closed = join(root, 'closed.txt')
      const { sum } = deliver(repo, BASE_ARGS, { FAKE_GH_CLOSED_STATE: closed })
      check(S, 'D9 pushRequired false and dod green', sum && !sum.checks.pushRequired && sum.dodPassed, sum && sum.notes)
    } finally {
      cleanup(root)
    }
  }

  // D11: push rejected (origin moved ahead) — merged locally but NOT delivered: close skipped
  {
    const { root, repo } = makeRepo()
    try {
      const origin = join(root, 'origin.git')
      const clone2 = join(root, 'clone2')
      execFileSync('git', ['clone', '-q', '-b', 'main', origin, clone2], { encoding: 'utf8' })
      git(clone2, ['config', 'user.email', 'e2e@example.com'])
      git(clone2, ['config', 'user.name', 'E2E'])
      writeFileSync(join(clone2, 'other.txt'), 'from elsewhere\n')
      git(clone2, ['add', '-A'])
      git(clone2, ['commit', '-q', '-m', 'origin moved ahead'])
      git(clone2, ['push', '-q', 'origin', 'main'])
      const closed = join(root, 'closed.txt')
      const { r, sum } = deliver(repo, BASE_ARGS, { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'D11 exit 0', r.status, 0)
      check(S, 'D11 push failed -> not delivered, close skipped', sum && sum.merged && !sum.checks.pushed && !sum.issueClosed && !sum.dodPassed && !existsSync(closed), sum && sum.notes)
    } finally {
      cleanup(root)
    }
  }

  // D12: --branch equal to --default-branch is a bad invocation, not a vacuous success
  {
    const { root, repo } = makeRepo()
    try {
      const { r, sum } = deliver(repo, ['--id', 'T-01', '--branch', 'main', '--issue', '7'])
      eq(S, 'D12 exit 1', r.status, 1)
      check(S, 'D12 no summary emitted', !sum)
    } finally {
      cleanup(root)
    }
  }

  // D10: --test-cmd is part of DoD when supplied
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const bad = deliver(repo, [...BASE_ARGS, '--test-cmd', 'node -e "process.exit(1)"'], { FAKE_GH_CLOSED_STATE: closed })
      check(S, 'D10 failing test-cmd -> dod red', bad.sum && bad.sum.merged && bad.sum.checks.testsPassed === false && !bad.sum.dodPassed)
      const good = deliver(repo, [...BASE_ARGS, '--test-cmd', 'node -e "process.exit(0)"'], { FAKE_GH_CLOSED_STATE: closed })
      check(S, 'D10 passing test-cmd -> dod green', good.sum && good.sum.checks.testsPassed === true && good.sum.dodPassed, good.sum && good.sum.notes)
    } finally {
      cleanup(root)
    }
  }

  // ---- PR mode (issue #50): default via auto-detect (origin + authenticated forge) ----
  const originBranch = (root, br) => execFileSync('git', ['-C', join(root, 'origin.git'), 'branch', '--list', br], { encoding: 'utf8' })
  const prState = (repo) => JSON.parse(readFileSync(join(repo, '.git', 'fake-pr.json'), 'utf8'))

  // P1: gh PR path — branch pushed, PR opened, CLEAR verdict comment, forge-merge, close, DoD.
  // P2: idempotent re-run recognizes the landed merge and opens no second PR.
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const vf = join(root, 'verdict.md')
      writeFileSync(vf, 'CLEAR — SENTINEL_VERDICT: checked edge cases and concurrency.\n')
      const A = ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--verdict-file', vf]
      const { r, sum } = deliver(repo, A, { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'P1 exit 0', r.status, 0)
      check(S, 'P1 delivery mode = pr', sum && sum.deliveryMode === 'pr', sum && sum.notes)
      check(S, 'P1 branch pushed + PR created + verdict posted', sum && sum.checks.branchPushed && sum.checks.prCreated && sum.checks.verdictPosted, sum && sum.notes)
      check(S, 'P1 merged + issueClosed + dodPassed', sum && sum.merged && sum.issueClosed && sum.dodPassed, sum && sum.notes)
      check(S, 'P1 prUrl is a PR url', sum && /\/pull\/\d+$/.test(sum.prUrl), sum && sum.prUrl)
      check(S, 'P1 ticket branch exists on origin (AC2)', /ticket\/T-01/.test(originBranch(root, 'ticket/T-01')))
      eq(S, 'P1 local main == origin main (forge-merge synced)', git(repo, ['rev-parse', 'HEAD']).trim(), execFileSync('git', ['-C', join(root, 'origin.git'), 'rev-parse', 'main'], { encoding: 'utf8' }).trim())
      check(S, 'P1 CLEAR verdict is a PR comment (AC1)', prState(repo).prs.some((p) => p.comments.some((c) => c.includes('SENTINEL_VERDICT'))))

      const again = deliver(repo, A, { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'P2 re-run exit 0', again.r.status, 0)
      check(S, 'P2 alreadyMerged + still green', again.sum && again.sum.checks.alreadyMerged && again.sum.merged && again.sum.dodPassed, again.sum && again.sum.notes)
      eq(S, 'P2 no duplicate PR opened', prState(repo).prs.length, 1)
    } finally {
      cleanup(root)
    }
  }

  // P3: supervised --no-merge — PR opened + verdict comment, NOT merged, issue NOT closed
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const vf = join(root, 'verdict.md'); writeFileSync(vf, 'CLEAR review.\n')
      const { r, sum } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--verdict-file', vf, '--no-merge'], { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'P3 exit 0', r.status, 0)
      check(S, 'P3 awaitingMerge + PR created, not merged/closed/dod', sum && sum.awaitingMerge && sum.checks.prCreated && !sum.merged && !sum.issueClosed && !sum.dodPassed, sum && sum.notes)
      check(S, 'P3 issue left open for the human', !existsSync(closed))
      check(S, 'P3 branch pushed for review', /ticket\/T-01/.test(originBranch(root, 'ticket/T-01')))
    } finally {
      cleanup(root)
    }
  }

  // P4: forge merge blocked (a required check unmet) — not merged, not delivered, close skipped
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const vf = join(root, 'verdict.md'); writeFileSync(vf, 'CLEAR.\n')
      const { sum } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--verdict-file', vf], { FAKE_GH_CLOSED_STATE: closed, FAKE_GH_MERGE_BLOCKED: '1' })
      check(S, 'P4 blocked merge -> not merged/delivered, close skipped', sum && !sum.merged && !sum.dodPassed && !sum.issueClosed && !existsSync(closed), sum && sum.notes)
    } finally {
      cleanup(root)
    }
  }

  // P5: glab MR path happy
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const vf = join(root, 'verdict.md'); writeFileSync(vf, 'CLEAR — glab.\n')
      const { r, sum } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--platform', 'glab', '--verdict-file', vf], { FAKE_GLAB_CLOSED_STATE: closed })
      eq(S, 'P5 exit 0', r.status, 0)
      check(S, 'P5 glab pr mode green', sum && sum.deliveryMode === 'pr' && sum.merged && sum.issueClosed && sum.dodPassed, sum && sum.notes)
      check(S, 'P5 MR url', sum && /merge_requests\/\d+$/.test(sum.prUrl), sum && sum.prUrl)
    } finally {
      cleanup(root)
    }
  }

  // P6: --delivery pr with no origin refuses (no silent direct fallback under the explicit flag)
  {
    const { root, repo } = makeRepo({ withOrigin: false })
    try {
      const { sum } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--delivery', 'pr'])
      check(S, 'P6 explicit pr + no origin -> refuses, not delivered', sum && !sum.merged && !sum.dodPassed && /requires an origin/.test(sum.notes), sum && sum.notes)
    } finally {
      cleanup(root)
    }
  }

  // P7: supervised --no-merge with no forge -> leaves the local branch, nothing merged
  {
    const { root, repo } = makeRepo({ withOrigin: false })
    try {
      const { sum } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--no-merge'])
      check(S, 'P7 no-forge supervised leaves branch (awaitingMerge, direct)', sum && sum.deliveryMode === 'direct' && sum.awaitingMerge && !sum.merged && !sum.issueClosed, sum && sum.notes)
    } finally {
      cleanup(root)
    }
  }

  // P11: GitLab push-option MR — MR API 403 + protected default branch (issue #56).
  // auto-detects pushmr, opens the MR over SSH (scraping the URL from push output),
  // stops for a human web-merge, then RESUMES to deliver via the working Issues API.
  {
    const { root, repo } = makeRepo({ pushOptionMr: true })
    try {
      const closed = join(root, 'closed.txt')
      const vf = join(root, 'verdict.md'); writeFileSync(vf, 'CLEAR — SENTINEL_PUSHMR verdict, in the MR body.\n')
      const A = ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--platform', 'glab', '--verdict-file', vf]
      const env = { FAKE_GLAB_CLOSED_STATE: closed, FAKE_GLAB_MR_API_DENIED: '1' }

      const open = deliver(repo, A, env)
      eq(S, 'P11 open exit 0', open.r.status, 0)
      check(S, 'P11 auto-detected pushmr (MR API 403)', open.sum && open.sum.deliveryMode === 'pushmr', open.sum && open.sum.notes)
      check(S, 'P11 branch pushed + MR opened, awaiting web merge, not delivered', open.sum && open.sum.checks.branchPushed && open.sum.checks.prCreated && open.sum.awaitingMerge && !open.sum.merged && !open.sum.issueClosed, open.sum && open.sum.notes)
      check(S, 'P11 verdict posted as an issue comment (Issues API, MR API blocked)', open.sum && open.sum.checks.verdictPosted, open.sum && open.sum.notes)
      check(S, 'P11 MR url scraped from the push output', open.sum && /merge_requests\/42/.test(open.sum.prUrl), open.sum && open.sum.prUrl)
      check(S, 'P11 issue left open for the human', !existsSync(closed))
      check(S, 'P11 ticket branch on origin', /ticket\/T-01/.test(execFileSync('git', ['-C', join(root, 'origin.git'), 'branch', '--list', 'ticket/T-01'], { encoding: 'utf8' })))

      // human merges the MR on the web -> land the branch on origin/main
      git(repo, ['merge', '--no-ff', '--no-edit', '-m', 'web merge !42', 'ticket/T-01'])
      git(repo, ['push', 'origin', 'main'])
      const done = deliver(repo, A, env)
      eq(S, 'P11 resume exit 0', done.r.status, 0)
      check(S, 'P11 resume detects the web merge and delivers via the Issues API', done.sum && done.sum.checks.alreadyMerged && done.sum.merged && done.sum.issueClosed && done.sum.dodPassed, done.sum && done.sum.notes)
    } finally {
      cleanup(root)
    }
  }

  // P8: the verdict file run-milestone stages IN-REPO at .claude/tmp/<id>-verdict.md is
  // untracked scratch — it must NOT trip deliver's clean-tree guard (would block every
  // real delivery; the P1-P7 cases write the verdict outside the repo and miss this).
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      // realistic: an adopted repo has .claude/ committed, so only .claude/tmp/<id> is
      // untracked (git does not collapse it to a bare `.claude/`). This is what exercises
      // deliver-ticket's clean-tree exclusion.
      mkdirSync(join(repo, '.claude'), { recursive: true })
      writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n')
      git(repo, ['add', '.claude/settings.json'])
      git(repo, ['commit', '-q', '-m', 'chore: .claude'])
      mkdirSync(join(repo, '.claude', 'tmp'), { recursive: true })
      writeFileSync(join(repo, '.claude', 'tmp', 'T-01-verdict.md'), 'CLEAR — in-repo staged verdict.\n')
      const { r, sum } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--verdict-file', '.claude/tmp/T-01-verdict.md'], { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'P8 exit 0', r.status, 0)
      check(S, 'P8 in-repo .claude/tmp verdict does not read as dirty', sum && sum.deliveryMode === 'pr' && sum.merged && sum.dodPassed && sum.checks.verdictPosted, sum && sum.notes)
    } finally {
      cleanup(root)
    }
  }


// AI attribution must be present on EVERY body path (issue #137). Before the fix the
// --body-file path (the normal autonomous route) had no marker at all, and the repo-template
// path had only an HTML comment, which GitLab does not render — and those are exactly the
// two paths adopted repos take. Asserted per path, so a fix covering one cannot pass.
// Content-bearing, not a sentinel: an empty marker must not satisfy it.
const assertAiMarker = (label, body) => {
  check(S, `${label} body carries a rendered-visible AI banner (not an HTML comment)`,
    /^>.*Automated delivery/m.test(body) && !/^<!--[^>]*Auto-delivered/m.test(body), body.slice(0, 160))
  check(S, `${label} banner says the change was written and merged by AI`,
    /written and merged by AI/i.test(body))
  check(S, `${label} banner explains the author shown is the token owner`,
    /token'?s? owner|Personal Access Token/i.test(body))
}

  // P12: PR/MR body resolution (issue #58) — --body-file > repo template > hardcoded fallback
  // P12a: a pre-composed --body-file is used verbatim as the PR body
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt'); const log = join(root, 'ghbody.txt')
      const bf = join(root, 'mybody.md'); writeFileSync(bf, '## Custom\nSENTINEL_BODYFILE agent-composed.\nCloses #7\n')
      const { r } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--body-file', bf], { FAKE_GH_CLOSED_STATE: closed, FAKE_GH_BODY_LOG: log })
      eq(S, 'P12a exit 0', r.status, 0)
      const bodyA = existsSync(log) ? readFileSync(log, 'utf8') : ''
      check(S, 'P12a --body-file content preserved in the PR body', /SENTINEL_BODYFILE/.test(bodyA), bodyA.slice(0, 200))
      assertAiMarker('P12a', bodyA)
    } finally { cleanup(root) }
  }

  // P12b: the repo's own MR/PR template is the skeleton when no --body-file; Closes #N ensured
  {
    const { root, repo } = makeRepo()
    try {
      mkdirSync(join(repo, '.github'), { recursive: true })
      writeFileSync(join(repo, '.github', 'pull_request_template.md'), '## Summary\n\n## Constraint check\nSENTINEL_TEMPLATE non-negotiables.\n\n## Related\n')
      git(repo, ['add', '.github/pull_request_template.md'])
      git(repo, ['commit', '-q', '-m', 'chore: PR template'])
      const closed = join(root, 'closed.txt'); const log = join(root, 'ghbody.txt')
      const { r } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7'], { FAKE_GH_CLOSED_STATE: closed, FAKE_GH_BODY_LOG: log })
      eq(S, 'P12b exit 0', r.status, 0)
      const body = existsSync(log) ? readFileSync(log, 'utf8') : ''
      check(S, 'P12b PR body uses the repo template', /SENTINEL_TEMPLATE/.test(body), body.slice(0, 200))
      check(S, 'P12b Closes #7 ensured (under Related)', /Closes #7/.test(body))
      assertAiMarker('P12b', body)
    } finally { cleanup(root) }
  }

  // P12c: hardcoded fallback when there is neither a --body-file nor a repo template
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt'); const log = join(root, 'ghbody.txt')
      deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7'], { FAKE_GH_CLOSED_STATE: closed, FAKE_GH_BODY_LOG: log })
      const body = existsSync(log) ? readFileSync(log, 'utf8') : ''
      check(S, 'P12c hardcoded fallback body when no template/body-file', /## Summary/.test(body) && /Pipeline evidence/.test(body), body.slice(0, 200))
      assertAiMarker('P12c', body)
    } finally { cleanup(root) }
  }

  // P13: an untracked docs/plans/*.md (the Architect's ephemeral plan) must not trip the
  // clean-tree guard and block delivery (issue #58; the user had to move it by hand)
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      writeFileSync(join(repo, 'docs', 'plans', 'EXTRA.md'), 'untracked scratch plan\n')
      const { r, sum } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--delivery', 'direct'], { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'P13 exit 0', r.status, 0)
      check(S, 'P13 untracked docs/plans file does not block delivery', sum && sum.merged && sum.dodPassed, sum && sum.notes)
    } finally { cleanup(root) }
  }

  // P14: the SAME allowance, but with nothing tracked under docs/ at all.
  // P13 passes vacuously against this failure mode: makeRepo() commits
  // docs/plans/T-01.md, so docs/ always has tracked content and git never collapses it.
  // With docs/ entirely untracked, `git status --porcelain` (default -unormal) prints the
  // single line `?? docs/` instead of the individual files — which the path-anchored
  // allowlist cannot match, so delivery refused every ticket as "dirty". That is exactly
  // what killed the catalog's first Level-1 rehearsal (issue #75, 2026-07-27).
  {
    const { root, repo } = makeRepo({ withPlan: false })
    try {
      const closed = join(root, 'closed.txt')
      mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
      writeFileSync(join(repo, 'docs', 'plans', 'T-01.md'), 'plan\n')
      // guard the guard: prove the fixture really does reproduce the collapse
      const porcelain = git(repo, ['status', '--porcelain'])
      check(S, 'P14 fixture reproduces the collapsed `?? docs/` entry', /^\?\? docs\/$/m.test(porcelain), porcelain)
      const { r, sum } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--delivery', 'direct'], { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'P14 exit 0', r.status, 0)
      check(S, 'P14 a fully untracked docs/ does not block delivery', sum && sum.merged && sum.dodPassed, sum && sum.notes)
    } finally { cleanup(root) }
  }

  // P15: harness worktrees must not block delivery (issue #141, field report).
  // At concurrency > 1 the Workflow tool puts each isolated agent's worktree inside the
  // repo at `.claude/worktrees/wf_<runId>-<agentIndex>/`. Untracked, so `-uall` reports
  // them and the clean-tree guard refused to merge — every delivery blocked. Reported
  // from a run where 7 tickets produced 16 such directories.
  //
  // The second half is the point: the exemption must stay NARROW. Both assertions live in
  // one test so "fix" cannot mean "stop checking the tree".
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      // shaped like the real thing, including the second checkout of one branch that a
      // bounce produces, and a nested file so this is not just an empty directory
      mkdirSync(join(repo, '.claude', 'worktrees', 'wf_c9071538-f0e-8', 'src'), { recursive: true })
      writeFileSync(join(repo, '.claude', 'worktrees', 'wf_c9071538-f0e-8', 'src', 'app.js'), 'work in progress\n')
      mkdirSync(join(repo, '.claude', 'worktrees', 'wf_c9071538-f0e-30'), { recursive: true })
      writeFileSync(join(repo, '.claude', 'worktrees', 'wf_c9071538-f0e-30', '.git'), 'gitdir: ../../../.git/worktrees/x\n')
      const porcelain = git(repo, ['status', '--porcelain', '-uall'])
      check(S, 'P15 fixture is actually visible to git (the test would be vacuous otherwise)',
        /\.claude\/worktrees\//.test(porcelain), porcelain)

      const { r, sum } = deliver(repo, BASE_ARGS, { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'P15 exit 0', r.status, 0)
      check(S, 'P15 harness worktrees do not block delivery', sum && sum.merged && sum.dodPassed, sum && sum.notes)

      // ...and the guard still works for anything else.
      writeFileSync(join(repo, 'stray.txt'), 'not part of the pipeline\n')
      const blocked = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--delivery', 'direct'], { FAKE_GH_CLOSED_STATE: closed })
      check(S, 'P15 an unrelated untracked file STILL blocks the merge (exemption stays narrow)',
        blocked.sum && /not clean/.test(blocked.sum.notes), blocked.sum && blocked.sum.notes)
    } finally { cleanup(root) }
  }

  // ---------------------------------------------------------------------
  // I1-I6: integration-branch fallback (issue #139)
  //
  // I2 is the one that matters. This is only safe because it fires on BRANCH PROTECTION
  // and never on an unmet gate: rerouting a change whose pipeline failed would launder it
  // into a branch that later gets merged wholesale, and would be a backdoor around the
  // rule §4 sets from issue #50. I1 and I2 run the SAME fixture with only the refusal
  // reason differing, so a change that makes one pass by breaking the other is caught.
  // ---------------------------------------------------------------------

  const INT_ARGS = ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7', '--delivery', 'pr']
  // the suite's git() throws on non-zero; these checks ask "does this ref exist / is this
  // an ancestor", where a non-zero exit IS the answer
  const gitOk = (repo, args) => { try { git(repo, args); return true } catch { return false } }

  // I1: protected default branch -> reroute, deliver to the integration branch
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const { r, sum } = deliver(repo, [...INT_ARGS, '--integration-branch', 'ai-staging'],
        { FAKE_GH_CLOSED_STATE: closed, FAKE_GH_MERGE_BLOCKED: 'protection' })
      eq(S, 'I1 exit 0', r.status, 0)
      eq(S, 'I1 outcome is delivered-to-integration, NOT delivered', sum.outcome, 'delivered-to-integration')
      eq(S, 'I1 deliveredTo names the integration branch', sum.deliveredTo, 'ai-staging')
      check(S, 'I1 the work landed on ai-staging', sum.checks.mergedToIntegration === true)
      // The DoD measures the DEFAULT branch, so it must stay false — a run reporting
      // "delivered" while main is empty is the #109/#127 failure class.
      check(S, 'I1 merged (default branch) stays false', sum.checks.merged === false)
      // NB: dodPassed is false here for several independent reasons, so this assertion
      // alone would NOT catch someone folding mergedToIntegration into the expression —
      // verified by probing it. The rule is enforced mechanically in suite-integrity
      // ("dodPassed contains NO integration-branch term"), which has no such blind spot.
      check(S, 'I1 dodPassed is FALSE — an integration branch is not the DoD', sum.dodPassed === false)
      // ...but the issue closes, so a re-run does not rebuild work already on ai-staging.
      check(S, 'I1 the issue is still closed (no rework on re-run)', sum.issueClosed === true)
      check(S, 'I1 notes say plainly it is not on the default branch',
        /DELIVERED TO ai-staging, NOT main/.test(sum.notes), sum.notes.slice(0, 240))
      check(S, 'I1 ai-staging exists on origin', gitOk(repo, ['rev-parse', '--verify', 'origin/ai-staging']))
    } finally { cleanup(root) }
  }

  // I2: THE NEGATIVE — an unmet gate must never reroute, even with the flag set
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const { r, sum } = deliver(repo, [...INT_ARGS, '--integration-branch', 'ai-staging'],
        { FAKE_GH_CLOSED_STATE: closed, FAKE_GH_MERGE_BLOCKED: 'checks' })
      eq(S, 'I2 exit 0', r.status, 0)
      check(S, 'I2 a failed required check does NOT reroute', sum.checks.mergedToIntegration === false)
      eq(S, 'I2 outcome is not-delivered', sum.outcome, 'not-delivered')
      check(S, 'I2 dodPassed false', sum.dodPassed === false)
      check(S, 'I2 the issue is NOT closed', sum.issueClosed === false)
      check(S, 'I2 it states why it refused to reroute', /NOT rerouting/.test(sum.notes), sum.notes.slice(0, 240))
      // Strongest form: the branch is never even created, so nothing can leak onto it.
      check(S, 'I2 ai-staging was never created', !gitOk(repo, ['rev-parse', '--verify', 'origin/ai-staging']))
    } finally { cleanup(root) }
  }

  // I3: without the flag, behaviour is exactly today's — no silent default-on
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const { sum } = deliver(repo, INT_ARGS, { FAKE_GH_CLOSED_STATE: closed, FAKE_GH_MERGE_BLOCKED: 'protection' })
      check(S, 'I3 no integration branch configured -> no reroute', sum.checks.mergedToIntegration === false)
      eq(S, 'I3 integrationBranch reported as null', sum.integrationBranch, null)
      check(S, 'I3 ai-staging not created', !gitOk(repo, ['rev-parse', '--verify', 'origin/ai-staging']))
    } finally { cleanup(root) }
  }

  // I4: a second ticket reuses the branch — never re-created, never reset (a reset would
  // silently discard the previous ticket's delivery)
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      deliver(repo, [...INT_ARGS, '--integration-branch', 'ai-staging'],
        { FAKE_GH_CLOSED_STATE: closed, FAKE_GH_MERGE_BLOCKED: 'protection' })
      const first = git(repo, ['rev-parse', 'origin/ai-staging']).trim()
      git(repo, ['checkout', '-q', '-b', 'ticket/T-02', 'main'])
      writeFileSync(join(repo, 'second.txt'), 'second\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', '[T-02] second'])
      git(repo, ['checkout', '-q', 'main'])
      const { sum } = deliver(repo, ['--id', 'T-02', '--branch', 'ticket/T-02', '--issue', '8', '--delivery', 'pr', '--integration-branch', 'ai-staging'],
        { FAKE_GH_CLOSED_STATE: closed, FAKE_GH_MERGE_BLOCKED: 'protection' })
      check(S, 'I4 the second ticket also lands on ai-staging', sum.checks.mergedToIntegration === true)
      check(S, 'I4 the branch advanced rather than being reset',
        git(repo, ['rev-parse', 'origin/ai-staging']).trim() !== first)
      check(S, 'I4 the first ticket is still on ai-staging',
        gitOk(repo, ['merge-base', '--is-ancestor', 'ticket/T-01', 'origin/ai-staging']))
    } finally { cleanup(root) }
  }

  // I5: the run-end handoff OPENS the integration -> default MR and never merges it
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      deliver(repo, [...INT_ARGS, '--integration-branch', 'ai-staging'],
        { FAKE_GH_CLOSED_STATE: closed, FAKE_GH_MERGE_BLOCKED: 'protection' })
      const grab = (out) => {
        const l = String(out || '').split('\n').find((x) => x.startsWith('INTEGRATION-MR-JSON: '))
        try { return l ? JSON.parse(l.slice('INTEGRATION-MR-JSON: '.length)) : null } catch { return null }
      }
      const h = deliver(repo, ['--open-integration-mr', '--integration-branch', 'ai-staging'], { FAKE_GH_CLOSED_STATE: closed })
      eq(S, 'I5 handoff exits 0', h.r.status, 0)
      const j = grab(h.r.stdout)
      check(S, 'I5 a handoff MR was opened', j && j.opened === true, String(h.r.stdout).slice(-300))
      check(S, 'I5 it reports how far ahead of the default branch it is', j && j.ahead >= 1)
      check(S, 'I5 it lists the tickets it carries', j && Array.isArray(j.tickets) && j.tickets.includes('T-01'))
      // Never merged — that is the human gate this whole mode exists to preserve.
      check(S, 'I5 the handoff MR is NOT merged; main is untouched',
        !gitOk(repo, ['merge-base', '--is-ancestor', 'ticket/T-01', 'origin/main']))
      const again = grab(deliver(repo, ['--open-integration-mr', '--integration-branch', 'ai-staging'], { FAKE_GH_CLOSED_STATE: closed }).r.stdout)
      check(S, 'I5 a second run reuses the open MR instead of opening another', again && again.alreadyOpen === true)
    } finally { cleanup(root) }
  }

  // I6: nothing delivered to the branch -> nothing to hand off, and that is not an error
  {
    const { root, repo } = makeRepo()
    try {
      const h = deliver(repo, ['--open-integration-mr', '--integration-branch', 'ai-staging'], {})
      eq(S, 'I6 handoff on a missing integration branch exits 0', h.r.status, 0)
      check(S, 'I6 it reports opened:false rather than failing the run',
        /INTEGRATION-MR-JSON: .*"opened":false/.test(String(h.r.stdout)))
    } finally { cleanup(root) }
  }
}
