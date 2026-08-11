#!/usr/bin/env node
// asana-sync.mjs — the ONLY sanctioned Asana write path. Deterministic, idempotent,
// and FAIL-SOFT: Asana is a reporting mirror of the pipeline, never a gate on it.
// Sibling of publish-tickets.mjs and deliver-ticket.mjs, deliberately the same shape.
//
// Usage:
//   node .claude/scripts/asana-sync.mjs check
//   node .claude/scripts/asana-sync.mjs resolve   --url <asana-task-url>
//   node .claude/scripts/asana-sync.mjs configure --url <asana-task-url> [--project <gid>] [--force]
//   node .claude/scripts/asana-sync.mjs sync <module-dir> [--create] [--issues <file|->]
//   node .claude/scripts/asana-sync.mjs complete <ticket-id> [--create]
//   node .claude/scripts/asana-sync.mjs status [<module-dir>]
//
//   check      validate config + token and resolve the repo task; writes nothing
//   resolve    parse an Asana task URL, fetch the task, report name + workspace gid
//              (used by /connect-asana; the ONLY step that reads a URL)
//   configure  resolve, then WRITE .claude/asana.json. The config write lives here, not in
//              the command, because the pattern's PreToolUse guard denies main-session
//              Edit/Write — a deterministic script is the sanctioned path, and it also
//              guarantees the token can never be serialized into the file.
//   sync       ensure the module subtask and its ticket sub-subtasks exist
//   complete   mark one ticket's sub-subtask completed
//   status     report what exists vs what the tickets say; writes nothing
//   --create   actually write (default for sync/complete: dry-run preview)
//   --issues   PUBLISH-SUMMARY-JSON (file path, or - for stdin) so subtask names can
//              carry the tracker issue number as a human cross-reference
//
// Hierarchy (maintainer decision, 2026-07-30 — issue #124):
//   repo              -> an EXISTING Asana task            (config.repoTask; never created here)
//   milestone/module  -> subtask of the repo task          "[<module>] <title>"
//   ticket/issue      -> subtask of the module subtask     "[<id>] <title> · #<issue>"
// Asana allows 5 levels of subtask nesting, so 3 levels fit:
//   https://help.asana.com/s/article/subtasks
// ACCEPTED COST, recorded so nobody rediscovers it: an Asana subtask does not belong to
// its parent's project, so tickets at this depth do NOT appear in List / Board / Timeline /
// Reporting views. Set `addTicketsToProject` to a project gid to make them visible without
// changing the hierarchy.
//
// Idempotency key = the "[<id>]" NAME PREFIX, matched client-side after LISTING subtasks.
// Not Asana search, and not a gid written back into ticket files. Search is unusable here:
// premium-only, 10-60s index lag with the docs stating it is "not suited for use cases that
// require immediate consistency after writes", unstable result ordering, and a separate
// 60 req/min cap — create-then-find inside one run is precisely the unsupported case.
//   https://developers.asana.com/reference/searchtasksforworkspace
// Subtask LIST endpoints are strongly consistent, so the script walks
// repoTask -> module subtasks -> ticket subtasks. Same reasoning publish-tickets.mjs
// already documents for the tracker. Cost: 1 + N requests for N modules.
// The issue number goes in the name for humans; nothing keys on it.
//
// API (verified against live docs 2026-07-30, not from memory):
//   auth            Authorization: Bearer <PAT>   https://developers.asana.com/docs/personal-access-token
//   get task        GET  /tasks/{gid}             https://developers.asana.com/reference/gettask
//   list subtasks   GET  /tasks/{gid}/subtasks    https://developers.asana.com/reference/getsubtasksfortask
//   create subtask  POST /tasks/{gid}/subtasks    https://developers.asana.com/reference/createsubtaskfortask
//   update task     PUT  /tasks/{gid}             https://developers.asana.com/reference/updatetask
//   rate limits     429 + Retry-After; rejected requests still count against quota
//                                                 https://developers.asana.com/docs/rate-limits
//
// Token: ASANA_TOKEN env var ONLY. Never a CLI argument (argv leaks into process lists and
// shell history) and never written to .claude/asana.json. A PAT acts as the whole user.
// ASANA_API_BASE overrides the API root for tests (precedent: GH_BIN/GLAB_BIN test doubles).
//
// Last line of stdout is machine-readable for the pipeline:
//   ASANA-SYNC-JSON: {"verb","configured","ok","repoTask"?,"module"?,"items":[...],"errors":[...]}
//
// EXIT CODES — the whole fail-soft contract in one rule:
//   1 = the CALLER invoked this wrong (unknown verb, missing argument). A bug to fix.
//   0 = everything else, INCLUDING every Asana failure: no config, no token, HTTP 500,
//       rate-limited past retries, a missing parent task. Reported in `errors`.
// Rationale: `dodPassed` gates on issueClosed, and /start-all runs unattended for 47-104
// minutes. An expired Asana token must never fail a delivered ticket. Callers are required
// to relay `errors` into their escalations — silent is the one thing this must not be
// (§4 "Silent delivery drop": verify the side effect, but do not let the mirror block work).

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const VERB = argv[0] || ''
const CREATE = argv.includes('--create')
const FORCE = argv.includes('--force')
const flag = (name) => {
  const i = argv.indexOf(name)
  if (i === -1) return ''
  const v = argv[i + 1]
  return !v || v.startsWith('--') ? '' : v
}
const positional = (n) => {
  const out = []
  const skip = new Set()
  for (const name of ['--url', '--issues', '--project']) {
    const i = argv.indexOf(name)
    if (i !== -1) { skip.add(i); skip.add(i + 1) }
  }
  argv.forEach((a, i) => { if (i > 0 && !a.startsWith('--') && !skip.has(i)) out.push(a) })
  return out[n]
}

