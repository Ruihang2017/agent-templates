// Scaffold integrity: every shipped file exists, agent frontmatter pins exactly the
// model/effort the pattern README documents, commands carry descriptions, and the
// wiring files parse. This is the mechanical gate that keeps docs and scaffold in
// lockstep — run it before merging any scaffold change.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check } from './lib.mjs'

const S = 'integrity'
const ROOT = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/', import.meta.url))
const p = (rel) => ROOT + rel

const EXPECTED_FILES = [
  'INSTALL.md',
  'claude-md-snippet.md',
  'templates/ticket.template.md',
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
  'tracker-templates/github/ISSUE_TEMPLATE/bug-report.md',
  'tracker-templates/github/ISSUE_TEMPLATE/task.md',
  'tracker-templates/gitlab/issue_templates/bug-report.md',
  'tracker-templates/gitlab/issue_templates/task.md',
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

  for (const [file, pins] of Object.entries(AGENT_PINS)) {
    const path = p('.claude/agents/' + file)
    if (!existsSync(path)) { check(S, `${file} readable`, false); continue }
    const text = readFileSync(path, 'utf8')
    check(S, `${file} pins model ${pins.model}`, fmField(text, 'model') === pins.model)
    check(S, `${file} pins effort ${pins.effort}`, fmField(text, 'effort') === pins.effort)
  }

  for (const cmd of ['plan-ticket', 'build-ticket', 'review-ticket', 'verify-delivery', 'start-milestone', 'nightly-issues']) {
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
  const ticketTpl = readFileSync(p('templates/ticket.template.md'), 'utf8')
  for (const f of ['id', 'title', 'module', 'size', 'agent', 'status', 'date']) {
    check(S, `ticket template carries frontmatter field '${f}'`, new RegExp(`^${f}\\s*:`, 'm').test(ticketTpl))
  }
}
