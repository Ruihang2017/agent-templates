#!/usr/bin/env node
// adopt.mjs — one-command pattern installer for new and existing projects.
//
// Usage (run from a checkout of the agent-templates catalog):
//   node scripts/adopt.mjs <pattern-name> <target-dir> [--platform gh|glab] [--force]
//
// Installs into <target-dir>:
//   .claude/ / .codex/ / .agents/   runtime roots present in the pattern scaffold
//                                   (per-file; existing files skipped)
//   .claude/                 plus every compatible integration in integrations/<name>/.claude/
//                            (currently Claude-only; inert until /connect-* runs).
//                            Each integration's settings-allow.json is MERGED into
//                            .claude/settings.json permissions.allow — additive, idempotent,
//                            never replacing the file.
//   templates/ticket.template.md   the universal ticket format
//   .github/ or .gitlab/     universal tracker templates (issues + PR/MR) for the platform
//   docs/PRD.md              copied from a root PRD.md if present and docs/PRD.md is absent
//   docs/prd/ docs/adr/ docs/plans/   the docs skeleton the pipeline assumes
//   CLAUDE.md or AGENTS.md   created from the runtime snippet, or appended once
//                            (marker-checked); Claude installs add integration sections
//   .gitattributes           eol=lf rules for scaffold runtime files, appended once (marker-checked)
//   .gitignore               .claude/tmp/ scratch + allow-main-writes + docs/plans/*.md, appended once
//                            (marker-checked), and .env under a SEPARATE marker so an older
//                            install still gains the token rules on a re-adopt
//
// Idempotent: re-running skips everything that exists (--force overwrites files, never
// re-appends the snippet). Exit 0 = installed/verified; exit 1 = bad invocation.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CATALOG = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const FORCE = argv.includes('--force')

const pIx = argv.indexOf('--platform')
let PLATFORM = pIx !== -1 ? argv[pIx + 1] || '' : ''
if (pIx !== -1 && (!PLATFORM || PLATFORM.startsWith('--'))) {
  console.error('missing or invalid --platform value (expected gh or glab)')
  process.exit(1)
}

// --upstream [owner/repo]: opt IN to the "file pattern-level problems against the
// catalog" bullet in CLAUDE.md (off by default — the bullet names a specific repo and
// tells agents to file issues there, which commercial/private adopters do not want, and
// the repo slug should never land in a CLAUDE.md unasked; issue #40). Bare --upstream
// targets the catalog this pattern came from; --upstream <repo> points elsewhere.
const CATALOG_REPO = 'Ruihang2017/agent-templates'
const uIx = argv.indexOf('--upstream')
const UPSTREAM = uIx !== -1
let UPSTREAM_REPO = CATALOG_REPO
if (uIx !== -1 && argv[uIx + 1] && !argv[uIx + 1].startsWith('--')) UPSTREAM_REPO = argv[uIx + 1]

// positional args = everything that isn't a flag or a flag's consumed value
// --default-branch and --test-cmd are consumed here, with the others, because positional
// parsing runs immediately below: a value left unconsumed becomes the target directory.
const dbIx = argv.indexOf('--default-branch')
const tcIx = argv.indexOf('--test-cmd')
const consumed = new Set()
for (const ix of [pIx, uIx, dbIx, tcIx]) {
  if (ix !== -1 && argv[ix + 1] && !argv[ix + 1].startsWith('--')) consumed.add(ix + 1)
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !consumed.has(i))
const [pattern, targetArg] = positional
if (!pattern || !targetArg) {
  console.error('usage: node scripts/adopt.mjs <pattern-name> <target-dir> [--platform gh|glab] [--upstream [owner/repo]] [--force]')
  process.exit(1)
}

const scaffold = join(CATALOG, 'patterns', pattern, 'scaffold')
if (!existsSync(scaffold)) {
  const available = existsSync(join(CATALOG, 'patterns'))
    ? readdirSync(join(CATALOG, 'patterns')).filter((d) => existsSync(join(CATALOG, 'patterns', d, 'scaffold')))
    : []
  console.error(`unknown pattern: ${pattern}\navailable: ${available.join(', ') || '(none)'}`)
  process.exit(1)
}
const target = resolve(targetArg)
let targetOk = false
try { targetOk = statSync(target).isDirectory() } catch {}
if (!targetOk) {
  console.error(`target is not a directory: ${target}`)
  process.exit(1)
}

