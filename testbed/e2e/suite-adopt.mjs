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
  // A: bare-PRD new project. No signal to detect from, so platform is explicit
  // (issue #38: adopt refuses to guess — the no-signal paths are covered in E below).
  const t1 = mkdtempSync(join(tmpdir(), 'e2e-adopt-'))
  try {
    writeFileSync(join(t1, 'PRD.md'), '# My PRD\n\nGoal: demo.\n')
    const r1 = runAdopt([PATTERN, t1, '--platform', 'gh'])
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
    // issue #21: the Workflow tool rejects scripts containing \r — installs must be LF
    for (const f of ['.claude/workflows/run-milestone.js', '.claude/workflows/nightly-issues.js', '.claude/hooks/guard-main-session-writes.mjs', '.claude/scripts/publish-tickets.mjs', '.claude/scripts/deliver-ticket.mjs']) {
      check(S, `A1 LF-only install: ${f}`, !/\r/.test(readFileSync(join(t1, f), 'utf8')))
    }
    // issue #23: LF must SURVIVE later git checkouts on Windows — adopt pins runtime files
    const ga1 = readFileSync(join(t1, '.gitattributes'), 'utf8')
    check(S, 'A1 .gitattributes pins workflows + scripts to LF', ga1.includes('.claude/workflows/*.js text eol=lf') && ga1.includes('.claude/scripts/*.mjs text eol=lf'))
    check(S, 'A1 CLAUDE.md declares Operating mode', /Operating mode/.test(readFileSync(join(t1, 'CLAUDE.md'), 'utf8')))
    // issue #50: the ephemeral verdict scratch is git-ignored so it never blocks delivery or gets committed
    check(S, 'A1 gitignores .claude/tmp/', existsSync(join(t1, '.gitignore')) && /\.claude\/tmp\//.test(readFileSync(join(t1, '.gitignore'), 'utf8')))
    // issue #34: the resolved platform is recorded in CLAUDE.md
    check(S, 'A1 CLAUDE.md records Tracker: gh', /\*\*Tracker: `gh`\*\*/.test(readFileSync(join(t1, 'CLAUDE.md'), 'utf8')))
    // issue #40: upstream escalation is OFF by default — no catalog repo slug, no marker, no leak
    {
      const cm1 = readFileSync(join(t1, 'CLAUDE.md'), 'utf8')
      check(S, 'A1 no upstream escalation by default', !cm1.includes('Ruihang2017/agent-templates') && !cm1.includes('upstream-escalation') && !/Pattern-level problems go upstream/.test(cm1))
    }
    check(S, 'A1 docs/PRD.md copied from root PRD.md', readFileSync(join(t1, 'docs', 'PRD.md'), 'utf8').includes('# My PRD'))
    check(S, 'A1 root PRD.md kept (copy, not move)', existsSync(join(t1, 'PRD.md')))

    // idempotent re-run
    const r2 = runAdopt([PATTERN, t1])
    eq(S, 'A2 re-run exit 0', r2.status, 0)
    check(S, 'A2 re-run installs nothing', /adopt: 0 installed/.test(r2.stdout), r2.stdout.split('\n').pop())
    const cm = readFileSync(join(t1, 'CLAUDE.md'), 'utf8')
    eq(S, 'A2 snippet present exactly once', (cm.match(/Delivery pipeline — three-agent/g) || []).length, 1)
    eq(S, 'A2 .gitattributes rules present exactly once', (readFileSync(join(t1, '.gitattributes'), 'utf8').match(/Workflow tool rejects CRLF/g) || []).length, 1)
  } finally {
    rmSync(t1, { recursive: true, force: true })
  }

  // B: existing project with its own CLAUDE.md, explicit gitlab platform, no PRD
  const t2 = mkdtempSync(join(tmpdir(), 'e2e-adopt-'))
  try {
    writeFileSync(join(t2, 'CLAUDE.md'), '# Existing constitution\n\nMy rules.\n')
    writeFileSync(join(t2, '.gitattributes'), '*.png binary\n')
    const r = runAdopt([PATTERN, t2, '--platform', 'glab'])
    eq(S, 'B1 exit 0', r.status, 0)
    check(S, 'B1 gitlab templates installed', existsSync(join(t2, '.gitlab/issue_templates/task.md')) && existsSync(join(t2, '.gitlab/merge_request_templates/default.md')))
    check(S, 'B1 no .github created for glab', !existsSync(join(t2, '.github')))
    const cm = readFileSync(join(t2, 'CLAUDE.md'), 'utf8')
    check(S, 'B1 snippet appended after existing content', cm.startsWith('# Existing constitution') && cm.includes('Delivery pipeline — three-agent'))
    check(S, 'B1 CLAUDE.md records Tracker: glab (matches --platform)', /\*\*Tracker: `glab`\*\*/.test(cm) && !/\*\*Tracker: `gh`\*\*/.test(cm))
    const ga2 = readFileSync(join(t2, '.gitattributes'), 'utf8')
    check(S, 'B1 .gitattributes appended, existing rules kept', ga2.startsWith('*.png binary') && ga2.includes('.claude/workflows/*.js text eol=lf'))
    check(S, 'B1 missing-PRD note printed', /no PRD\.md found/.test(r.stdout))
  } finally {
    rmSync(t2, { recursive: true, force: true })
  }

  // C: self-hosted GitLab on a custom domain — detected via .gitlab-ci.yml, NOT a hostname
  // substring (issue #34). No --platform passed; no git remote either.
  const t3g = mkdtempSync(join(tmpdir(), 'e2e-adopt-'))
  try {
    writeFileSync(join(t3g, '.gitlab-ci.yml'), 'stages: [test]\n')
    const r = runAdopt([PATTERN, t3g])
    eq(S, 'C1 exit 0', r.status, 0)
    check(S, 'C1 detected glab from .gitlab-ci.yml', /platform: glab \(from \.gitlab-ci\.yml/.test(r.stdout))
    check(S, 'C1 installed .gitlab/, not .github/', existsSync(join(t3g, '.gitlab/issue_templates/task.md')) && !existsSync(join(t3g, '.github')))
    check(S, 'C1 CLAUDE.md records Tracker: glab', /\*\*Tracker: `glab`\*\*/.test(readFileSync(join(t3g, 'CLAUDE.md'), 'utf8')))
  } finally {
    rmSync(t3g, { recursive: true, force: true })
  }

  // D: the npx-facing CLI dispatcher (scripts/cli.mjs)
  const CLI = fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url))
  const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  {
    const l = runCli(['list'])
    eq(S, 'D1 cli list exits 0', l.status, 0)
    check(S, 'D1 cli list shows the pattern', l.stdout.includes(PATTERN))
    const bare = runCli([])
    eq(S, 'D2 bare cli prints usage, exit 0', bare.status, 0)
    check(S, 'D2 usage names the npx form', /npx github:/.test(bare.stdout))
    const unk = runCli(['frobnicate'])
    eq(S, 'D3 unknown command exits 1', unk.status, 1)
    const t3 = mkdtempSync(join(tmpdir(), 'e2e-adopt-'))
    try {
      const a = runCli(['adopt', PATTERN, t3, '--platform', 'gh'])
      eq(S, 'D4 cli adopt exits 0', a.status, 0)
      check(S, 'D4 cli adopt installs the scaffold', existsSync(join(t3, '.claude/agents/architect.md')) && existsSync(join(t3, 'CLAUDE.md')))
    } finally {
      rmSync(t3, { recursive: true, force: true })
    }
    const aBad = runCli(['adopt'])
    eq(S, 'D5 cli adopt without args propagates exit 1', aBad.status, 1)
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

  // E: issue #38 — no platform signal + non-interactive (spawnSync has no TTY): adopt
  // must NOT guess. It exits 1, names --platform, and installs nothing.
  const t5 = mkdtempSync(join(tmpdir(), 'e2e-adopt-'))
  try {
    writeFileSync(join(t5, 'PRD.md'), '# My PRD\n')
    const r = runAdopt([PATTERN, t5])
    eq(S, 'E1 no-signal non-TTY exits 1', r.status, 1)
    check(S, 'E1 error names --platform gh|glab', /--platform gh\|glab/.test(r.stderr))
    check(S, 'E1 installed nothing at all', ['.claude', '.github', '.gitlab', 'CLAUDE.md', 'docs', 'templates', '.gitattributes'].every((p) => !existsSync(join(t5, p))))
    // a repo-local signal still auto-resolves without --platform (no prompt, exit 0)
    writeFileSync(join(t5, '.gitlab-ci.yml'), 'stages: [test]\n')
    const r2 = runAdopt([PATTERN, t5])
    eq(S, 'E2 signal present -> resolves without --platform', r2.status, 0)
    check(S, 'E2 resolved glab from the signal', /platform: glab/.test(r2.stdout) && existsSync(join(t5, '.gitlab/issue_templates/task.md')))
  } finally {
    rmSync(t5, { recursive: true, force: true })
  }

  // F: issue #40 — upstream escalation is opt-in via --upstream [owner/repo]
  const t6 = mkdtempSync(join(tmpdir(), 'e2e-adopt-'))
  try {
    // bare --upstream targets the catalog this pattern came from
    const r = runAdopt([PATTERN, t6, '--platform', 'gh', '--upstream'])
    eq(S, 'F1 exit 0', r.status, 0)
    const cm = readFileSync(join(t6, 'CLAUDE.md'), 'utf8')
    check(S, 'F1 escalation bullet present, pointed at the catalog', /Pattern-level problems go upstream/.test(cm) && cm.includes('gh issue create --repo Ruihang2017/agent-templates'))
    check(S, 'F1 no marker comments leak into CLAUDE.md', !cm.includes('upstream-escalation'))
    check(S, 'F1 note reports escalation on', /upstream escalation: on/.test(r.stdout))
  } finally {
    rmSync(t6, { recursive: true, force: true })
  }
  const t7 = mkdtempSync(join(tmpdir(), 'e2e-adopt-'))
  try {
    // --upstream <repo> retargets it (own fork / internal catalog), no maintainer slug
    const r = runAdopt([PATTERN, t7, '--platform', 'gh', '--upstream', 'acme/agent-catalog'])
    eq(S, 'F2 exit 0', r.status, 0)
    const cm = readFileSync(join(t7, 'CLAUDE.md'), 'utf8')
    check(S, 'F2 retargeted to the given repo', cm.includes('gh issue create --repo acme/agent-catalog'))
    check(S, 'F2 catalog default slug absent', !cm.includes('Ruihang2017/agent-templates'))
    // custom repo arg must not be mistaken for a positional (pattern/target still parse)
    check(S, 'F2 scaffold still installed (arg parsed as flag value)', existsSync(join(t7, '.claude/agents/architect.md')))
  } finally {
    rmSync(t7, { recursive: true, force: true })
  }
}
