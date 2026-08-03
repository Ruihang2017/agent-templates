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
  '.claude/scripts/dag-core.mjs',
  '.claude/scripts/dag-report.mjs',
  '.claude/scripts/dag-scan.mjs',
  '.claude/scripts/prd-phase.mjs',
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
  'architect.md': { model: 'claude-opus-5', effort: 'high' },
  'builder.md': { model: 'claude-opus-5', effort: 'medium' },
  'reviewer.md': { model: 'claude-sonnet-5', effort: 'high' },
  'triage.md': { model: 'claude-sonnet-5', effort: 'high' },
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
      'Bash(node .claude/scripts/dag-report.mjs:*)',
      'Bash(node .claude/scripts/dag-scan.mjs:*)',
      'Bash(node .claude/scripts/prd-phase.mjs:*)',
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
    p('.claude/scripts/dag-core.mjs'),
    p('.claude/scripts/dag-report.mjs'),
    p('.claude/scripts/dag-scan.mjs'),
    p('.claude/scripts/prd-phase.mjs'),
    p('.claude/scripts/deliver-ticket.mjs'),
    REPO_ROOT + '.claude/workflows/run-milestone.js',
    REPO_ROOT + '.claude/workflows/nightly-issues.js',
  ]
  for (const f of LF_CRITICAL) {
    if (!existsSync(f)) continue
    check(S, `LF-only (no \\r): ${f.slice(REPO_ROOT.length)}`, !/\r/.test(readFileSync(f, 'utf8')))
  }

  // issue #109: the repo gated artifact CORRECTNESS hard and artifact DELIVERY not at
  // all — suite-site asserted the generated page was right while the live page sat eight
  // PRs stale, still advertising the pre-Opus-5 model table, because site/ is gitignored
  // and nothing deployed it. Deleting or de-triggering the deploy workflow must fail the
  // merge gate rather than silently re-open that hole.
  {
    const wf = REPO_ROOT + '.github/workflows/pages.yml'
    check(S, 'a Pages deploy workflow exists', existsSync(wf))
    if (existsSync(wf)) {
      const text = readFileSync(wf, 'utf8')
      check(S, 'pages workflow triggers on push to main', /push:\s*\n\s*branches:\s*\[main\]/.test(text))
      check(S, 'pages workflow builds the site from the generator', /build-site\.mjs/.test(text))
      check(S, 'pages workflow gates the deploy on the E2E suite', /npm test/.test(text))
      check(S, 'pages workflow can write (needs contents: write to push gh-pages)', /contents:\s*write/.test(text))
    }
  }

  // issue #119: the release workflow has failed 2/2 (v0.8.0, v0.9.0 — both EOTP on a
  // token that cannot publish unattended) and every actual release since 0.7.0 shipped
  // by hand. The workflow is not the defect, so guard it the way #110 guards pages.yml:
  // its gates and its manual-retry path must not quietly disappear.
  {
    const wf = REPO_ROOT + '.github/workflows/publish.yml'
    check(S, 'a publish workflow exists', existsSync(wf))
    if (existsSync(wf)) {
      const text = readFileSync(wf, 'utf8')
      check(S, 'publish workflow triggers on version tags', /tags:\s*\['v\[0-9\]\*'\]/.test(text))
      check(S, 'publish workflow is manually dispatchable (retry without tag surgery)', /workflow_dispatch:/.test(text))
      check(S, 'publish workflow gates on the E2E suite', /npm test/.test(text))
      check(S, 'publish workflow refuses a tag/version mismatch', /does not match package\.json/.test(text))
      check(S, 'publish workflow reads the token from a secret, never a literal', /secrets\.NPM_TOKEN/.test(text) && !/npm_[A-Za-z0-9]{20,}/.test(text))
    }
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
    '.claude/workflows/start-all.js': SCAFFOLD + '.claude/workflows/start-all.js',
    '.claude/scripts/dag-core.mjs': SCAFFOLD + '.claude/scripts/dag-core.mjs',
    '.claude/scripts/dag-scan.mjs': SCAFFOLD + '.claude/scripts/dag-scan.mjs',
    '.claude/scripts/prd-phase.mjs': SCAFFOLD + '.claude/scripts/prd-phase.mjs',
    '.claude/scripts/dag-report.mjs': SCAFFOLD + '.claude/scripts/dag-report.mjs',
    '.claude/scripts/milestone-dag.mjs': SCAFFOLD + '.claude/scripts/milestone-dag.mjs',
    '.claude/scripts/publish-tickets.mjs': SCAFFOLD + '.claude/scripts/publish-tickets.mjs',
    '.claude/scripts/deliver-ticket.mjs': SCAFFOLD + '.claude/scripts/deliver-ticket.mjs',
    '.claude/commands/plan-ticket.md': SCAFFOLD + '.claude/commands/plan-ticket.md',
    '.claude/commands/build-ticket.md': SCAFFOLD + '.claude/commands/build-ticket.md',
    '.claude/commands/review-ticket.md': SCAFFOLD + '.claude/commands/review-ticket.md',
    '.claude/commands/start-milestone.md': SCAFFOLD + '.claude/commands/start-milestone.md',
    '.claude/commands/start-all.md': SCAFFOLD + '.claude/commands/start-all.md',
    '.claude/commands/breakdown-prd.md': SCAFFOLD + '.claude/commands/breakdown-prd.md',
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
    const srcPath = REPO_ROOT + srcRel
    // Guard the SOURCE read too: an unguarded readFileSync here threw ENOENT and
    // crashed the whole suite when a scaffold file was missing, taking ~50 later
    // integrity checks down with it. A missing source is a finding, not an abort.
    const ok = existsSync(repoPath) && existsSync(srcPath) &&
      norm(readFileSync(repoPath, 'utf8')) === norm(readFileSync(srcPath, 'utf8'))
    check(S, `self-hosted copy in sync: ${repoRel}`, ok, existsSync(srcPath) ? '' : `scaffold source missing: ${srcRel}`)
  }

  // issue #124: universal integrations. NOT part of the scaffold -> .claude/ byte-sync
  // above, deliberately — the catalog itself is not tracked in Asana, so there is no
  // self-hosted copy to keep in step. They still need the same shipped-file, LF, and
  // frontmatter guarantees as scaffold surface, because adopt.mjs installs them into
  // every target repo.
  {
    const INTEGRATION_FILES = [
      'integrations/asana/README.md',
      'integrations/asana/claude-md-snippet.md',
      'integrations/asana/asana.example.json',
      'integrations/asana/.claude/scripts/asana-sync.mjs',
      'integrations/asana/.claude/commands/connect-asana.md',
      'integrations/asana/settings-allow.json',
    ]
    for (const rel of INTEGRATION_FILES) {
      check(S, `integration file ships: ${rel}`, existsSync(REPO_ROOT + rel))
    }

    const script = REPO_ROOT + 'integrations/asana/.claude/scripts/asana-sync.mjs'
    if (existsSync(script)) {
      const text = readFileSync(script, 'utf8')
      // Same LF rule as every other installed runtime file (issue #21/#23).
      check(S, 'LF-only (no \\r): integrations/asana/.claude/scripts/asana-sync.mjs', !/\r/.test(text))
      // The fail-soft contract is the whole safety story: Asana must never gate delivery.
      // A stray unconditional non-zero exit would silently turn the mirror into a gate.
      const badExits = (text.match(/process\.exit\((?!0\)|1\)\n?$)/g) || []).length
      check(S, 'asana-sync exits only 0 or 1 (fail-soft contract)',
        /process\.exit\(0\)/.test(text) && !/process\.exit\([^01]/.test(text), `suspicious exits: ${badExits}`)
      // The token must never be readable from anywhere but the environment.
      check(S, 'asana-sync reads the token ONLY from ASANA_TOKEN env',
        /process\.env\.ASANA_TOKEN/.test(text) && !/--token/.test(text))
      check(S, 'asana-sync never writes the token to the config', /refusing-to-write-secret/.test(text))
      // It must not reach for Asana search — premium-only, and 10-60s stale after writes.
      check(S, 'asana-sync does not use the Asana search endpoint', !/tasks\/search/.test(text))
      check(S, 'asana-sync honors Retry-After on 429', /retry-after/i.test(text))
      check(S, 'asana-sync emits the machine-readable summary line', /ASANA-SYNC-JSON: /.test(text))
    }

    const cmd = REPO_ROOT + 'integrations/asana/.claude/commands/connect-asana.md'
    if (existsSync(cmd)) {
      const text = readFileSync(cmd, 'utf8')
      const fm = (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
      check(S, 'connect-asana has a non-empty description', /^description:\s*\S/m.test(fm))
      check(S, 'connect-asana declares its argument-hint', /^argument-hint:/m.test(fm))
      // A command that told the agent to write the config itself would trip the pattern's
      // main-session write guard, and a command that asked for the token would leak it.
      check(S, 'connect-asana routes all writes through the script', /asana-sync\.mjs/.test(text))
      check(S, 'connect-asana never asks for the token in-session', /[Nn]ever.{0,40}paste/.test(text))
    }

    const exampleCfg = REPO_ROOT + 'integrations/asana/asana.example.json'
    if (existsSync(exampleCfg)) {
      let parsed = null
      try { parsed = JSON.parse(readFileSync(exampleCfg, 'utf8')) } catch {}
      check(S, 'asana.example.json parses', parsed !== null)
      check(S, 'asana.example.json carries no token-shaped key',
        parsed !== null && !Object.keys(parsed).some((k) => /token|secret|pat/i.test(k)))
    }

    // adopt.mjs must actually install the layer and git-ignore .env, or the whole
    // integration ships without reaching any target repo (the #109 failure class).
    const adopt = readFileSync(REPO_ROOT + 'scripts/adopt.mjs', 'utf8')
    check(S, 'adopt installs universal integrations', /integrations/.test(adopt) && /INTEGRATIONS/.test(adopt))
    check(S, 'adopt git-ignores .env so a token cannot be committed', /\.env/.test(adopt))
    check(S, 'adopt appends the integration CLAUDE.md section under its own marker',
      /-integration:start/.test(adopt))
    check(S, 'adopt merges integration permission rules into settings.json',
      /settings-allow\.json/.test(adopt) && /permissions/.test(adopt))

    // The allow rule must name the script that actually ships, or it grants nothing.
    const allowFrag = REPO_ROOT + 'integrations/asana/settings-allow.json'
    if (existsSync(allowFrag)) {
      let frag = null
      try { frag = JSON.parse(readFileSync(allowFrag, 'utf8')) } catch {}
      check(S, 'asana settings-allow.json parses', frag !== null)
      check(S, 'asana allow rule targets the installed script path',
        frag !== null && (frag.allow || []).some((r) => r.includes('.claude/scripts/asana-sync.mjs')))
    }
  }
}