const USAGE = `usage:
  asana-sync.mjs check
  asana-sync.mjs resolve   --url <asana-task-url>
  asana-sync.mjs configure --url <asana-task-url> [--project <gid>] [--force]
  asana-sync.mjs sync <module-dir> [--create] [--issues <file|->]
  asana-sync.mjs complete <ticket-id> [--create]
  asana-sync.mjs status [<module-dir>]`

if (!['check', 'resolve', 'configure', 'sync', 'complete', 'status'].includes(VERB)) {
  console.error(USAGE)
  process.exit(1)
}

const API_BASE = (process.env.ASANA_API_BASE || 'https://app.asana.com/api/1.0').replace(/\/+$/, '')
const TOKEN = process.env.ASANA_TOKEN || ''
const CONFIG_PATH = join('.claude', 'asana.json')

// ---------------------------------------------------------------------------
// summary / fail-soft plumbing
// ---------------------------------------------------------------------------

const summary = { verb: VERB, configured: false, ok: false, items: [], errors: [] }
const fail = (code, message, extra = {}) => {
  summary.errors.push({ code, message, ...extra })
  console.error(`x ${code}: ${message}`)
}
// Every exit goes through here so the JSON line is never missed on an error path.
const finish = () => {
  summary.ok = summary.errors.length === 0
  console.log('ASANA-SYNC-JSON: ' + JSON.stringify(summary))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const loadConfig = () => {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')
    const cfg = JSON.parse(raw)
    if (!cfg || typeof cfg !== 'object' || !cfg.repoTask) return { __invalid: 'missing repoTask' }
    return cfg
  } catch (e) {
    return { __invalid: String(e && e.message ? e.message : e).split('\n')[0] }
  }
}

// ---------------------------------------------------------------------------
// HTTP — one helper, 429/5xx aware
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Retry-After is honored because the docs warn that rejected requests still count
// against the quota, so retrying early makes recovery worse. Capped so a hostile or
// broken header cannot hang an unattended run; overridable for tests.
const MAX_SLEEP_MS = Number(process.env.ASANA_MAX_RETRY_SLEEP_MS || 30000)
const MAX_ATTEMPTS = Number(process.env.ASANA_MAX_ATTEMPTS || 3)

let requestCount = 0

