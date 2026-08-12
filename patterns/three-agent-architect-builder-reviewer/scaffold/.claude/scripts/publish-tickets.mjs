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
// strongly consistent, unlike per-ticket search), PAGINATED IN FULL, sorted ascending,
// and matched client-side by the "[<id>]" title prefix, resolving to the OLDEST match.
// In --create mode a failed fetch aborts BEFORE creating anything, and so does a tracker
// that already contains duplicates.
//
// Every truncation path throws instead of returning a short list (catalog issue #132):
// a truncated list is indistinguishable from "these tickets were never published", and
// acting on that difference created 43 duplicate issues on a 44-ticket repo in the field.
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
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// maxBuffer: execFileSync defaults to 1 MB. The pre-#132 code only ever read 30 issues,
// which fit by luck; a real paginated fetch blows ENOBUFS, and that throw used to be
// swallowed into the text fallback — so the buffer limit was itself a duplicate trigger.
const run = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts })

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
// Returns [{number, title, state, body}] sorted ASCENDING by number, or null when
// unavailable. `state`/`body` come from the SAME list call — no extra round-trip per
// ticket.
//
// PAGINATION IS LOAD-BEARING (catalog issue #132, field report 2026-08-04). The GitLab
// branch used to be a single `glab issue list --all --output json`. `--all` is a STATE
// filter, not a pagination flag — verified against glab 1.108.0: `-P --per-page` defaults
// to 30. So the dedup oracle saw 30 issues and everything beyond that read as "never
// published" and was created again. Self-reinforcing: each duplicate pushed a real issue
// further out of the window. On the reporting repo — 44 tickets, 44 issues — one
// `--create` produced 43 duplicates with no warning.
//
// Everything below therefore fails LOUDLY instead of returning a short list. A truncated
// list is indistinguishable from "these tickets were never published", and acting on that
// difference is the whole bug.
const normState = (s) => (String(s || '').toLowerCase().includes('close') ? 'closed' : String(s || '') ? 'open' : '')
// Ascending by number so findExisting resolves to the OLDEST match. `gh issue list`
// returns newest-first, so without this the gh branch silently tracked the NEWEST issue
// for a ticket — which breaks every dedup rule here, all of which assume the original wins.
const byNumberAsc = (list) => list.slice().sort((a, b) => Number(a.number) - Number(b.number))

const PER_PAGE = 100
const MAX_PAGES = 100 // 10k issues; a cap that THROWS, never truncates
const GH_LIMIT = 2000

const fetchExistingIssues = () => {
  if (!cliOk) return null
  try {
    if (PLATFORM === 'gh') {
      // gh's --limit auto-paginates, so one call suffices — but hitting the cap exactly
      // is indistinguishable from "there were more", so refuse rather than dedupe against
      // a possibly-truncated list.
      const out = cli('gh', ['issue', 'list', '--state', 'all', '--limit', String(GH_LIMIT), '--json', 'number,title,state,body'])
      const arr = JSON.parse(out)
      if (arr.length >= GH_LIMIT) {
        throw new Error(`gh returned ${arr.length} issues, the --limit cap — cannot tell whether more exist. Raise GH_LIMIT in this script.`)
      }
      return byNumberAsc(arr.map((i) => ({ number: i.number, title: i.title, state: normState(i.state), body: i.body || '' })))
    }

    const all = []
    const seen = new Set()
    for (let page = 1; page <= MAX_PAGES; page++) {
      const out = cli('glab', ['issue', 'list', '--all', '--output', 'json', '--per-page', String(PER_PAGE), '--page', String(page)])
      const arr = JSON.parse(out)
      if (!Array.isArray(arr)) throw new Error('glab issue list --output json did not return an array')
      let fresh = 0
      for (const i of arr) {
        const number = i.iid ?? i.id
        if (seen.has(number)) continue
        seen.add(number)
        fresh++
        all.push({ number, title: i.title, state: normState(i.state), body: i.description || '' })
      }
      if (arr.length < PER_PAGE) break // short page = last page
      // A FULL page that added nothing new means --page was not honoured and we are
      // re-reading page 1. Looping would spin; returning would silently truncate. Both
      // are the original bug, so throw.
      if (fresh === 0) {
        throw new Error(`glab returned a full page ${page} with no new issues — --page appears to be ignored, so the list cannot be trusted. Check \`glab --version\`.`)
      }
      if (page === MAX_PAGES) {
        throw new Error(`more than ${MAX_PAGES * PER_PAGE} issues — raise MAX_PAGES in this script rather than deduping against a truncated list.`)
      }
    }
    return byNumberAsc(all)
  } catch (e) {
    // No text-parsing fallback any more (issue #132). It inherited the same 30-item
    // window and returned no state/body, so it could only ever degrade into duplicates
    // while silently disabling drift detection — a liability wearing a safety net's
    // clothes. A failed fetch says so and lets --create refuse.
    console.error(`  (warn) could not fetch the existing-issue list: ${String(e && e.message ? e.message : e).split('\n')[0]}`)
    return null
  }
}

