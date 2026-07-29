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
//   --sync         with --create, also regenerate EXISTING issue bodies from their ticket
//                  (backfills the dependency line onto historical issues, and is the
//                  "ticket changed -> update the issue" step: edit the ticket via a docs
//                  PR, re-run with --sync, then execute — issue #53's ticket-is-source rule)
//   --platform     tracker CLI; default: autodetect from the origin remote host
//
// Mapping (one issue per ticket file):
//   title  = "[<id>] <title>"            <- the [<id>] prefix is the idempotency key
//   body   = a dependency line (Blocked by #N · Blocks #M, resolved to issue NUMBERS so
//            the DAG is visible on the board — issue #52) + the ticket content minus
//            frontmatter (the ticket FILE stays the content source of truth)
//   labels = module:<module>, size:<size>, agent:<agent> (each only if present)
//
// Idempotency: the existing-issue list is fetched ONCE per run (list endpoints are
// strongly consistent, unlike per-ticket search) and matched client-side by the
// "[<id>]" title prefix. In --create mode a failed fetch aborts BEFORE creating
// anything. Note: the gh path lists up to 1000 issues; beyond that, split modules.
//
// Last line of stdout is machine-readable for /start-milestone:
//   PUBLISH-SUMMARY-JSON: [{"id","path","title","issue","state"?,"drift"?,"error"?}]
//
// `state` ("open"/"closed") and `drift` exist to close a silent-skip hole (issue #112).
// /start-all drops tickets whose issue is CLOSED — that is the resume filter, and it is
// what makes a re-run after Gate 2 execute only the new phase. But it also means editing
// an already-delivered ticket and re-running does NOTHING, and said nothing, because the
// filter never reported what it dropped. So the state comes back in the summary, and a
// closed issue whose body no longer matches its ticket is flagged `drift: true` for the
// caller to ESCALATE. Two readings, both a human's call, neither the scheduler's:
// the ticket was edited after delivery, or the issue predates a body-format change
// (`--sync` refreshes that one). Silently swallowing either is this repo's recurring
// failure class — a gate on correctness with none on delivery.
// Exit codes: 0 = ok (invalid tickets are reported in the summary, not fatal);
//             1 = bad invocation, missing CLI in --create mode, fetch failure in
//                 --create mode, or any create failure (summary still printed).

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const CREATE = argv.includes('--create')
const SYNC = argv.includes('--sync') // also regenerate existing issue bodies from their ticket

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
// Returns [{number, title, state, body}] or null when unavailable. `state`/`body` come
// from the SAME list call — no extra round-trip per ticket — and are absent-tolerant:
// an older CLI that omits them yields '' and simply disables drift detection rather
// than reporting false drift on every ticket.
const normState = (s) => (String(s || '').toLowerCase().includes('close') ? 'closed' : String(s || '') ? 'open' : '')
const fetchExistingIssues = () => {
  if (!cliOk) return null
  try {
    if (PLATFORM === 'gh') {
      const out = cli('gh', ['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,title,state,body'])
      return JSON.parse(out).map((i) => ({ number: i.number, title: i.title, state: normState(i.state), body: i.body || '' }))
    }
    try {
      const out = cli('glab', ['issue', 'list', '--all', '--output', 'json'])
      return JSON.parse(out).map((i) => ({
        number: i.iid ?? i.id,
        title: i.title,
        state: normState(i.state),
        body: i.description || '',
      }))
    } catch {
      // older glab without --output json: parse per LINE so the number always
      // belongs to the line whose title matches (never "first #N in the blob").
      // No state/body available here — drift detection degrades off, it does not lie.
      const out = cli('glab', ['issue', 'list', '--all'])
      return out
        .split('\n')
        .map((l) => l.match(/^#(\d+)\s+(.*)$/))
        .filter(Boolean)
        .map((m) => ({ number: Number(m[1]), title: m[2], state: '', body: '' }))
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

// id -> issue number, seeded from existing issues' "[<id>]" title prefix and grown as we
// create this run — so the dependency line resolves ticket ids to real issue #numbers.
const idToNum = new Map()
for (const i of existingIssues || []) {
  const m = String(i.title).match(/^\[([^\]]+)\]/)
  if (m) idToNum.set(m[1], i.number)
}
// Returns the issue RECORD ({number,title,state,body}), null (not found), or 'ambiguous'
// (mentions of "[<id>]" exist but none is a clean title prefix — creating would risk a
// duplicate, guessing would risk closing the wrong issue later, so the ticket is skipped
// with an error). The record rather than the bare number, so state and body are
// available for the resume filter and drift detection without a second lookup.
const findExisting = (id) => {
  if (!existingIssues) return null
  const marker = `[${id}]`
  const hits = existingIssues.filter((i) => String(i.title).includes(marker))
  const exact = hits.find((i) => String(i.title).trim().startsWith(marker))
  if (exact) return exact
  if (hits.length > 0) return 'ambiguous'
  return null
}

// Compare a rendered body against what the tracker holds. Normalized for line endings
// and trailing whitespace only — the tracker round-trips CRLF and trims, and treating
// that as an edit would flag every ticket.
const bodyDiffers = (rendered, stored) => {
  const norm = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
  return norm(rendered) !== norm(stored)
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

const listField = (fm, name) =>
  field(fm, name).replace(/^\[/, '').replace(/\]$/, '').split(',').map((s) => s.trim()).filter(Boolean)

// The dependency line rendered at the top of the issue body — resolved to issue NUMBERS
// (issue #52: the DAG must be visible to a human on the board, not just to milestone-dag).
// A dep not yet published resolves to `id` (pending); a later --sync backfills it.
const renderDeps = (blockedBy, blocks) => {
  const ref = (id) => (idToNum.has(id) ? '#' + idToNum.get(id) : '`' + id + '` (pending)')
  const parts = []
  if (blockedBy.length) parts.push('**Blocked by:** ' + blockedBy.map(ref).join(', '))
  if (blocks.length) parts.push('**Blocks:** ' + blocks.map(ref).join(', '))
  if (!parts.length) return ''
  return '> ' + parts.join(' · ') + '\n>\n> _dependency graph — auto-rendered from the ticket frontmatter (issue #52)_\n\n'
}

const updateBody = (num, body) => {
  if (PLATFORM === 'gh') return cli('gh', ['issue', 'edit', String(num), '--body-file', '-'], { input: body }).trim()
  return cli('glab', ['issue', 'update', String(num), '--description', body]).trim()
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
let synced = 0
let planned = 0
let invalid = 0
let createFailed = 0
let driftedClosed = 0

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
  const fullBody = renderDeps(listField(fm, 'blocked_by'), listField(fm, 'blocks')) + body
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
    const num = existing.number
    const state = existing.state || ''
    if (CREATE && SYNC) {
      try {
        updateBody(num, fullBody)
        console.log(`~ synced ${id}: issue #${num} body regenerated from the ticket`)
        summary.push({ id, path, title: issueTitle, issue: num, state, synced: true })
        synced++
      } catch (e) {
        console.error(`  (warn) sync failed for ${id} (#${num}): ${String(e && e.message ? e.message : e).split('\n')[0]}`)
        summary.push({ id, path, title: issueTitle, issue: num, state, error: 'sync-failed' })
      }
      continue
    }
    // A CLOSED issue means /start-all's resume filter will DROP this ticket. If the
    // ticket text no longer matches what was delivered, dropping it silently is the
    // bug (#112) — flag it so the caller escalates instead. Only when a body is
    // actually available; a CLI that cannot report one must not manufacture drift.
    const drifted = state === 'closed' && existing.body !== '' && bodyDiffers(fullBody, existing.body)
    if (drifted) {
      driftedClosed++
      console.error(
        `! ${id}: issue #${num} is CLOSED but its body no longer matches the ticket — /start-all will SKIP this ticket. ` +
          `Either it was edited after delivery (a human decides whether to re-run it) or the issue predates a body-format change (re-run with --sync).`
      )
    }
    console.log(`= skip ${id}: issue #${num} already exists${state ? ` (${state})` : ''}${SYNC ? ' (dry-run: would --sync its body)' : ''}`)
    summary.push({ id, path, title: issueTitle, issue: num, state, ...(drifted ? { drift: true } : {}) })
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
    const out = createIssue(issueTitle, fullBody, labels)
    const lastLine = out.split('\n').filter(Boolean).pop() || ''
    const num = (lastLine.match(/\/issues\/(\d+)\s*$/) || out.match(/#(\d+)/) || [])[1]
    console.log(`+ created ${id}: ${lastLine}`)
    summary.push({ id, path, title: issueTitle, issue: num ? Number(num) : null, state: 'open' })
    if (num) idToNum.set(id, Number(num)) // so a later same-run ticket's dep line resolves
    created++
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).split('\n')[0]
    console.error(`x create failed for ${id}: ${msg}`)
    summary.push({ id, path, title: issueTitle, issue: null, error: `create-failed: ${msg}` })
    createFailed++
  }
}

const invalidNote = invalid ? `, invalid: ${invalid}` : ''
const syncNote = synced ? `, synced: ${synced}` : ''
const driftNote = driftedClosed ? `, DRIFTED-CLOSED: ${driftedClosed} (escalate — see above)` : ''
console.log(
  CREATE
    ? `CREATED: ${created}, already existed: ${skipped}, failed: ${createFailed}${syncNote}${invalidNote}${driftNote}.`
    : `DRY-RUN: ${planned} would be created, ${skipped} already exist${invalidNote}${driftNote}. Re-run with --create after Gate 1 sign-off.`
)
console.log('PUBLISH-SUMMARY-JSON: ' + JSON.stringify(summary))
process.exit(createFailed ? 1 : 0)
