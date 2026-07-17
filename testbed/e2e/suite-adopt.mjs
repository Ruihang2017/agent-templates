// E2E for scripts/adopt.mjs: runs the ACTUAL installer against temp target dirs and
// asserts the full adoption contract — bare-PRD layout, idempotent re-runs, platform
// variants, CLAUDE.md create/append-once, and the error paths.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'adopt'
const SCRIPT = fileURLToPath(new URL('../../scripts/adopt.mjs', import.meta.url))
const PATTERN = 'three-agent-architect-builder-reviewer'
const runAdopt = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

export async function run() {
  // A: bare-PRD new project, default platform (no git remote -> gh)
  const t1 = mkdtempSync(join(tmpdir(), 'e2e-adopt-'))
  try {
    writeFileSync(join(t1, 'PRD.md'), '# My PRD\n\nGoal: demo.\n')
    const r1 = runAdopt([PATTERN, t1])
    eq(S, 'A1 exit 0', r1.status, 0)
    for (const f of [
      '.claude/agents/architect.md',
      '.claude/agents/reviewer.md',
      '.claude/workflows/run-milestone.js',
      '.claude/commands/breakdown-prd.md',
      '.claude/commands/start-milestone.md',
      '.claude/hooks/guard-main-session-writes.mjs',
      '.claude/settings.json',
      'templates/ticket.template.md',
      '.github/ISSUE_TEMPLATE/task.md',
      '.github/ISSUE_TEMPLATE/decision-record.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'docs/PRD.md',
      'docs/prd/.gitkeep',
      'docs/adr/.gitkeep',
      'docs/plans/.gitkeep',
      'CLAUDE.md',
    ]) {
      check(S, `A1 installs ${f}`, existsSync(join(t1, f)))
    }
    check(S, 'A1 CLAUDE.md declares Operating mode', /Operating mode/.test(readFileSync(join(t1, 'CLAUDE.md'), 'utf8')))
    check(S, 'A1 docs/PRD.md copied from root PRD.md', readFileSync(join(t1, 'docs', 'PRD.md'), 'utf8').includes('# My PRD'))
    check(S, 'A1 root PRD.md kept (copy, not move)', existsSync(join(t1, 'PRD.md')))

    // idempotent re-run
    const r2 = runAdopt([PATTERN, t1])
    eq(S, 'A2 re-run exit 0', r2.status, 0)
    check(S, 'A2 re-run installs nothing', /adopt: 0 installed/.test(r2.stdout), r2.stdout.split('\n').pop())
    const cm = readFileSync(join(t1, 'CLAUDE.md'), 'utf8')
    eq(S, 'A2 snippet present exactly once', (cm.match(/Delivery pipeline — three-agent/g) || []).length, 1)
  } finally {
    rmSync(t1, { recursive: true, force: true })
  }

  // B: existing project with its own CLAUDE.md, explicit gitlab platform, no PRD
  const t2 = mkdtempSync(join(tmpdir(), 'e2e-adopt-'))
  try {
    writeFileSync(join(t2, 'CLAUDE.md'), '# Existing constitution\n\nMy rules.\n')
    const r = runAdopt([PATTERN, t2, '--platform', 'glab'])
    eq(S, 'B1 exit 0', r.status, 0)
    check(S, 'B1 gitlab templates installed', existsSync(join(t2, '.gitlab/issue_templates/task.md')) && existsSync(join(t2, '.gitlab/merge_request_templates/default.md')))
    check(S, 'B1 no .github created for glab', !existsSync(join(t2, '.github')))
    const cm = readFileSync(join(t2, 'CLAUDE.md'), 'utf8')
    check(S, 'B1 snippet appended after existing content', cm.startsWith('# Existing constitution') && cm.includes('Delivery pipeline — three-agent'))
    check(S, 'B1 missing-PRD note printed', /no PRD\.md found/.test(r.stdout))
  } finally {
    rmSync(t2, { recursive: true, force: true })
  }

  // C: error paths
  const bad1 = runAdopt(['no-such-pattern', tmpdir()])
  eq(S, 'C1 unknown pattern exits 1', bad1.status, 1)
  check(S, 'C1 lists available patterns', /available:/.test(bad1.stderr) && bad1.stderr.includes(PATTERN))
  const bad2 = runAdopt([PATTERN, join(tmpdir(), 'definitely-missing-dir-xyz')])
  eq(S, 'C2 missing target exits 1', bad2.status, 1)
  const bad3 = runAdopt([])
  eq(S, 'C3 no args exits 1 with usage', bad3.status, 1)
  const bad4 = runAdopt([PATTERN, tmpdir(), '--platform'])
  eq(S, 'C4 dangling --platform exits 1', bad4.status, 1)
}
