// E2E for publish-tickets.mjs: runs the ACTUAL scaffold script against fixture
// ticket modules and fake gh/glab CLIs (injected via the GH_BIN/GLAB_BIN overrides).
// Covers idempotency, ambiguity, create/failure paths, degraded-CLI, and the
// machine-readable summary contract.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'publish'
const SCRIPT = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/publish-tickets.mjs', import.meta.url))
const FAKE_GH = 'node ' + fileURLToPath(new URL('./fake-gh.mjs', import.meta.url))
const FAKE_GLAB = 'node ' + fileURLToPath(new URL('./fake-glab.mjs', import.meta.url))

function ticket(id, title) {
  return `---\nid: ${id}\ntitle: ${title}\nmodule: 00-x\nsize: S\nagent: builder\nstatus: ready\ndate: 2026-07-17\n---\n\n# ${id} — body\n\n## Goal\nDo the thing.\n`
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'e2e-pub-'))
  const tdir = join(root, 'docs', 'prd', '00-x', 'tickets')
  mkdirSync(tdir, { recursive: true })
  writeFileSync(join(tdir, 'DEM-01-a.md'), ticket('DEM-01', 'Demo ticket one'))
  writeFileSync(join(tdir, 'DEM-02-b.md'), '﻿' + ticket('DEM-02', '"Deploy: enable \\"safe\\" mode"')) // BOM + quoted YAML title
  writeFileSync(join(tdir, 'DEM-03-dup.md'), ticket('DEM-01', 'Duplicate id'))
  writeFileSync(join(tdir, 'broken.md'), '---\ntitle: no id\n---\nbody\n')
  writeFileSync(join(tdir, 'notes.md'), 'no frontmatter\n')
  return root
}

function runPub(root, args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('PUBLISH-SUMMARY-JSON: '))
  let summary = null
  try { summary = line ? JSON.parse(line.slice('PUBLISH-SUMMARY-JSON: '.length)) : null } catch {}
  return { ...r, summary }
}
const entry = (summary, id, path) => (summary || []).find((e) => (id ? e.id === id : true) && (!path || e.path.includes(path)))

export async function run() {
  const root = makeFixture()
  try {
    const mod = 'docs/prd/00-x'

    // P1: dry-run with one existing issue (exact prefix match)
    {
      const r = runPub(root, [mod], { GH_BIN: FAKE_GH, FAKE_GH_LIST: JSON.stringify([{ number: 7, title: '[DEM-01] Demo ticket one' }]) })
      eq(S, 'P1 exit 0', r.status, 0)
      eq(S, 'P1 DEM-01 skipped as existing #7', entry(r.summary, 'DEM-01', 'DEM-01-a') && entry(r.summary, 'DEM-01', 'DEM-01-a').issue, 7)
      const d2 = entry(r.summary, 'DEM-02')
      check(S, 'P1 DEM-02 planned with clean quoted title', d2 && d2.issue === null && d2.title === '[DEM-02] Deploy: enable "safe" mode')
      eq(S, 'P1 error classes recorded', (r.summary || []).filter((e) => e.error).map((e) => e.error).sort(), ['duplicate-id', 'missing-id-title', 'no-frontmatter'])
    }

    // P2: mention-but-not-prefix is ambiguous, never a silent skip or create
    {
      const r = runPub(root, [mod], { GH_BIN: FAKE_GH, FAKE_GH_LIST: JSON.stringify([{ number: 5, title: 'Discuss [DEM-01] rollout plan' }]) })
      eq(S, 'P2 exit 0 (dry-run)', r.status, 0)
      const d1 = entry(r.summary, 'DEM-01', 'DEM-01-a')
      check(S, 'P2 DEM-01 flagged ambiguous-existing', d1 && d1.error === 'ambiguous-existing' && d1.issue === null)
    }

    // P3: create path with issue-number capture
    {
      const state = join(root, 'gh-state.txt')
      const r = runPub(root, [mod, '--create'], { GH_BIN: FAKE_GH, FAKE_GH_LIST: '[]', FAKE_GH_STATE: state })
      eq(S, 'P3 exit 0', r.status, 0)
      eq(S, 'P3 DEM-01 created as #101', entry(r.summary, 'DEM-01', 'DEM-01-a').issue, 101)
      eq(S, 'P3 DEM-02 created as #102', entry(r.summary, 'DEM-02').issue, 102)
    }

    // P4: label failure triggers retry-without-labels, still created
    {
      const state = join(root, 'gh-state2.txt')
      const r = runPub(root, [mod, '--create'], { GH_BIN: FAKE_GH, FAKE_GH_LIST: '[]', FAKE_GH_STATE: state, FAKE_GH_FAIL_LABELS: '1' })
      eq(S, 'P4 exit 0 after label retry', r.status, 0)
      check(S, 'P4 retry warning on stderr', /retrying without labels/.test(r.stderr))
      check(S, 'P4 tickets still created', entry(r.summary, 'DEM-01', 'DEM-01-a').issue === 101 && entry(r.summary, 'DEM-02').issue === 102)
    }

    // P5: hard create failure — summary must survive, exit 1
    {
      const r = runPub(root, [mod, '--create'], { GH_BIN: FAKE_GH, FAKE_GH_LIST: '[]', FAKE_GH_FAIL_CREATE: '1' })
      eq(S, 'P5 exit 1 on create failure', r.status, 1)
      check(S, 'P5 summary still printed', Array.isArray(r.summary))
      check(S, 'P5 create-failed recorded', /create-failed/.test((entry(r.summary, 'DEM-01', 'DEM-01-a') || {}).error || ''))
    }

    // P6: CLI missing — dry-run degrades, --create refuses
    {
      const dry = runPub(root, [mod], { GH_BIN: 'definitely-not-a-real-binary-xyz' })
      eq(S, 'P6 dry-run exit 0 without CLI', dry.status, 0)
      check(S, 'P6 degraded note printed', /unavailable/.test(dry.stdout))
      const create = runPub(root, [mod, '--create'], { GH_BIN: 'definitely-not-a-real-binary-xyz' })
      eq(S, 'P6 --create exit 1 without CLI', create.status, 1)
    }

    // P7: glab text fallback matches the RIGHT line, not the first #N mention
    {
      const list = '#5 Discuss [DEM-01] rollout plan\n#9 [DEM-01] Demo ticket one\n'
      const r = runPub(root, [mod, '--platform', 'glab'], { GLAB_BIN: FAKE_GLAB, FAKE_GLAB_LIST: list })
      eq(S, 'P7 exit 0', r.status, 0)
      eq(S, 'P7 DEM-01 matched to #9 (exact prefix line)', entry(r.summary, 'DEM-01', 'DEM-01-a').issue, 9)
    }

    // P8: invocation edge cases
    {
      const noVal = runPub(root, [mod, '--platform'], {})
      eq(S, 'P8 --platform without value exits 1', noVal.status, 1)
      const bogus = runPub(root, [mod, '--platform', 'gitea'], {})
      eq(S, 'P8 bogus platform exits 1', bogus.status, 1)
      const noArgs = runPub(root, [], {})
      eq(S, 'P8 no args exits 1 with usage', noArgs.status, 1)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