const existingIssues = fetchExistingIssues()
if (CREATE && existingIssues === null) {
  console.error('x could not fetch the existing-issue list — refusing to create without a reliable existence check.')
  process.exit(1)
}

// Pre-create guard (issue #132): refuse to run against a tracker that ALREADY has
// duplicates, because dedup silently picks one and the run makes the mess worse.
// State-aware, so a tracker that was already repaired still passes:
//   1 issue                      -> ok
//   oldest open, rest closed     -> ok  (duplicates were closed; the original still lives)
//   all closed                   -> ok  (delivered)
//   >=2 open                     -> FAIL (ambiguous; a human picks)
//   oldest closed, a newer open  -> FAIL (dedup selects the closed one and orphans the open one)
//   state not reported           -> FAIL closed; never guess
const auditDuplicates = (issues) => {
  const byId = new Map()
  for (const i of issues) {
    const m = String(i.title).match(/^\s*\[([^\]]+)\]/)
    if (!m) continue
    if (!byId.has(m[1])) byId.set(m[1], [])
    byId.get(m[1]).push(i)
  }
  const bad = []
  for (const [id, group] of byId) {
    if (group.length < 2) continue
    const sorted = group.slice().sort((a, b) => Number(a.number) - Number(b.number))
    const nums = sorted.map((i) => '#' + i.number).join(', ')
    if (sorted.some((i) => i.state === '')) {
      bad.push(`${id}: ${group.length} issues (${nums}) and the tracker did not report state — cannot verify which is canonical`)
      continue
    }
    const open = sorted.filter((i) => i.state === 'open')
    if (open.length >= 2) {
      bad.push(`${id}: ${open.length} OPEN issues (${open.map((i) => '#' + i.number).join(', ')}) — close all but the oldest`)
      continue
    }
    if (open.length === 1 && open[0].number !== sorted[0].number) {
      bad.push(`${id}: oldest #${sorted[0].number} is closed but #${open[0].number} is open — dedup would resolve to the closed one and orphan the open one`)
    }
  }
  return bad
}

if (CREATE && existingIssues) {
  const dupes = auditDuplicates(existingIssues)
  if (dupes.length) {
    console.error('x refusing to create: the tracker already has duplicate issues for these ticket ids.')
    for (const d of dupes) console.error(`  - ${d}`)
    console.error('  Resolve them in the tracker (keep the OLDEST, close the rest), then re-run. See catalog issue #132.')
    console.log('PUBLISH-SUMMARY-JSON: ' + JSON.stringify([{ id: null, path: null, title: null, issue: null, error: 'duplicate-issues-present', detail: dupes }]))
    process.exit(1)
  }
}

// id -> issue number, seeded from existing issues' "[<id>]" title prefix and grown as we
// create this run — so the dependency line resolves ticket ids to real issue #numbers.
const idToNum = new Map()
for (const i of existingIssues || []) {
  const m = String(i.title).match(/^\[([^\]]+)\]/)
  if (m) idToNum.set(m[1], i.number)
}
// `existingIssues` is sorted ascending, so `.find()` below returns the OLDEST match —
// the original. Every rule here depends on that: a repaired tracker keeps the oldest
// open and closes the duplicates, so resolving to a newer one would track a closed issue.
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

