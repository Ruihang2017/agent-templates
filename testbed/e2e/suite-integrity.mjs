// Scaffold integrity: every shipped file exists, agent frontmatter pins exactly the
// model/effort the pattern README documents, commands carry descriptions, and the
// wiring files parse. This is the mechanical gate that keeps docs and scaffold in
// lockstep — run it before merging any scaffold change.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check } from './lib.mjs'

const S = 'integrity'
const ROOT = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/', import.meta.url))
const SCAFFOLD = 'patterns/three-agent-architect-builder-reviewer/scaffold/'
const p = (rel) => ROOT + rel

const EXPECTED_FILES = [
  'INSTALL.md',
  'claude-md-snippet.md',
  '.claude/settings.json',
  '.claude/hooks/guard-main-session-writes.mjs',
  '.claude/scripts/publish-tickets.mjs',
  '.claude/workflows/run-milestone.js',
  '.claude/workflows/nightly-issues.js',
  '.claude/agents/architect.md',
  '.claude/agents/builder.md',
  '.claude/agents/reviewer.md',
  '.claude/agents/triage.md',
  '.claude/commands/plan-ticket.md',
  '.claude/commands/build-ticket.md',
  '.claude/commands/review-ticket.md',
  '.claude/commands/verify-delivery.md',
  '.claude/commands/start-milestone.md',
  '.claude/commands/nightly-issues.md',
  '.claude/commands/breakdown-prd.md',
]

// Universal templates live at the CATALOG root (shared by all patterns + the repo itself)
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const UNIVERSAL_TEMPLATES = [
  'templates/pattern-README.template.md',
  'templates/ticket.template.md',
  'templates/tracker/github/ISSUE_TEMPLATE/bug-report.md',
  'templates/tracker/github/ISSUE_TEMPLATE/task.md',
  'templates/tracker/github/ISSUE_TEMPLATE/decision-record.md',
  'templates/tracker/github/PULL_REQUEST_TEMPLATE.md',
  'templates/tracker/gitlab/issue_templates/bug-report.md',
  'templates/tracker/gitlab/issue_templates/task.md',
  'templates/tracker/gitlab/issue_templates/decision-record.md',
  'templates/tracker/gitlab/merge_request_templates/default.md',
]

// model/effort pins must match pattern README §3 exactly
const AGENT_PINS = {
  'architect.md': { model: 'claude-sonnet-5', effort: 'xhigh' },
  'builder.md': { model: 'claude-opus-4-8', effort: 'xhigh' },
  'reviewer.md': { model: 'claude-fable-5', effort: 'max' },
  'triage.md': { model: 'claude-sonnet-5', effort: 'xhigh' },
}

const fm = (text) => (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
const fmField = (text, name) => ((fm(text).match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'm')) || [])[1] || '').trim()

