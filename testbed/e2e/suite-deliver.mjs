// E2E for deliver-ticket.mjs: real temp git repos + a bare origin + the fake
// tracker CLIs. Asserts the delivery contract — no-ff merge, idempotent re-run,
// conflict abort leaving a clean tree, push, verified issue close, and the
// deterministic DoD combination (catalog issue #26).

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'deliver'
const SCRIPT = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/deliver-ticket.mjs', import.meta.url))
const FAKE_GH = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url))
const FAKE_GLAB = fileURLToPath(new URL('./fake-glab.mjs', import.meta.url))

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

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

const BASE_ARGS = ['--id', 'T-01', '--branch', 'ticket/T-01', '--issue', '7']

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
      rmSync(root, { recursive: true, force: true })
    }
  }

  // D3: no --issue — looked up by the "[<id>]" title prefix
  {
    const { root, repo } = makeRepo()
    try {
      const closed = join(root, 'closed.txt')
      const { sum } = deliver(repo, ['--id', 'T-01', '--branch', 'ticket/T-01'], {
        FAKE_GH_CLOSED_STATE: closed,
        FAKE_GH_LIST: JSON.stringify([{ number: 42, title: '[T-01] feature' }, { number: 43, title: '[T-02] other' }]),
      })
      check(S, 'D3 issue found by prefix and closed', sum && sum.issueClosed && sum.dodPassed, sum && sum.notes)
    } finally {
      rmSync(root, { recursive: true, force: true })
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
      rmSync(root, { recursive: true, force: true })
    }
  }

  // D5: merge conflict — aborted, tree left clean, merged false
  {
    const { root, repo } = makeRepo()
    try {
      writeFileSync(join(repo, 'feature.txt'), 'conflicting main version\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'main edit that conflicts'])
      const { r, sum } = deliver(repo, BASE_ARGS)
      eq(S, 'D5 exit 0', r.status, 0)
      check(S, 'D5 merged false with merge-failed note', sum && !sum.merged && /merge failed/.test(sum.notes))
      eq(S, 'D5 tree clean after abort', git(repo, ['status', '--porcelain']).trim(), '')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // D6: issue close fails — merged true, issueClosed false, DoD red
  {
    const { root, repo } = makeRepo()
    try {
      const { sum } = deliver(repo, BASE_ARGS, { FAKE_GH_FAIL_CLOSE: '1' })
      check(S, 'D6 merged but not closed -> dod red', sum && sum.merged && !sum.issueClosed && !sum.dodPassed)
    } finally {
      rmSync(root, { recursive: true, force: true })
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
      rmSync(root, { recursive: true, force: true })
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
      rmSync(root, { recursive: true, force: true })
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
      rmSync(root, { recursive: true, force: true })
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
      rmSync(root, { recursive: true, force: true })
    }
  }
}