// Does this pattern use a tracker at all? A pattern DECLARES it, rather than adopt
// inferring it (catalog issue #158). Inference about whether a hard requirement applies is
// exactly the kind of thing that breaks quietly: a pattern could stop mentioning `glab`
// and silently lose its platform gate. A declaration cannot drift that way.
//
// Default is `true` — a pattern that says nothing gets the old, stricter behaviour, so
// this can never weaken the gate for the pattern that genuinely needs it.
const manifestPath = join(scaffold, 'pattern.json')
let NEEDS_TRACKER = true
if (existsSync(manifestPath)) {
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (m.tracker === false) NEEDS_TRACKER = false
    else if (m.tracker !== undefined && m.tracker !== true) {
      console.error(`${manifestPath}: "tracker" must be true or false, got ${JSON.stringify(m.tracker)}`)
      process.exit(1)
    }
  } catch (e) {
    // Fail loudly. Silently falling back to `true` would make a typo in the manifest look
    // like a pattern that wants a tracker, which is the confusing direction to be wrong in.
    console.error(`${manifestPath} is not valid JSON: ${e.message}`)
    process.exit(1)
  }
}
if (!NEEDS_TRACKER) {
  console.log(`platform: not required — ${pattern} declares no tracker integration (scaffold/pattern.json)`)
  if (PLATFORM) console.log(`  (--platform ${PLATFORM} accepted but unused: nothing this pattern installs reads it)`)
}

// ---------------------------------------------------------------------------
// Required project facts (catalog issue #190).
//
// The Codex `run-ticket` skill reads the default branch and the repository test command
// from AGENTS.md and stops if either is missing. The snippet supplied neither, so a
// completed fresh adoption produced a scaffold whose very first supervised run had to
// stop. Detected here, at adoption time, where the answers are actually available.
//
// Both are overridable, because detection can be wrong and being wrong silently is worse
// than asking: --default-branch <name> and --test-cmd "<command>".
// ---------------------------------------------------------------------------
const flagValue = (name) => {
  const i = argv.indexOf(name)
  if (i === -1) return ''
  const v = argv[i + 1]
  if (!v || v.startsWith('--')) {
    console.error(`missing value for ${name}`)
    process.exit(1)
  }
  return v
}

const detectDefaultBranch = () => {
  const git = (args) => {
    try { return execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
  }
  // origin/HEAD is the forge's own answer, so prefer it over whatever happens to be
  // checked out — a contributor sitting on a feature branch must not rename main.
  const originHead = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead) return originHead.replace(/^origin\//, '')
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current && current !== 'HEAD') return current
  return 'main'
}

const detectTestCmd = () => {
  const pkgPath = join(target, 'package.json')
  if (!existsSync(pkgPath)) return ''
  try {
    const scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')).scripts) || {}
    // Only `test`. Guessing at `check`/`ci`/`verify` would be inventing a project's
    // contract, and a wrong test command is worse than an unset one: it reads as verified.
    return typeof scripts.test === 'string' && scripts.test.trim() ? 'npm test' : ''
  } catch { return '' }
}

const DEFAULT_BRANCH = flagValue('--default-branch') || detectDefaultBranch()
const TEST_CMD = flagValue('--test-cmd') || detectTestCmd() || '(unset)'