export async function run() {
  for (const rel of EXPECTED_FILES) {
    check(S, `exists: ${rel}`, existsSync(p(rel)))
  }
  for (const rel of UNIVERSAL_TEMPLATES) {
    check(S, `exists: ${rel}`, existsSync(REPO_ROOT + rel))
  }

  for (const [file, pins] of Object.entries(AGENT_PINS)) {
    const path = p('.claude/agents/' + file)
    if (!existsSync(path)) { check(S, `${file} readable`, false); continue }
    const text = readFileSync(path, 'utf8')
    check(S, `${file} pins model ${pins.model}`, fmField(text, 'model') === pins.model)
    check(S, `${file} pins effort ${pins.effort}`, fmField(text, 'effort') === pins.effort)
  }

  for (const cmd of ['plan-ticket', 'build-ticket', 'review-ticket', 'verify-delivery', 'start-milestone', 'nightly-issues', 'breakdown-prd']) {
    const path = p(`.claude/commands/${cmd}.md`)
    if (!existsSync(path)) continue
    check(S, `command ${cmd} has description`, fmField(readFileSync(path, 'utf8'), 'description').length > 0)
  }

  // wiring parses and points at real things
  if (existsSync(p('.claude/settings.json'))) {
    let settings = null
    try { settings = JSON.parse(readFileSync(p('.claude/settings.json'), 'utf8')) } catch {}
    check(S, 'settings.json parses', settings !== null)
    const pre = settings && settings.hooks && settings.hooks.PreToolUse && settings.hooks.PreToolUse[0]
    check(S, 'settings wires the write-guard matcher', pre && /Edit\|Write/.test(pre.matcher) && /guard-main-session-writes/.test(JSON.stringify(pre.hooks)))
  }
  for (const [wf, name] of [['run-milestone.js', 'run-milestone'], ['nightly-issues.js', 'nightly-issues']]) {
    const path = p('.claude/workflows/' + wf)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    check(S, `${wf} declares meta name '${name}'`, new RegExp(`name:\\s*'${name}'`).test(text))
    check(S, `${wf} has no forbidden runtime APIs`, !/Date\.now\(|Math\.random\(|new Date\(\)|require\(|from 'node:/.test(text))
  }

  check(S, 'snippet declares Operating mode', /Operating mode/.test(readFileSync(p('claude-md-snippet.md'), 'utf8')))
  const ticketTpl = readFileSync(REPO_ROOT + 'templates/ticket.template.md', 'utf8')
  for (const f of ['id', 'title', 'module', 'lane', 'size', 'agent', 'status', 'date', 'blocked_by', 'blocks']) {
    check(S, `ticket template carries frontmatter field '${f}'`, new RegExp(`^${f}\\s*:`, 'm').test(ticketTpl))
  }

  // The catalog self-hosts the nightly sweep and the universal tracker templates: its
  // root-level copies must stay byte-identical to their sources (change the source
  // first — scaffold for .claude, templates/tracker for .github — then re-copy).
  const SELF_HOSTED = {
    '.claude/agents/architect.md': SCAFFOLD + '.claude/agents/architect.md',
    '.claude/agents/builder.md': SCAFFOLD + '.claude/agents/builder.md',
    '.claude/agents/reviewer.md': SCAFFOLD + '.claude/agents/reviewer.md',
    '.claude/agents/triage.md': SCAFFOLD + '.claude/agents/triage.md',
    '.claude/workflows/run-milestone.js': SCAFFOLD + '.claude/workflows/run-milestone.js',
    '.claude/workflows/nightly-issues.js': SCAFFOLD + '.claude/workflows/nightly-issues.js',
    '.claude/commands/nightly-issues.md': SCAFFOLD + '.claude/commands/nightly-issues.md',
    '.claude/commands/verify-delivery.md': SCAFFOLD + '.claude/commands/verify-delivery.md',
    '.github/ISSUE_TEMPLATE/bug-report.md': 'templates/tracker/github/ISSUE_TEMPLATE/bug-report.md',
    '.github/ISSUE_TEMPLATE/task.md': 'templates/tracker/github/ISSUE_TEMPLATE/task.md',
    '.github/ISSUE_TEMPLATE/decision-record.md': 'templates/tracker/github/ISSUE_TEMPLATE/decision-record.md',
    '.github/PULL_REQUEST_TEMPLATE.md': 'templates/tracker/github/PULL_REQUEST_TEMPLATE.md',
  }
  // line-ending-agnostic: core.autocrlf rewrites checked-out files to CRLF on Windows,
  // which is git-managed noise, not semantic drift
  const norm = (s) => s.replace(/\r\n/g, '\n')
  for (const [repoRel, srcRel] of Object.entries(SELF_HOSTED)) {
    const repoPath = REPO_ROOT + repoRel
    const ok = existsSync(repoPath) && norm(readFileSync(repoPath, 'utf8')) === norm(readFileSync(REPO_ROOT + srcRel, 'utf8'))
    check(S, `self-hosted copy in sync: ${repoRel}`, ok)
  }
}