// `opts.envelope` returns the WHOLE response object rather than just `.data`. Paginated
// reads need `next_page`, and the default shape discards it — which is how a truncated
// subtask list read as a complete one (issue #176).
const api = async (method, path, body, opts = {}) => {
  let lastErr = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    requestCount++
    let res
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify({ data: body }) } : {}),
      })
    } catch (e) {
      lastErr = `network: ${String(e && e.message ? e.message : e).split('\n')[0]}`
      if (attempt < MAX_ATTEMPTS) { await sleep(Math.min(250 * attempt, MAX_SLEEP_MS)); continue }
      throw new Error(lastErr)
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'))
      lastErr = `http ${res.status}`
      if (attempt < MAX_ATTEMPTS) {
        const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 250 * attempt
        await sleep(Math.min(waitMs, MAX_SLEEP_MS))
        continue
      }
      throw new Error(`${lastErr} after ${MAX_ATTEMPTS} attempts`)
    }

    const text = await res.text()
    if (!res.ok) {
      // Asana errors come back as {errors:[{message}]}; fall back to the raw body.
      let detail = text.slice(0, 300)
      try {
        const j = JSON.parse(text)
        if (j && Array.isArray(j.errors) && j.errors[0] && j.errors[0].message) detail = j.errors[0].message
      } catch {}
      throw new Error(`http ${res.status}: ${detail}`)
    }
    if (!text) return opts.envelope ? { data: [] } : {}
    try {
      const parsed = JSON.parse(text)
      return opts.envelope ? parsed : parsed.data
    } catch {
      throw new Error('unparseable response body')
    }
  }
  throw new Error(lastErr || 'request failed')
}

const getTask = (gid) => api('GET', `/tasks/${encodeURIComponent(gid)}?opt_fields=name,completed,workspace,parent`)

// ---------------------------------------------------------------------------
// PAGINATION IS LOAD-BEARING (catalog issue #176).
//
// `api()` returns `.data` and drops the response envelope, and `listSubtasks` asked for
// `limit=100` and stopped there. Asana caps a page at 100, so a parent with more than 100
// subtasks returned a TRUNCATED list — and every caller treats "not in the list" as "does
// not exist yet" and CREATES it. That is precisely catalog issue #132, which produced 43
// duplicate issues on a 44-ticket repo, arriving through a different API.
//
// It is also self-reinforcing in the same way: each duplicate consumes a slot in the
// window, pushing a real subtask further out of view on the next run.
//
// So this follows #132's rule rather than inventing a new one: NEVER return a short list.
// Every failure path throws, because a truncated list is indistinguishable from "these
// were never created", and acting on that difference is the entire bug.
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 100 // Asana's documented maximum
const MAX_PAGES = Number(process.env.ASANA_MAX_PAGES || 200) // 20k subtasks; a runaway guard, not a real ceiling

/** GET one page and return the FULL envelope, so `next_page` survives. */
const apiPage = async (path) => {
  const env = await api('GET', path, undefined, { envelope: true })
  return { data: Array.isArray(env.data) ? env.data : [], nextPage: env.next_page || null }
}

const listSubtasks = async (gid) => {
  const base = `/tasks/${encodeURIComponent(gid)}/subtasks?opt_fields=name,completed&limit=${PAGE_LIMIT}`
  const out = []
  const seen = new Set()
  let path = base
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) {
      throw new Error(`subtask list for ${gid} exceeded ${MAX_PAGES} pages — refusing to continue with a partial list`)
    }
    const { data, nextPage } = await apiPage(path)
    let fresh = 0
    for (const t of data) {
      if (!t || !t.gid || seen.has(t.gid)) continue
      seen.add(t.gid)
      out.push(t)
      fresh++
    }
    if (!nextPage || !nextPage.offset) {
      // A FULL page with no continuation token is ambiguous — it is exactly what a server
      // that ignores pagination looks like, and also what a parent with exactly `limit`
      // subtasks looks like. Asana documents `next_page` as present whenever more results
      // exist, so treat its absence on a full page as the server not paginating and fail
      // rather than silently returning a possibly-truncated list.
      if (data.length >= PAGE_LIMIT) {
        throw new Error(`subtask list for ${gid} returned a full page (${data.length}) with no next_page — cannot tell a complete list from a truncated one, refusing to guess`)
      }
      break
    }
    if (fresh === 0) {
      // The server handed back a continuation token but no new rows: following it would
      // loop forever. Loud, because the alternative is an unattended run that never ends.
      throw new Error(`subtask list for ${gid} advanced a page with no new subtasks — offset appears to be ignored, refusing to loop`)
    }
    path = `${base}&offset=${encodeURIComponent(nextPage.offset)}`
  }
  return out
}
const createSubtask = (parentGid, fields) => api('POST', `/tasks/${encodeURIComponent(parentGid)}/subtasks`, fields)
const updateTask = (gid, fields) => api('PUT', `/tasks/${encodeURIComponent(gid)}`, fields)
const addToProject = (gid, projectGid) => api('POST', `/tasks/${encodeURIComponent(gid)}/addProject`, { project: projectGid })