// Platform detection (deterministic, offline). Signals in order:
//   1. origin host contains 'gitlab' / 'github'      (covers *.gitlab.com, gitlab.corp, github.com)
//   2. repo-local signal: .gitlab-ci.yml -> glab; existing .github/ -> gh
//      (this is what catches a self-hosted GitLab on a custom domain like git.company.com)
//   3. default gh, with a LOUD ambiguity note naming --platform
// Skipped entirely for a pattern that declares no tracker: there is nothing to detect,
// and demanding an answer that will never be read is a gate with no consequence.
if (!PLATFORM && NEEDS_TRACKER) {
  let host = ''
  try {
    const origin = execFileSync('git', ['-C', target, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    host = (origin.match(/(?:@|:\/\/)([^/:]+)[/:]/) || [])[1] || origin
  } catch {}
  const inconclusive = host ? `; origin host '${host}' was inconclusive` : ''
  if (/gitlab/i.test(host)) { PLATFORM = 'glab'; console.log(`platform: glab (from origin host '${host}'; override with --platform)`) }
  else if (/github/i.test(host)) { PLATFORM = 'gh'; console.log(`platform: gh (from origin host '${host}'; override with --platform)`) }
  else if (existsSync(join(target, '.gitlab-ci.yml'))) { PLATFORM = 'glab'; console.log(`platform: glab (from .gitlab-ci.yml${inconclusive}; override with --platform)`) }
  else if (existsSync(join(target, '.github'))) { PLATFORM = 'gh'; console.log(`platform: gh (from existing .github/${inconclusive}; override with --platform)`) }
  else {
    // No signal: never guess — a wrong guess installs the wrong tracker config and a
    // wrong Tracker line (issue #38). Ask when interactive; otherwise stop and install
    // nothing so the agent/CI can re-run with an explicit --platform.
    const reason = host ? `could not classify origin host '${host}'` : 'no git remote, and no .gitlab-ci.yml or .github/ to infer from'
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      // Ctrl+D / closed stdin before an answer: abort cleanly (nothing installed)
      // instead of leaving the top-level await unsettled.
      rl.on('close', () => {
        if (!PLATFORM) {
          console.error('\nplatform: undetermined (input closed). Re-run with --platform gh|glab (nothing was installed).')
          process.exit(1)
        }
      })
      try {
        console.log(`Cannot determine the tracker platform (${reason}).`)
        for (;;) {
          const a = (await rl.question('Which tracker is this repo on? [gh/glab] ')).trim().toLowerCase()
          if (a === 'gh' || a === 'github') { PLATFORM = 'gh'; break }
          if (a === 'glab' || a === 'gitlab') { PLATFORM = 'glab'; break }
          console.log("please answer 'gh' or 'glab'")
        }
      } finally { rl.close() }
    } else {
      console.error(`platform: undetermined — ${reason}. Re-run with --platform gh|glab (nothing was installed).`)
      process.exit(1)
    }
  }
}
// A tracker-less pattern may legitimately have no platform at all. An explicitly WRONG
// value is still an error either way — accepting `--platform nope` because the value
// happens to be unused would teach the operator the flag is not validated.
if (NEEDS_TRACKER ? (PLATFORM !== 'gh' && PLATFORM !== 'glab') : (PLATFORM && PLATFORM !== 'gh' && PLATFORM !== 'glab')) {
  console.error(`unknown platform: ${PLATFORM} (expected gh or glab)`)
  process.exit(1)
}

let installed = 0
let skipped = 0
const note = (line) => console.log(line)

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name)
    if (e.isDirectory()) yield* walk(f)
    else yield f
  }
}

// Installed text files are ALWAYS written with LF line endings: the Claude Code
// Workflow tool rejects scripts containing \r ("control characters that would be
// hidden in the approval dialog") — observed in the field on a Windows checkout
// (catalog issue #21). CRLF can sneak in via git autocrlf on the CATALOG checkout,
// so normalization happens here at install time, regardless of the source state.
const TEXT_EXT = /\.(md|mjs|js|json|ya?ml|txt)$/i
const copyFile = (src, dst, label) => {
  if (existsSync(dst) && !FORCE) {
    console.log(`= exists  ${label}`)
    skipped++
    return false
  }
  mkdirSync(dirname(dst), { recursive: true })
  if (TEXT_EXT.test(src)) {
    writeFileSync(dst, readFileSync(src, 'utf8').replace(/\r\n/g, '\n'))
  } else {
    cpSync(src, dst)
  }
  console.log(`+ install ${label}`)
  installed++
  return true
}