// ---------------------------------------------------------------------------
// GitLab issue writes go through `glab api`, not `glab issue create/update`.
//
// TWO defects are fixed by construction here, both field-reported 2026-08-04 (#134):
//
// 1. THE BODY MUST NOT TRAVEL THROUGH ARGV. `glab issue create` exposes only
//    `-d/--description`, whose value is a command-line argument. Windows caps a command
//    line at 32,767 characters, so a 40 KB ticket failed with ENAMETOOLONG and never
//    published. There is no `--description-file`, and `-d -` opens an editor, which is
//    unusable headless — verified against glab 1.108.0. `glab api` does have a file
//    field: `--field description=@<path>` reads the value from a file (`@-` reads stdin),
//    so the body never becomes an argument at any length.
//
// 2. THE ISSUE NUMBER IS READ, NOT PARSED. The old code scraped the created issue's URL
//    and fell back to `#(\d+)` anywhere in the output. GitLab now returns
//    `/-/work_items/N` on some versions, so the first pattern missed and the fallback
//    matched any `#digits` in the output — binding the ticket to the WRONG issue, which
//    is worse than failing. The API returns `iid` as a field; there is nothing to parse.
//
// `:fullpath` is glab's placeholder for the current project, so this stays repo-relative
// exactly like the CLI form it replaces.
// ---------------------------------------------------------------------------

/** Write `body` to a temp file and hand its path to a callback, always cleaning up. */
const withBodyFile = (body, fn) => {
  const path = join(tmpdir(), `pt-body-${process.pid}-${bodySeq++}.md`)
  writeFileSync(path, body)
  try { return fn(path) } finally { try { unlinkSync(path) } catch {} }
}
let bodySeq = 0

/**
 * Read an issue number out of a forge response.
 *
 * Kept for the gh path and as a defensive fallback. Deliberately anchored and ordered:
 * `iid` from JSON first, then a URL in either the legacy `/-/issues/N` or the newer
 * `/-/work_items/N` form. The old loose `#(\d+)` fallback is GONE — it could match a
 * number mentioned anywhere in the output and silently bind a ticket to the wrong issue.
 * Failing to find a number is recoverable (a later --sync backfills it); binding the
 * wrong one is not.
 */
const readIssueNumber = (out) => {
  const text = String(out || '')
  try {
    const j = JSON.parse(text)
    if (j && Number.isInteger(j.iid)) return j.iid
    if (j && Number.isInteger(j.number)) return j.number
  } catch { /* not JSON — fall through to URL forms */ }
  // The trailing guard is `(?!\d)`, not "end of string or whitespace": a URL embedded in
  // a JSON body is followed by a quote, and requiring whitespace silently matched nothing
  // there. What makes this safe is the anchor on the URL PATH — `/-/issues/N` or
  // `/-/work_items/N` — not the character after the digits.
  const m = text.match(/\/-?\/?(?:issues|work_items)\/(\d+)(?!\d)/)
  return m ? Number(m[1]) : null
}

const updateBody = (num, body) => {
  if (PLATFORM === 'gh') return cli('gh', ['issue', 'edit', String(num), '--body-file', '-'], { input: body }).trim()
  return withBodyFile(body, (p) => cli('glab', [
    'api', `projects/:fullpath/issues/${num}`, '-X', 'PUT', '--field', `description=@${p}`,
  ]).trim())
}

const createIssue = (issueTitle, body, labels) => {
  const attempt = (withLabels) => {
    if (PLATFORM === 'gh') {
      const args = ['issue', 'create', '--title', issueTitle, '--body-file', '-']
      if (withLabels) for (const l of labels) args.push('--label', l)
      return cli('gh', args, { input: body }).trim()
    }
    return withBodyFile(body, (p) => {
      const args = ['api', 'projects/:fullpath/issues', '-X', 'POST',
        '--field', `title=${issueTitle}`, '--field', `description=@${p}`]
      if (withLabels && labels.length) args.push('--field', `labels=${labels.join(',')}`)
      return cli('glab', args).trim()
    })
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
  // strip BOM (PowerShell 5.1 utf8 writes one) AND any HTML comment preceding the
  // frontmatter (catalog issue #185): the shipped ticket template opens with one, so a
  // ticket written literally from it parsed as having no frontmatter and was skipped here.
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/^(?:s*<!--[sS]*?-->s*)*/, '')
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
    const num = readIssueNumber(out)
    // The JSON body is not a useful log line; report the number we bound, or say plainly
    // that we could not bind one. A later --sync backfills a missing number; a WRONG
    // number is unrecoverable, which is why readIssueNumber has no loose fallback.
    console.log(num ? `+ created ${id}: issue #${num}` : `+ created ${id}: (issue number not reported — re-run with --sync to backfill)`)
    summary.push({ id, path, title: issueTitle, issue: num, state: 'open' })
    if (num) idToNum.set(id, num) // so a later same-run ticket's dep line resolves
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