// ---------------------------------------------------------------------------
// ticket reading — frontmatter only, same field parser as publish-tickets.mjs
// ---------------------------------------------------------------------------

const field = (fm, name) => {
  const m = fm.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'm'))
  if (!m) return ''
  const v = m[1].trim()
  const stripped = v.replace(/^(['"])(.*)\1$/s, '$2')
  return stripped === v ? v : stripped.replace(/\\"/g, '"')
}

const readTickets = (moduleDir) => {
  const ticketsDir = join(moduleDir, 'tickets')
  let ok = false
  try { ok = statSync(ticketsDir).isDirectory() } catch {}
  if (!ok) return null
  const out = []
  for (const f of readdirSync(ticketsDir).filter((n) => n.endsWith('.md')).sort()) {
    const path = join(ticketsDir, f).replaceAll('\\', '/')
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '')
    const fm = (text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/) || [])[1]
    if (!fm) continue
    const id = field(fm, 'id')
    const title = field(fm, 'title')
    if (!id || !title) continue
    out.push({ id, title, path })
  }
  return out
}

// Module display title: the sub-PRD's first H1 if there is one, else the directory name.
const moduleTitle = (moduleDir) => {
  const readme = join(moduleDir, 'README.md')
  try {
    const h1 = readFileSync(readme, 'utf8').match(/^#\s+(.+)$/m)
    if (h1) return h1[1].trim()
  } catch {}
  return moduleDir.replaceAll('\\', '/').split('/').filter(Boolean).pop() || moduleDir
}
const moduleKey = (moduleDir) => moduleDir.replaceAll('\\', '/').split('/').filter(Boolean).pop() || moduleDir

// ---------------------------------------------------------------------------
// naming — "[<key>]" is the idempotency key; everything after it is cosmetic
// ---------------------------------------------------------------------------

const nameFor = (key, title, issue) =>
  `[${key}] ${title}` + (issue ? ` · #${issue}` : '')

// Matches publish-tickets.mjs findExisting: a clean "[key]" PREFIX wins; a mere mention
// that is not a prefix is 'ambiguous' and skipped, because creating would duplicate and
// guessing could later complete the wrong task.
const findByKey = (list, key) => {
  const marker = `[${key}]`
  const hits = list.filter((t) => String(t.name || '').includes(marker))
  const exact = hits.find((t) => String(t.name || '').trim().startsWith(marker))
  if (exact) return exact
  if (hits.length > 0) return 'ambiguous'
  return null
}

// ---------------------------------------------------------------------------
// --issues: PUBLISH-SUMMARY-JSON -> { ticketId: issueNumber }
// ---------------------------------------------------------------------------

const loadIssueMap = () => {
  const src = flag('--issues')
  if (!src) return {}
  let raw = ''
  try {
    raw = src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8')
  } catch (e) {
    fail('issues-unreadable', `--issues ${src}: ${String(e && e.message ? e.message : e).split('\n')[0]}`)
    return {}
  }
  // Accept either a bare JSON array or a line carrying the PUBLISH-SUMMARY-JSON prefix,
  // so a caller can pipe publish-tickets.mjs stdout straight through.
  const line = raw.split('\n').find((l) => l.includes('PUBLISH-SUMMARY-JSON:'))
  const json = line ? line.slice(line.indexOf('PUBLISH-SUMMARY-JSON:') + 'PUBLISH-SUMMARY-JSON:'.length) : raw
  try {
    const arr = JSON.parse(json.trim())
    const map = {}
    for (const e of Array.isArray(arr) ? arr : []) if (e && e.id && e.issue) map[e.id] = e.issue
    return map
  } catch (e) {
    fail('issues-unparseable', `--issues ${src}: ${String(e && e.message ? e.message : e).split('\n')[0]}`)
    return {}
  }
}

// ---------------------------------------------------------------------------
// URL parsing — resolve only
// ---------------------------------------------------------------------------

// Three shapes are in the wild; the newest omits the project. The org id in the UI URL is
// NOT the API workspace gid, so it is deliberately discarded — the workspace comes from
// GET /tasks/{gid} instead.
const parseTaskUrl = (url) => {
  const u = String(url || '').trim().split('?')[0].replace(/\/+$/, '')
  const m =
    u.match(/\/1\/\d+\/project\/\d+\/task\/(\d+)/) || // /1/<org>/project/<p>/task/<t>
    u.match(/\/1\/\d+\/task\/(\d+)/) ||               // /1/<org>/task/<t>
    u.match(/\/0\/\d+\/(\d+)(?:\/f)?$/)              // legacy /0/<p>/<t>[/f]
  if (m) return m[1]
  // A bare gid is accepted so the command works when a user copies the id itself.
  if (/^\d{6,}$/.test(u)) return u
  return ''
}

// ---------------------------------------------------------------------------
// preflight shared by every verb that talks to Asana
// ---------------------------------------------------------------------------

const preflight = () => {
  if (!TOKEN) {
    fail('no-token', 'ASANA_TOKEN is not set — export it (never commit it, never pass it as an argument). See integrations/asana/README.md.')
    return null
  }
  const cfg = loadConfig()
  // resolve/configure run BEFORE a config exists — that is their whole point.
  if (VERB === 'resolve' || VERB === 'configure') return { cfg: cfg && !cfg.__invalid ? cfg : {} }
  if (!cfg) {
    fail('not-configured', `${CONFIG_PATH} not found — run /connect-asana first. Asana sync is optional; the pipeline runs without it.`)
    return null
  }
  if (cfg.__invalid) {
    fail('bad-config', `${CONFIG_PATH} is unusable: ${cfg.__invalid}`)
    return null
  }
  summary.configured = true
  summary.repoTask = cfg.repoTask
  return { cfg }
}

// ---------------------------------------------------------------------------
// verbs
// ---------------------------------------------------------------------------

const doCheck = async (cfg) => {
  const task = await getTask(cfg.repoTask)
  console.log(`repo task: ${task.name} (${cfg.repoTask})`)
  console.log(`workspace: ${task.workspace ? task.workspace.gid : '(unknown)'}`)
  if (task.parent) console.log(`(note) the configured repo task is itself a subtask — modules will be nested one level deeper than expected`)
  const modules = await listSubtasks(cfg.repoTask)
  console.log(`module subtasks: ${modules.length}`)
  summary.items = modules.map((m) => ({ gid: m.gid, name: m.name, completed: !!m.completed }))
}

const doResolve = async () => {
  const url = flag('--url')
  if (!url) { fail('missing-url', 'resolve needs --url <asana-task-url>'); return }
  const gid = parseTaskUrl(url)
  if (!gid) {
    fail('unparseable-url', `could not find a task id in: ${url} — expected app.asana.com/1/<org>/project/<p>/task/<t>, /1/<org>/task/<t>, or a legacy /0/<p>/<t> link`)
    return
  }
  const task = await getTask(gid)
  const workspace = task.workspace ? task.workspace.gid : ''
  console.log(`task:      ${task.name}`)
  console.log(`gid:       ${gid}`)
  console.log(`workspace: ${workspace || '(unknown)'}`)
  if (task.parent) console.log(`(note) this task is a subtask of "${task.parent.name || task.parent.gid}" — usable, but modules land one level deeper`)
  summary.items = [{ gid, name: task.name, workspace, isSubtask: !!task.parent }]
}

// Write .claude/asana.json from a validated Asana task URL. Refuses to clobber an existing
// config without --force, so re-running /connect-asana cannot silently repoint a repo at a
// different Asana task mid-project.
const doConfigure = async (existing) => {
  const url = flag('--url')
  if (!url) { fail('missing-url', 'configure needs --url <asana-task-url>'); return }
  const gid = parseTaskUrl(url)
  if (!gid) {
    fail('unparseable-url', `could not find a task id in: ${url} — expected app.asana.com/1/<org>/project/<p>/task/<t>, /1/<org>/task/<t>, or a legacy /0/<p>/<t> link`)
    return
  }
  if (existing && existing.repoTask && !FORCE) {
    fail('already-configured', `${CONFIG_PATH} already points at repo task ${existing.repoTask} — re-run with --force to repoint. Changing it orphans every subtask already created under the old task.`)
    return
  }
  // Validate before writing: a config pointing at a task the token cannot read is worse
  // than no config, because every later run fails with a confusing 404 instead of
  // "not configured".
  const task = await getTask(gid)
  const project = flag('--project')
  const cfg = {
    // Documents the hierarchy decision in the artifact itself. Only "task" is implemented;
    // "project" is reserved for repo -> Asana project (issue #124 non-goals).
    mode: 'task',
    repoTask: gid,
    repoTaskName: task.name || '',
    workspace: task.workspace ? task.workspace.gid : '',
    // Optional mitigation for the accepted sub-subtask visibility cost (see header).
    addTicketsToProject: project || null,
    note: 'Token lives in the ASANA_TOKEN env var, never in this file. See integrations/asana/README.md.',
  }
  // Belt and braces: a token must never be serializable into this file, whatever a future
  // edit adds to the object. Asserted in E2E as well.
  const serialized = JSON.stringify(cfg, null, 2) + '\n'
  if (TOKEN && serialized.includes(TOKEN)) {
    fail('refusing-to-write-secret', 'the resolved config would contain the ASANA_TOKEN value — refusing to write')
    return
  }
  mkdirSync('.claude', { recursive: true })
  writeFileSync(CONFIG_PATH, serialized)
  console.log(`+ wrote ${CONFIG_PATH}`)
  console.log(`  repo task: ${cfg.repoTaskName} (${gid})`)
  console.log(`  workspace: ${cfg.workspace || '(unknown)'}`)
  console.log(`  tickets added to project: ${cfg.addTicketsToProject || '(none — sub-subtasks stay out of project views; see README)'}`)
  if (task.parent) console.log(`(note) this task is a subtask of "${task.parent.name || task.parent.gid}" — usable, but modules land one level deeper`)
  summary.configured = true
  summary.repoTask = gid
  summary.items = [{ gid, name: task.name, workspace: cfg.workspace, wroteConfig: CONFIG_PATH }]
}

// Ensure the module subtask exists under the repo task, then every ticket subtask under it.
const doSync = async (cfg) => {
  const moduleDir = positional(0)
  if (!moduleDir) { fail('missing-module-dir', 'sync needs <module-dir>, e.g. docs/prd/01-foundation'); return }
  const tickets = readTickets(moduleDir)
  if (tickets === null) { fail('no-tickets-dir', `no tickets directory: ${join(moduleDir, 'tickets')}`); return }

  const issueMap = loadIssueMap()
  const mKey = moduleKey(moduleDir)
  const mName = nameFor(mKey, moduleTitle(moduleDir))
  summary.module = { key: mKey, dir: moduleDir.replaceAll('\\', '/') }

  const existingModules = await listSubtasks(cfg.repoTask)
  let moduleTask = findByKey(existingModules, mKey)
  if (moduleTask === 'ambiguous') {
    fail('ambiguous-module', `several subtasks of the repo task mention "[${mKey}]" but none has it as a clean name prefix — resolve by hand in Asana`)
    return
  }
  if (!moduleTask) {
    if (!CREATE) {
      console.log(`+ would create module subtask: "${mName}"`)
      summary.module.gid = null
      summary.module.planned = true
    } else {
      const t = await createSubtask(cfg.repoTask, { name: mName })
      moduleTask = { gid: t.gid, name: mName, completed: false }
      console.log(`+ created module subtask: "${mName}" (${t.gid})`)
      summary.module.gid = t.gid
      summary.module.created = true
    }
  } else {
    console.log(`= module subtask exists: "${moduleTask.name}" (${moduleTask.gid})`)
    summary.module.gid = moduleTask.gid
  }

  // Dry-run with no module task yet: there is nothing to list under, so every ticket is
  // reported as planned rather than pretending to have checked Asana for it.
  const existingTickets = moduleTask && moduleTask !== 'ambiguous' ? await listSubtasks(moduleTask.gid) : []

  for (const t of tickets) {
    const issue = issueMap[t.id] || null
    const wanted = nameFor(t.id, t.title, issue)
    const found = findByKey(existingTickets, t.id)

    if (found === 'ambiguous') {
      fail('ambiguous-ticket', `several subtasks mention "[${t.id}]" but none has it as a clean name prefix — resolve by hand in Asana`, { id: t.id })
      summary.items.push({ id: t.id, gid: null, error: 'ambiguous' })
      continue
    }
    if (found) {
      // The name is cosmetic, so a rename is a cheap, safe convergence: it is how a
      // subtask created before its issue existed picks up its "#N" cross-reference.
      if (found.name !== wanted && CREATE) {
        try {
          await updateTask(found.gid, { name: wanted })
          console.log(`~ renamed ${t.id}: "${found.name}" -> "${wanted}"`)
          summary.items.push({ id: t.id, gid: found.gid, renamed: true })
          continue
        } catch (e) {
          fail('rename-failed', `${t.id}: ${String(e && e.message ? e.message : e).split('\n')[0]}`, { id: t.id })
          summary.items.push({ id: t.id, gid: found.gid, error: 'rename-failed' })
          continue
        }
      }
      console.log(`= ${t.id}: subtask exists (${found.gid})`)
      summary.items.push({ id: t.id, gid: found.gid, completed: !!found.completed })
      continue
    }
    if (!CREATE) {
      console.log(`+ would create ${t.id}: "${wanted}"`)
      summary.items.push({ id: t.id, gid: null, planned: true })
      continue
    }
    try {
      const created = await createSubtask(moduleTask.gid, { name: wanted, notes: `Ticket: ${t.path}` })
      console.log(`+ created ${t.id}: "${wanted}" (${created.gid})`)
      const item = { id: t.id, gid: created.gid, created: true }
      // Optional visibility mitigation for the accepted sub-subtask cost (see header).
      // A failure here must not undo a created subtask, so it is reported, not fatal.
      if (cfg.addTicketsToProject) {
        try {
          await addToProject(created.gid, cfg.addTicketsToProject)
          item.addedToProject = cfg.addTicketsToProject
        } catch (e) {
          fail('add-to-project-failed', `${t.id}: ${String(e && e.message ? e.message : e).split('\n')[0]}`, { id: t.id })
          item.error = 'add-to-project-failed'
        }
      }
      summary.items.push(item)
    } catch (e) {
      fail('create-failed', `${t.id}: ${String(e && e.message ? e.message : e).split('\n')[0]}`, { id: t.id })
      summary.items.push({ id: t.id, gid: null, error: 'create-failed' })
    }
  }

  const counts = summary.items.reduce((a, i) => {
    if (i.created) a.created++
    else if (i.planned) a.planned++
    else if (i.error) a.failed++
    else a.existing++
    return a
  }, { created: 0, planned: 0, existing: 0, failed: 0 })
  console.log(
    CREATE
      ? `CREATED: ${counts.created}, already existed: ${counts.existing}, failed: ${counts.failed}.`
      : `DRY-RUN: ${counts.planned} would be created, ${counts.existing} already exist. Re-run with --create.`
  )
}

// Complete one ticket's sub-subtask. Searches every module subtask rather than requiring
// the caller to know which module owns the ticket — deliver-ticket.mjs has a ticket id and
// nothing else. N+1 strongly-consistent list calls, still no search.
const doComplete = async (cfg) => {
  const ticketId = positional(0)
  if (!ticketId) { fail('missing-ticket-id', 'complete needs <ticket-id>'); return }
  const modules = await listSubtasks(cfg.repoTask)
  for (const m of modules) {
    const kids = await listSubtasks(m.gid)
    const found = findByKey(kids, ticketId)
    if (found === 'ambiguous') {
      fail('ambiguous-ticket', `several subtasks of "${m.name}" mention "[${ticketId}]" but none has it as a clean name prefix — resolve by hand in Asana`, { id: ticketId })
      return
    }
    if (!found) continue
    if (found.completed) {
      console.log(`= ${ticketId}: already completed (${found.gid})`)
      summary.items.push({ id: ticketId, gid: found.gid, completed: true, alreadyCompleted: true })
      return
    }
    if (!CREATE) {
      console.log(`+ would complete ${ticketId}: "${found.name}" (${found.gid})`)
      summary.items.push({ id: ticketId, gid: found.gid, planned: true })
      return
    }
    try {
      await updateTask(found.gid, { completed: true })
      console.log(`+ completed ${ticketId}: "${found.name}" (${found.gid})`)
      summary.items.push({ id: ticketId, gid: found.gid, completed: true })
    } catch (e) {
      fail('complete-failed', `${ticketId}: ${String(e && e.message ? e.message : e).split('\n')[0]}`, { id: ticketId })
      summary.items.push({ id: ticketId, gid: found.gid, error: 'complete-failed' })
    }
    return
  }
  // Not an error the pipeline should die on: the subtask may simply never have been
  // synced. Reported so the caller escalates and a human can run `sync --create`.
  fail('ticket-subtask-missing', `no Asana subtask named "[${ticketId}] ..." under any module of the repo task — run \`asana-sync.mjs sync <module-dir> --create\``, { id: ticketId })
}

const doStatus = async (cfg) => {
  const moduleDir = positional(0)
  const modules = await listSubtasks(cfg.repoTask)
  const wanted = moduleDir ? [moduleKey(moduleDir)] : null
  for (const m of modules) {
    const key = (String(m.name || '').match(/^\[([^\]]+)\]/) || [])[1] || ''
    if (wanted && !wanted.includes(key)) continue
    const kids = await listSubtasks(m.gid)
    const done = kids.filter((k) => k.completed).length
    console.log(`${m.completed ? 'x' : ' '} ${m.name} — ${done}/${kids.length} tickets complete`)
    summary.items.push({
      gid: m.gid, key, name: m.name, completed: !!m.completed,
      tickets: kids.map((k) => ({ gid: k.gid, name: k.name, completed: !!k.completed })),
    })
  }
  if (moduleDir && summary.items.length === 0) {
    fail('module-subtask-missing', `no module subtask named "[${moduleKey(moduleDir)}] ..." under the repo task — run \`asana-sync.mjs sync ${moduleDir} --create\``)
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const pre = preflight()
if (!pre) finish()

try {
  if (VERB === 'check') await doCheck(pre.cfg)
  else if (VERB === 'resolve') await doResolve()
  else if (VERB === 'configure') await doConfigure(pre.cfg)
  else if (VERB === 'sync') await doSync(pre.cfg)
  else if (VERB === 'complete') await doComplete(pre.cfg)
  else if (VERB === 'status') await doStatus(pre.cfg)
} catch (e) {
  // Any unhandled Asana/HTTP failure lands here and STILL exits 0 — see the exit-code
  // contract in the header. The caller escalates from `errors`.
  fail('asana-unavailable', String(e && e.message ? e.message : e).split('\n')[0])
}

if (process.env.ASANA_DEBUG) console.log(`(debug) api requests: ${requestCount}`)
finish()
