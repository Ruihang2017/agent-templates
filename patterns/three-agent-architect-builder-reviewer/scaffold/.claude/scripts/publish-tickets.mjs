#!/usr/bin/env node
// publish-tickets.mjs — the ONLY sanctioned issue-creation path for the three-agent
// pattern. Agents never hand-create issues (fabrication risk); this script is
// deterministic and idempotent. Adapted from fx-eye-tracking scripts/create-issues.mjs
// (read 2026-07-17), extended with gh support and a machine-readable summary.
//
// Usage:
//   node .claude/scripts/publish-tickets.mjs <module-dir> [--create] [--platform gh|glab]
//
//   <module-dir>   e.g. docs/prd/01-foo — scans <module-dir>/tickets/*.md
//   --create       actually create issues (default: dry-run preview)
//   --platform     tracker CLI; default: autodetect from the origin remote host
//
// Mapping (one issue per ticket file):
//   title  = "[<id>] <title>"            <- the [<id>] prefix is the idempotency key
//   body   = file content minus frontmatter (the ticket FILE stays the content source of truth)
//   labels = module:<module>, size:<size>, agent:<agent> (each only if present)
//
// Idempotency: the existing-issue list is fetched ONCE per run (list endpoints are
// strongly consistent, unlike per-ticket search) and matched client-side by the
// "[<id>]" title prefix. In --create mode a failed fetch aborts BEFORE creating
// anything. Note: the gh path lists up to 1000 issues; beyond that, split modules.
//
// Last line of stdout is machine-readable for /start-milestone:
//   PUBLISH-SUMMARY-JSON: [{"id","path","title","issue","error"?}]
// Exit codes: 0 = ok (invalid tickets are reported in the summary, not fatal);
//             1 = bad invocation, missing CLI in --create mode, fetch failure in
//                 --create mode, or any create failure (summary still printed).

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const CREATE = argv.includes('--create')

const platformIx = argv.indexOf('--platform')
let PLATFORM = ''
if (platformIx !== -1) {
  PLATFORM = argv[platformIx + 1] || ''
  if (!PLATFORM || PLATFORM.startsWith('--')) {
    console.error('missing or invalid --platform value (expected gh or glab)')
    process.exit(1)
  }
}
const moduleDir = argv.find((a, i) => !a.startsWith('--') && (platformIx === -1 || i !== platformIx + 1))

if (!moduleDir) {
  console.error('usage: node publish-tickets.mjs <module-dir> [--create] [--platform gh|glab]')
  process.exit(1)
}
const ticketsDir = join(moduleDir, 'tickets')
let ticketsDirOk = false
try { ticketsDirOk = statSync(ticketsDir).isDirectory() } catch {}
if (!ticketsDirOk) {
  console.error(`no tickets directory: ${ticketsDir}`)
  process.exit(1)
}

const run = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: 'utf8', ...opts })

// GH_BIN / GLAB_BIN env overrides (precedent: fx-eye-tracking's GLAB_BIN) for
// non-PATH binaries and test doubles. The value may include leading args, e.g.
// GH_BIN="node tools/fake-gh.mjs" (no spaces in the path itself).
const cli = (platform, args, opts = {}) => {
  const raw = platform === 'gh' ? process.env.GH_BIN || 'gh' : process.env.GLAB_BIN || 'glab'
  const parts = raw.split(' ')
  return run(parts[0], [...parts.slice(1), ...args], opts)
}