// 1. Runtime-native scaffold roots. A pattern may target Claude Code, Codex, or both.
const runtimeRoots = ['.claude', '.codex', '.agents'].filter((name) => existsSync(join(scaffold, name)))
if (!runtimeRoots.length) {
  console.error(`pattern scaffold has no supported runtime root (.claude, .codex, or .agents): ${scaffold}`)
  process.exit(1)
}
const isClaudePattern = runtimeRoots.includes('.claude')
const isCodexPattern = runtimeRoots.includes('.codex') || runtimeRoots.includes('.agents')
for (const runtimeRoot of runtimeRoots) {
  for (const src of walk(join(scaffold, runtimeRoot))) {
    const rel = relative(scaffold, src).replaceAll('\\', '/')
    const dst = join(target, rel)
    const existed = existsSync(dst)
    copyFile(src, dst, rel)
    if (existed && !FORCE && rel === '.claude/settings.json') {
      note('  (note) existing .claude/settings.json kept — merge the hooks.PreToolUse entry and permissions.allow from the scaffold manually')
    }
    if (existed && !FORCE && rel === '.codex/config.toml') {
      note('  (note) existing .codex/config.toml kept — merge the [agents] settings and sandbox defaults from the scaffold manually')
    }
  }
}

// 1b. Runtime-compatible integrations. Installed unconditionally for that runtime but
// INERT until the user opts in with the integration's connect command.
// Integrations declare a runtime-specific surface. The current Asana integration is
// Claude-only; do not install inert .claude commands into a Codex-only project.
const INTEGRATIONS = isClaudePattern ? ['asana'] : []
// A name in that list whose directory is absent is a PACKAGING BUG, never a normal
// condition — and skipping it quietly is how issue #143 shipped: the npm tarball omitted
// `integrations/` entirely, adopt exited 0 having installed none of it, and then printed
// "Optional — mirror … /connect-asana" pointing at a README that was not in the package.
// Exit 0, nothing installed, and instructions to use it. Track what actually arrived so
// the closing guidance can only advertise what exists.
const integrationsInstalled = new Set()
const integrationsMissing = []
for (const name of INTEGRATIONS) {
  const root = join(CATALOG, 'integrations', name, '.claude')
  if (!existsSync(root)) { integrationsMissing.push(name); continue }
  integrationsInstalled.add(name)
  for (const src of walk(root)) {
    const rel = join('.claude', relative(root, src)).replaceAll('\\', '/')
    copyFile(src, join(target, rel), rel)
  }
}

// 1c. merge each integration's permission entries into the target's settings.json.
// A deterministic script that is not allowlisted prompts on every call — which does not
// merely annoy, it BREAKS autonomous runs and the headless nightly sweep, where no human
// is present to approve. Merged additively (never replacing the file) and idempotently, so
// a customized settings.json keeps its own entries and a re-adopt is a no-op.
{
  const settingsPath = join(target, '.claude', 'settings.json')
  const wanted = []
  for (const name of INTEGRATIONS) {
    const src = join(CATALOG, 'integrations', name, 'settings-allow.json')
    if (!existsSync(src)) continue
    try {
      const frag = JSON.parse(readFileSync(src, 'utf8'))
      for (const rule of frag.allow || []) wanted.push(rule)
    } catch {
      note(`  (warn) ${name}: settings-allow.json is unparseable — skipped, allowlist NOT updated`)
    }
  }
  if (wanted.length && existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
      settings.permissions = settings.permissions || {}
      settings.permissions.allow = settings.permissions.allow || []
      const missing = wanted.filter((r) => !settings.permissions.allow.includes(r))
      if (missing.length) {
        settings.permissions.allow.push(...missing)
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
        console.log(`+ merge   .claude/settings.json (${missing.length} integration permission rule(s))`)
        installed++
      } else {
        console.log('= exists  .claude/settings.json (integration permission rules already present)')
        skipped++
      }
    } catch {
      // Never leave a broken settings.json behind — a malformed one is the user's to fix.
      note('  (warn) existing .claude/settings.json is unparseable — add these to permissions.allow by hand:')
      for (const r of wanted) note(`           ${r}`)
    }
  }
}

// 2. universal ticket template
copyFile(join(CATALOG, 'templates', 'ticket.template.md'), join(target, 'templates', 'ticket.template.md'), 'templates/ticket.template.md')

