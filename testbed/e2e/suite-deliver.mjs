// E2E for deliver-ticket.mjs: real temp git repos + a bare origin + the fake
// tracker CLIs. Asserts the delivery contract — no-ff merge, idempotent re-run,
// conflict abort leaving a clean tree, push, verified issue close, and the
// deterministic DoD combination (catalog issue #26).

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function makeRepo({ withOrigin = true, withPlan = true } = {}) {
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
}