let detectedFrom = ''
if (!PLATFORM) {
  try {
    const origin = run('git', ['remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const host = (origin.match(/(?:@|:\/\/)([^/:]+)[/:]/) || [])[1] || ''
    PLATFORM = /(^|\.)gitlab\./.test(host) || host.includes('gitlab') ? 'glab' : 'gh'
    detectedFrom = host || origin
  } catch {
    PLATFORM = 'gh'
    detectedFrom = 'no origin remote'
  }
}
if (PLATFORM !== 'gh' && PLATFORM !== 'glab') {
  console.error(`unknown platform: ${PLATFORM} (expected gh or glab)`)
  process.exit(1)
}
console.log(`platform: ${PLATFORM}${detectedFrom ? ` (autodetected from ${detectedFrom}; override with --platform)` : ''}`)

let cliOk = false
try {
  cli(PLATFORM, ['auth', 'status'], { stdio: ['ignore', 'ignore', 'ignore'] })
  cliOk = true
} catch {}
if (CREATE && !cliOk) {
  console.error(`x ${PLATFORM} not found or not authenticated — install it and run \`${PLATFORM} auth login\`.`)
  process.exit(1)
}
if (!cliOk) {
  console.log(`(note) ${PLATFORM} unavailable — dry-run previews without checking which issues already exist.`)
}

// Fetch the existing-issue list ONCE; match "[<id>]" prefixes client-side.
// Returns [{number, title}] or null when unavailable.
const fetchExistingIssues = () => {
  if (!cliOk) return null
  try {
    if (PLATFORM === 'gh') {
      const out = cli('gh', ['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,title'])
      return JSON.parse(out).map((i) => ({ number: i.number, title: i.title }))
    }
    try {
      const out = cli('glab', ['issue', 'list', '--all', '--output', 'json'])
      return JSON.parse(out).map((i) => ({ number: i.iid ?? i.id, title: i.title }))
    } catch {
      // older glab without --output json: parse per LINE so the number always
      // belongs to the line whose title matches (never "first #N in the blob")
      const out = cli('glab', ['issue', 'list', '--all'])
      return out
        .split('\n')
        .map((l) => l.match(/^#(\d+)\s+(.*)$/))
        .filter(Boolean)
        .map((m) => ({ number: Number(m[1]), title: m[2] }))
    }
  } catch {
    return null
  }
}

const existingIssues = fetchExistingIssues()
if (CREATE && existingIssues === null) {
  console.error('x could not fetch the existing-issue list — refusing to create without a reliable existence check.')
  process.exit(1)
}
// Returns an issue number, null (not found), or 'ambiguous' (mentions of "[<id>]"
// exist but none is a clean title prefix — creating would risk a duplicate, guessing
// would risk closing the wrong issue later, so the ticket is skipped with an error).
const findExisting = (id) => {
  if (!existingIssues) return null
  const marker = `[${id}]`
  const hits = existingIssues.filter((i) => String(i.title).includes(marker))
  const exact = hits.find((i) => String(i.title).trim().startsWith(marker))
  if (exact) return exact.number
  if (hits.length > 0) return 'ambiguous'
  return null
}

const field = (fm, name) => {
  const m = fm.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'm'))
  if (!m) return ''
  // strip one pair of surrounding YAML quotes (and unescape \" inside them) so
  // quoted titles don't leak quote characters into issue titles
  const v = m[1].trim()
  const stripped = v.replace(/^(['"])(.*)\1$/s, '$2')
  return stripped === v ? v : stripped.replace(/\\"/g, '"')
}

const createIssue = (issueTitle, body, labels) => {
  const attempt = (withLabels) => {
    if (PLATFORM === 'gh') {
      const args = ['issue', 'create', '--title', issueTitle, '--body-file', '-']
      if (withLabels) for (const l of labels) args.push('--label', l)
      return cli('gh', args, { input: body }).trim()
    }
    const args = ['issue', 'create', '--title', issueTitle, '--description', body]
    if (withLabels && labels.length) args.push('--label', labels.join(','))
    return cli('glab', args).trim()
  }
  try {
    return attempt(true)
  } catch (e) {
    if (!labels.length) throw e
    console.error(`  (warn) create with labels failed — retrying without labels (create them in the tracker to keep labeling)`)
    return attempt(false)
  }
}

const summary = []
const seenIds = new Set()
let created = 0
let skipped = 0
let planned = 0
let invalid = 0
let createFailed = 0

for (const f of readdirSync(ticketsDir).filter((n) => n.endsWith('.md')).sort()) {
  const path = join(ticketsDir, f).replaceAll('\\', '/')
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '') // strip BOM (PowerShell 5.1 utf8 writes one)
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!fmMatch) {
    console.log(`  skip (no frontmatter): ${path}`)
    summary.push({ id: null, path, title: null, issue: null, error: 'no-frontmatter' })
    invalid++
    continue
  }
  const fm = fmMatch[1]
  const id = field(fm, 'id')
  const title = field(fm, 'title')
  if (!id || !title) {
    console.log(`  skip (missing id/title): ${path}`)
    summary.push({ id: id || null, path, title: null, issue: null, error: 'missing-id-title' })
    invalid++
    continue
  }
  if (seenIds.has(id)) {
    console.log(`  skip (duplicate id ${id}): ${path}`)
    summary.push({ id, path, title: null, issue: null, error: 'duplicate-id' })
    invalid++
    continue
  }
  seenIds.add(id)

  const issueTitle = `[${id}] ${title}`
  const body = text.slice(fmMatch[0].length).trimStart()
  const labels = [
    field(fm, 'module') && `module:${field(fm, 'module')}`,
    field(fm, 'size') && `size:${field(fm, 'size')}`,
    field(fm, 'agent') && `agent:${field(fm, 'agent')}`,
  ].filter(Boolean)

  const existing = findExisting(id)
  if (existing === 'ambiguous') {
    console.error(`x skip ${id}: issues mention "[${id}]" but none has it as a clean title prefix — resolve by hand`)
    summary.push({ id, path, title: issueTitle, issue: null, error: 'ambiguous-existing' })
    invalid++
    continue
  }
  if (existing) {
    console.log(`= skip ${id}: issue #${existing} already exists`)
    summary.push({ id, path, title: issueTitle, issue: existing })
    skipped++
    continue
  }

  if (!CREATE) {
    console.log(`+ would create ${id}: "${issueTitle}"  labels=[${labels.join(',')}]`)
    summary.push({ id, path, title: issueTitle, issue: null })
    planned++
    continue
  }

  try {
    const out = createIssue(issueTitle, body, labels)
    const lastLine = out.split('\n').filter(Boolean).pop() || ''
    const num = (lastLine.match(/\/issues\/(\d+)\s*$/) || out.match(/#(\d+)/) || [])[1]
    console.log(`+ created ${id}: ${lastLine}`)
    summary.push({ id, path, title: issueTitle, issue: num ? Number(num) : null })
    created++
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).split('\n')[0]
    console.error(`x create failed for ${id}: ${msg}`)
    summary.push({ id, path, title: issueTitle, issue: null, error: `create-failed: ${msg}` })
    createFailed++
  }
}

const invalidNote = invalid ? `, invalid: ${invalid}` : ''
console.log(
  CREATE
    ? `CREATED: ${created}, already existed: ${skipped}, failed: ${createFailed}${invalidNote}.`
    : `DRY-RUN: ${planned} would be created, ${skipped} already exist${invalidNote}. Re-run with --create after Gate 1 sign-off.`
)
console.log('PUBLISH-SUMMARY-JSON: ' + JSON.stringify(summary))
process.exit(createFailed ? 1 : 0)