// 3. platform tracker templates (issues + PR/MR)
// Skipped for a pattern that declares no tracker: issue and MR templates it never
// references are noise in the adopter's repo, and installing them implies a workflow the
// pattern does not have (issue #158).
if (NEEDS_TRACKER) {
  const trackerSrc = join(CATALOG, 'templates', 'tracker', PLATFORM === 'gh' ? 'github' : 'gitlab')
  const trackerDstRoot = join(target, PLATFORM === 'gh' ? '.github' : '.gitlab')
  for (const src of walk(trackerSrc)) {
    const rel = relative(trackerSrc, src).replaceAll('\\', '/')
    copyFile(src, join(trackerDstRoot, rel), `${PLATFORM === 'gh' ? '.github' : '.gitlab'}/${rel}`)
  }
} else {
  console.log('= skip    tracker issue/MR templates (this pattern declares no tracker)')
}

// 4. docs skeleton
for (const d of ['docs/prd', 'docs/adr', 'docs/plans']) {
  const dir = join(target, d)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.gitkeep'), '')
    console.log(`+ mkdir   ${d}/`)
    installed++
  } else {
    console.log(`= exists  ${d}/`)
    skipped++
  }
}

// 5. root PRD.md -> docs/PRD.md (copy, never move — the pipeline reads docs/PRD.md)
const rootPrd = join(target, 'PRD.md')
const docsPrd = join(target, 'docs', 'PRD.md')
if (existsSync(rootPrd) && !existsSync(docsPrd)) {
  cpSync(rootPrd, docsPrd)
  console.log('+ install docs/PRD.md (copied from root PRD.md — the pipeline reads docs/PRD.md; delete the root copy when ready)')
  installed++
} else if (existsSync(docsPrd)) {
  console.log('= exists  docs/PRD.md')
  skipped++
} else {
  // Pattern-agnostic wording: every pattern starts from docs/PRD.md, but they start it
  // with different commands, and naming the wrong one sends the user to a command that
  // was never installed.
  note('  (note) no PRD.md found — write docs/PRD.md before running the pattern\'s first command (see NEXT STEPS below)')
}

// 6. Runtime guidance: Claude patterns seed CLAUDE.md; Codex patterns seed AGENTS.md.
// The snippet defaults its Tracker line to `gh`; rewrite it to the resolved platform so the
// pipeline reads the correct tracker from project guidance instead of re-guessing each run.
// Normalize CRLF up front: the marker/Tracker matching below needs literal \n, and a
// catalog checkout under git autocrlf can carry \r\n — don't let that silently no-op the
// strip and leak the block (same posture as copyFile; catalog issues #21/#23/#40).
const guidance = existsSync(join(scaffold, 'agents-md-snippet.md'))
  ? { snippetName: 'agents-md-snippet.md', targetName: 'AGENTS.md', title: 'Project Agent Guidance' }
  : { snippetName: 'claude-md-snippet.md', targetName: 'CLAUDE.md', title: 'Project Constitution' }
const snippetPath = join(scaffold, guidance.snippetName)
if (!existsSync(snippetPath)) {
  console.error(`pattern scaffold is missing runtime guidance: expected ${snippetPath}`)
  process.exit(1)
}
let snippet = readFileSync(snippetPath, 'utf8')
  .replace(/\r\n/g, '\n')
  // Only rewritten when the pattern has a tracker. A tracker-less snippet has no such
  // line, so this is a no-op there — but leaving the rewrite unconditional would bake a
  // platform into any future snippet that happened to mention one.
  .replace('**Tracker: `gh`**', NEEDS_TRACKER ? `**Tracker: \`${PLATFORM}\`**` : '**Tracker: none**')
  // Required project facts (catalog issue #190). The Codex `run-ticket` skill reads the
  // default branch and the repository test command from the guidance file and STOPS if
  // either is missing — so a scaffold that omitted them made the very first supervised run
  // stop. Detect what can be detected; write `(unset)` for the rest and say so loudly.
  .replace('**Default branch: `main`**', `**Default branch: \`${DEFAULT_BRANCH}\`**`)
  .replace('**Test command: `(unset)`**', `**Test command: \`${TEST_CMD}\`**`)
