#!/usr/bin/env node
// adopt.mjs — one-command pattern installer for new and existing projects.
//
// Usage (run from a checkout of the agent-templates catalog):
//   node scripts/adopt.mjs <pattern-name> <target-dir> [--platform gh|glab] [--force]
//
// Installs into <target-dir>:
//   .claude/                 from the pattern's scaffold (per-file; existing files skipped)
//   templates/ticket.template.md   the universal ticket format
//   .github/ or .gitlab/     universal tracker templates (issues + PR/MR) for the platform
//   docs/PRD.md              copied from a root PRD.md if present and docs/PRD.md is absent
//   docs/prd/ docs/adr/ docs/plans/   the docs skeleton the pipeline assumes
//   CLAUDE.md                created from the snippet, or snippet appended once (marker-checked)
//   .gitattributes           eol=lf rules for scaffold runtime files, appended once (marker-checked)
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
const consumed = new Set()
for (const [flag, ix] of [['--platform', pIx], ['--upstream', uIx]]) {
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

// Platform detection (deterministic, offline). Signals in order:
//   1. origin host contains 'gitlab' / 'github'      (covers *.gitlab.com, gitlab.corp, github.com)
//   2. repo-local signal: .gitlab-ci.yml -> glab; existing .github/ -> gh
//      (this is what catches a self-hosted GitLab on a custom domain like git.company.com)
//   3. default gh, with a LOUD ambiguity note naming --platform
if (!PLATFORM) {
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
if (PLATFORM !== 'gh' && PLATFORM !== 'glab') {
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

// 1. scaffold .claude/ (per-file so re-runs skip; settings.json conflicts get a manual-merge note)
for (const src of walk(join(scaffold, '.claude'))) {
  const rel = relative(scaffold, src).replaceAll('\\', '/')
  const dst = join(target, rel)
  const existed = existsSync(dst)
  copyFile(src, dst, rel)
  if (existed && !FORCE && rel === '.claude/settings.json') {
    note('  (note) existing .claude/settings.json kept — merge the hooks.PreToolUse entry and permissions.allow from the scaffold manually')
  }
}

// 2. universal ticket template
copyFile(join(CATALOG, 'templates', 'ticket.template.md'), join(target, 'templates', 'ticket.template.md'), 'templates/ticket.template.md')

// 3. platform tracker templates (issues + PR/MR)
const trackerSrc = join(CATALOG, 'templates', 'tracker', PLATFORM === 'gh' ? 'github' : 'gitlab')
const trackerDstRoot = join(target, PLATFORM === 'gh' ? '.github' : '.gitlab')
for (const src of walk(trackerSrc)) {
  const rel = relative(trackerSrc, src).replaceAll('\\', '/')
  copyFile(src, join(trackerDstRoot, rel), `${PLATFORM === 'gh' ? '.github' : '.gitlab'}/${rel}`)
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
  note('  (note) no PRD.md found — write docs/PRD.md before running /breakdown-prd')
}

// 6. CLAUDE.md: create from the snippet, or append it once (marker-checked, never duplicated).
// The snippet defaults its Tracker line to `gh`; rewrite it to the resolved platform so the
// pipeline reads the correct tracker from CLAUDE.md instead of re-guessing each run (issue #34).
let snippet = readFileSync(join(scaffold, 'claude-md-snippet.md'), 'utf8')
  .replace('**Tracker: `gh`**', `**Tracker: \`${PLATFORM}\`**`)
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
const MARKER = '## Delivery pipeline — three-agent Architect / Builder / Reviewer'
const claudeMd = join(target, 'CLAUDE.md')
if (!existsSync(claudeMd)) {
  const header = `# ${basename(target)} — Project Constitution\n\n> Auto-loaded into every session. Installed by agent-templates adopt.mjs on ${new Date().toISOString().slice(0, 10)}.\n> Add your project facts and non-negotiable constraints above the pipeline section.\n\n`
  writeFileSync(claudeMd, header + snippet)
  console.log('+ install CLAUDE.md (seeded from the pattern snippet)')
  installed++
} else if (!readFileSync(claudeMd, 'utf8').includes(MARKER)) {
  writeFileSync(claudeMd, readFileSync(claudeMd, 'utf8').trimEnd() + '\n\n' + snippet)
  console.log('+ append  CLAUDE.md (pipeline snippet appended)')
  installed++
} else {
  console.log('= exists  CLAUDE.md (pipeline snippet already present)')
  skipped++
}

// 7. .gitattributes: pin scaffold runtime files to LF. Install-time normalization
// (above) is not enough on Windows — a later `git checkout` with autocrlf re-CRLFs
// them and the Workflow tool rejects the script content (catalog issue #23).
const GA_MARKER = '# agent-templates: Workflow tool rejects CRLF scripts (keep LF)'
const GA_RULES = `${GA_MARKER}\n.claude/workflows/*.js text eol=lf\n.claude/scripts/*.mjs text eol=lf\n`
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

console.log(`\nadopt: ${installed} installed, ${skipped} already present. Pattern: ${pattern}, platform: ${PLATFORM}.`)
console.log(`
NEXT STEPS (details: ${join(CATALOG, 'ADOPTING.md')})
  1. Review CLAUDE.md — set the Operating mode line (start: supervised) and add your
     project facts; fill the Constraint check section of the PR/MR template.
  2. Tracker: git remote + authenticated CLI (${PLATFORM} auth login). Node >= 18 on PATH.
  3. In Claude Code, in the target repo:  /breakdown-prd
     (Architect decomposes docs/PRD.md into sub-PRDs + tickets, then stops for your review)
  4. Gate 1 — review the breakdown, then:  /start-milestone docs/prd/00-<module> supervised
  5. Graduate to autonomous when the pattern holds; optional nightly sweep:
     see the pattern's INSTALL.md § Nightly sweep.`)
