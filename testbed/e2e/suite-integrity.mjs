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
  '.claude/scripts/milestone-dag.mjs',
  '.claude/scripts/deliver-ticket.mjs',
  '.claude/workflows/run-milestone.js',
  '.claude/workflows/nightly-issues.js',
  '.claude/workflows/start-all.js',
  '.claude/agents/architect.md',
  '.claude/agents/builder.md',
  '.claude/agents/reviewer.md',
  '.claude/agents/triage.md',
  '.claude/commands/plan-ticket.md',
  '.claude/commands/build-ticket.md',
  '.claude/commands/review-ticket.md',
  '.claude/commands/verify-delivery.md',
  '.claude/commands/start-milestone.md',
  '.claude/commands/start-all.md',
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
  'architect.md': { model: 'claude-fable-5', effort: 'max' },
  'builder.md': { model: 'claude-opus-4-8', effort: 'xhigh' },
  'reviewer.md': { model: 'claude-fable-5', effort: 'xhigh' },
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

  // publish guards: the catalog is a published npm package (MIT, issue #15)
  check(S, 'LICENSE exists', existsSync(REPO_ROOT + 'LICENSE'))
  let manifest = null
  try { manifest = JSON.parse(readFileSync(REPO_ROOT + 'package.json', 'utf8')) } catch {}
  check(S, 'package.json declares MIT and is publishable', manifest && manifest.license === 'MIT' && manifest.private !== true)

  for (const [file, pins] of Object.entries(AGENT_PINS)) {
    const path = p('.claude/agents/' + file)
    if (!existsSync(path)) { check(S, `${file} readable`, false); continue }
    const text = readFileSync(path, 'utf8')
    check(S, `${file} pins model ${pins.model}`, fmField(text, 'model') === pins.model)
    check(S, `${file} pins effort ${pins.effort}`, fmField(text, 'effort') === pins.effort)
  }

  // Prose can drift from the frontmatter: the README's scaffold-tree diagram carries
  // hand-written `<agent>.md  # claude-<model> @ <effort>;` pins that a model/effort change
  // must keep in step (they silently went stale in PR #43's first pass). Key each diagram
  // line to ITS OWN agent file — matching against the whole valid-combo set would miss a
  // stale pin that happens to collide with another role's combo (e.g. architect wrongly
  // showing Triage's sonnet-5 @ xhigh).
  {
    const readme = readFileSync(REPO_ROOT + SCAFFOLD.replace('scaffold/', 'README.md'), 'utf8')
    const pinLines = [...readme.matchAll(/(\w+\.md)\s+#\s*(claude-[\w.-]+)\s*@\s*(\w+)\s*;/g)]
      .filter((m) => AGENT_PINS[m[1]])
    check(S, 'README scaffold-tree agent pins present to check', pinLines.length >= 3)
    for (const [, file, model, effort] of pinLines) {
      const pin = AGENT_PINS[file]
      check(S, `README diagram pin for ${file} matches its frontmatter`, model === pin.model && effort === pin.effort)
    }
  }

  for (const cmd of ['plan-ticket', 'build-ticket', 'review-ticket', 'verify-delivery', 'start-milestone', 'start-all', 'nightly-issues', 'breakdown-prd']) {
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

    // issue #30: the pipeline's tool surface is explicitly pre-allowed, and the
    // role-discipline-forbidden surface is NOT — drift in either direction fails here.
    const allow = (settings && settings.permissions && settings.permissions.allow) || []
    const MUST_ALLOW = [
      'Bash(node .claude/scripts/milestone-dag.mjs:*)',
      'Bash(node .claude/scripts/publish-tickets.mjs:*)',
      'Bash(node .claude/scripts/deliver-ticket.mjs:*)',
      'Bash(git checkout:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)',
      'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git fetch:*)',
      'Bash(npm test:*)', 'Bash(node --test:*)',
      'Bash(gh issue list:*)', 'Bash(gh issue view:*)', 'Bash(gh issue comment:*)',
      'Bash(gh issue edit:*)', 'Bash(gh issue close:*)', 'Bash(gh issue create:*)',
      'Bash(glab issue list:*)', 'Bash(glab issue note:*)', 'Bash(glab issue close:*)',
    ]
    for (const rule of MUST_ALLOW) {
      check(S, `settings pre-allows ${rule}`, allow.includes(rule))
    }
    // note: [ :] (not \b) so the allowed `git merge-base` does not trip the `git merge` ban
    const FORBIDDEN = [/^Bash\(git merge[ :]/, /^Bash\(git rebase[ :]/, /^Bash\(git reset[ :]/, /^Bash\(git clean[ :]/, /^Bash\(gh pr[ :]/, /^Bash\(git:\*\)$/, /^Bash\(gh:\*\)$/, /^Bash\(glab:\*\)$/]
    for (const re of FORBIDDEN) {
      check(S, `settings does NOT pre-allow ${re.source}`, !allow.some((r) => re.test(r)))
    }
  }
  for (const [wf, name] of [['run-milestone.js', 'run-milestone'], ['nightly-issues.js', 'nightly-issues'], ['start-all.js', 'start-all']]) {
    const path = p('.claude/workflows/' + wf)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    check(S, `${wf} declares meta name '${name}'`, new RegExp(`name:\\s*'${name}'`).test(text))
    check(S, `${wf} has no forbidden runtime APIs`, !/Date\.now\(|Math\.random\(|new Date\(\)|require\(|from 'node:/.test(text))
  }

  // issue #21: workflow/hook/script runtime files must be LF in the working tree —
  // the Workflow tool rejects \r, and git autocrlf can silently reintroduce it.
  const LF_CRITICAL = [
    p('.claude/workflows/run-milestone.js'),
    p('.claude/workflows/nightly-issues.js'),
    p('.claude/workflows/start-all.js'),
    p('.claude/hooks/guard-main-session-writes.mjs'),
    p('.claude/scripts/publish-tickets.mjs'),
    p('.claude/scripts/milestone-dag.mjs'),
    p('.claude/scripts/deliver-ticket.mjs'),
    REPO_ROOT + '.claude/workflows/run-milestone.js',
    REPO_ROOT + '.claude/workflows/nightly-issues.js',
  ]
  for (const f of LF_CRITICAL) {
    if (!existsSync(f)) continue
    check(S, `LF-only (no \\r): ${f.slice(REPO_ROOT.length)}`, !/\r/.test(readFileSync(f, 'utf8')))
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