// Upstream-escalation bullet is opt-in (issue #40): keep it only with --upstream (pointing
// at the chosen catalog repo), otherwise strip the whole marked block so no catalog repo
// slug or "file issues upstream" instruction lands in the adopted CLAUDE.md.
const UP_RE = /\n<!-- upstream-escalation:start -->\n([\s\S]*?)\n<!-- upstream-escalation:end -->/
if (UPSTREAM) {
  snippet = snippet.replace(UP_RE, (_, bullet) => '\n' + bullet.split(CATALOG_REPO).join(UPSTREAM_REPO))
  console.log(`upstream escalation: on (issues -> ${UPSTREAM_REPO})`)
} else {
  snippet = snippet.replace(UP_RE, '')
  console.log('upstream escalation: off (enable with --upstream [owner/repo])')
}
// Derived from the snippet, never hardcoded. This used to be the literal three-agent
// heading, which was correct only while the catalog had exactly one pattern: adopting any
// other pattern would look for a marker its snippet does not contain, find it missing on
// every re-run, and append the whole block again each time (catalog issue #156). The
// snippet's own first `## ` heading is the marker by construction, so it cannot drift.
const MARKER = (snippet.match(/^## .+$/m) || [])[0]
if (!MARKER) {
  console.error(`error: ${snippetPath} has no '## ' heading to use as its idempotency marker.`)
  console.error('Without one, re-running adopt would append the snippet again every time. Add a heading to the snippet.')
  process.exit(1)
}
const guidancePath = join(target, guidance.targetName)
if (!existsSync(guidancePath)) {
  const header = `# ${basename(target)} — ${guidance.title}\n\n> Auto-loaded into every session. Installed by agent-templates adopt.mjs on ${new Date().toISOString().slice(0, 10)}.\n> Add your project facts and non-negotiable constraints above the pipeline section.\n\n`
  writeFileSync(guidancePath, header + snippet)
  console.log(`+ install ${guidance.targetName} (seeded from the pattern snippet)`)
  installed++
} else if (!readFileSync(guidancePath, 'utf8').includes(MARKER)) {
  writeFileSync(guidancePath, readFileSync(guidancePath, 'utf8').trimEnd() + '\n\n' + snippet)
  console.log(`+ append  ${guidance.targetName} (pipeline snippet appended)`)
  installed++
} else {
  console.log(`= exists  ${guidance.targetName} (pipeline snippet already present)`)
  skipped++
}

// 6b. integration CLAUDE.md snippets, each marker-guarded independently of the pattern
// block so a re-adopt on an older install still picks them up.
for (const name of INTEGRATIONS) {
  const src = join(CATALOG, 'integrations', name, 'claude-md-snippet.md')
  if (!existsSync(src)) continue
  const frag = readFileSync(src, 'utf8').replace(/\r\n/g, '\n')
  const startMarker = `<!-- ${name}-integration:start -->`
  const current = existsSync(guidancePath) ? readFileSync(guidancePath, 'utf8') : ''
  if (current.includes(startMarker)) {
    console.log(`= exists  CLAUDE.md (${name} integration section already present)`)
    skipped++
  } else {
    writeFileSync(guidancePath, current.trimEnd() + '\n\n' + frag)
    console.log(`+ append  CLAUDE.md (${name} integration section)`)
    installed++
  }
}

// 7. .gitattributes: pin scaffold runtime files to LF. Install-time normalization
// (above) is not enough on Windows — a later `git checkout` with autocrlf re-CRLFs
// them and the Workflow tool rejects the script content (catalog issue #23).
const codexOnly = isCodexPattern && !isClaudePattern
const GA_MARKER = codexOnly
  ? '# agent-templates: Codex scaffold runtime files (keep LF)'
  : '# agent-templates: Workflow tool rejects CRLF scripts (keep LF)'
const GA_RULES = codexOnly
  ? `${GA_MARKER}\n.codex/agents/*.toml text eol=lf\n.codex/scripts/*.mjs text eol=lf\n.agents/skills/**/SKILL.md text eol=lf\n`
  : `${GA_MARKER}\n.claude/workflows/*.js text eol=lf\n.claude/scripts/*.mjs text eol=lf\n`
const gaPath = join(target, '.gitattributes')
if (!existsSync(gaPath)) {
  writeFileSync(gaPath, GA_RULES)
  console.log('+ install .gitattributes (eol=lf for scaffold runtime files)')
  installed++
} else if (!readFileSync(gaPath, 'utf8').includes(GA_MARKER)) {
  writeFileSync(gaPath, readFileSync(gaPath, 'utf8').trimEnd() + '\n\n' + GA_RULES)
  console.log('+ append  .gitattributes (eol=lf rules for scaffold runtime files)')
  installed++
} else {
  console.log('= exists  .gitattributes (eol=lf rules already present)')
  skipped++
}

// 7b. .gitattributes: docs/prd/dag.html, under its OWN marker so a repo adopted before
// this rule existed still picks it up (an existing install already carries GA_MARKER, so
// the block above would skip it forever — the same reason GI_WT_MARKER is separate).
//
// The file is committed by adopt and REWRITTEN by dag-report.mjs on every run, including
// mid-run when rescanEvery fires. With no eol rule a Windows checkout wants CRLF while the
// generator writes LF, so it sits permanently modified with an EMPTY diff — and
// deliver-ticket.mjs refuses to merge on a dirty tree. One generated file then blocks
// every delivery, intermittently, depending on whether the DAG happened to be regenerated
// before that ticket's delivery ran (catalog issue #153).
if (NEEDS_TRACKER) {
  const GA_DAG_MARKER = '# agent-templates: generated by dag-report.mjs — keep LF so regeneration does not dirty the tree'
  const GA_DAG_RULES = `${GA_DAG_MARKER}\ndocs/prd/dag.html text eol=lf\n`
  const gaNow = existsSync(gaPath) ? readFileSync(gaPath, 'utf8') : ''
  if (!gaNow.includes(GA_DAG_MARKER)) {
    writeFileSync(gaPath, gaNow ? gaNow.trimEnd() + '\n\n' + GA_DAG_RULES : GA_DAG_RULES)
    console.log('+ append  .gitattributes (eol=lf for the generated docs/prd/dag.html)')
    installed++
  } else {
    console.log('= exists  .gitattributes (dag.html eol rule already present)')
    skipped++
  }
}

// 8. .gitignore: the deliver step stages the Reviewer's verdict under .claude/tmp/ for
// --verdict-file; that ephemeral scratch must not read as a dirty tree (deliver-ticket
// also ignores it) nor ever be committed (catalog issue #50). Same for the write-guard
// override sentinel.
const runtimeDir = codexOnly ? '.codex' : '.claude'
const GI_MARKER = codexOnly
  ? '# agent-templates: ephemeral Codex pipeline scratch'
  : '# agent-templates: ephemeral pipeline scratch'
// docs/plans/*.md: the Architect's HOW plan is ephemeral (the ticket is the source of
// truth, #53) and only needs to EXIST on disk for the DoD, not be committed — ignoring it
// keeps untracked plans from tripping deliver's clean-tree check (#58). .gitkeep stays tracked.
const GI_RULES = `${GI_MARKER}\n${runtimeDir}/tmp/\n${runtimeDir}/allow-main-writes\ndocs/plans/*.md\n`
const giPath = join(target, '.gitignore')
if (!existsSync(giPath)) {
  writeFileSync(giPath, GI_RULES)
  console.log(`+ install .gitignore (${runtimeDir}/tmp/ scratch)`)
  installed++
} else if (!readFileSync(giPath, 'utf8').includes(GI_MARKER)) {
  writeFileSync(giPath, readFileSync(giPath, 'utf8').trimEnd() + '\n\n' + GI_RULES)
  console.log(`+ append  .gitignore (${runtimeDir}/tmp/ scratch)`)
  installed++
} else {
  console.log('= exists  .gitignore (pipeline scratch rules already present)')
  skipped++
}

// 8b. .gitignore: a SEPARATE marker for secret-bearing files, so an existing install that
// already carries the scratch block above still gets this appended on a re-adopt. `.env` is
// where a user is most likely to park ASANA_TOKEN; an Asana PAT acts as the whole user, so
// it must never be committable by accident.
// 8c. .gitignore: harness worktrees (issue #141). At concurrency > 1 the Workflow tool
// puts each isolated agent's worktree at `.claude/worktrees/wf_<runId>-<agentIndex>/` —
// INSIDE the repo, and the pattern does not choose that path. Untracked, so
// `git status --porcelain -uall` reports them and deliver-ticket's clean-tree guard
// refuses to merge: every delivery blocked. Its own marker, so a repo adopted before this
// rule existed gains it on a re-adopt rather than being skipped by the block above.
// NOTE this only silences git. It does NOT stop test runners, linters or bundlers from
// walking into those checkouts — see INSTALL.md § Parallel runs for the per-tool ignores.
const GI_WT_MARKER = codexOnly
  ? '# agent-templates: Codex worktrees — never commit, never scan'
  : '# agent-templates: harness worktrees (concurrency > 1) — never commit, never scan'
const GI_WT_RULES = `${GI_WT_MARKER}\n${runtimeDir}/worktrees/\n`
const giBefore = existsSync(giPath) ? readFileSync(giPath, 'utf8') : ''
if (!giBefore.includes(GI_WT_MARKER)) {
  writeFileSync(giPath, giBefore ? giBefore.trimEnd() + '\n\n' + GI_WT_RULES : GI_WT_RULES)
  console.log(`+ append  .gitignore (${runtimeDir}/worktrees/ — harness worktrees)`)
  installed++
} else {
  console.log('= exists  .gitignore (worktree rules already present)')
  skipped++
}

const GI_SECRET_MARKER = '# agent-templates: never commit tokens (ASANA_TOKEN etc.)'
const GI_SECRET_RULES = `${GI_SECRET_MARKER}\n.env\n.env.local\n`
const giNow = existsSync(giPath) ? readFileSync(giPath, 'utf8') : ''
if (!giNow.includes(GI_SECRET_MARKER)) {
  writeFileSync(giPath, giNow ? giNow.trimEnd() + '\n\n' + GI_SECRET_RULES : GI_SECRET_RULES)
  console.log('+ append  .gitignore (.env — never commit tokens)')
  installed++
} else {
  console.log('= exists  .gitignore (token rules already present)')
  skipped++
}

console.log(`\nadopt: ${installed} installed, ${skipped} already present. Pattern: ${pattern}, platform: ${PLATFORM}.`)

// Loud, not silent (issue #143). Not fatal: the pattern itself installed correctly, and
// failing the whole adopt over an optional add-on would be disproportionate. But it must
// never read as success, and the next steps below must not advertise it.
if (integrationsMissing.length) {
  console.error(`\n! PACKAGING PROBLEM — these integrations are declared but absent from this distribution: ${integrationsMissing.join(', ')}`)
  console.error(`  Nothing was installed for them, so their /connect-* commands will NOT exist.`)
  console.error(`  This is a bug in the agent-templates package, not in your repo — please report it.`)
}

// Per-pattern, because the steps ARE the pattern: the three-agent flow starts at
// /breakdown-prd and needs an authenticated tracker CLI, hub-and-spoke starts at
// /hub-brief and needs the codex binary instead. Printing one pattern's steps after
// installing another is worse than printing none — it names commands that do not exist.
const stepsFile = join(scaffold, 'next-steps.txt')
const nextSteps = existsSync(stepsFile)
  ? readFileSync(stepsFile, 'utf8').replace(/\r\n/g, '\n').trimEnd()
      .split('{{PLATFORM}}').join(PLATFORM)
      .split('{{CATALOG}}').join(CATALOG)
  : `  1. Review ${guidance.targetName} and add your project facts.
  2. Run the pattern's first workflow — see
     ${join(scaffold, 'INSTALL.md')} for the full flow.`

console.log(`
NEXT STEPS (details: ${join(CATALOG, 'ADOPTING.md')})
${nextSteps}` +
  // Only advertised when it actually arrived — telling someone to run a command that was
  // never installed is what made #143 worse than a plain omission.
  // Unnumbered: the steps above are per-pattern now, so there is no fixed number to
  // follow on from without silently mislabelling one pattern's list.
  (integrationsInstalled.has('asana') ? `
  Optional — mirror milestones/tickets into Asana:  /connect-asana
     (needs an ASANA_TOKEN env var and an existing Asana task for this repo;
      inert until configured. Details: ${join(CATALOG, 'integrations', 'asana', 'README.md')})` : ''))
