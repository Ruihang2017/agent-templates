#!/usr/bin/env node
// Canned `glab` CLI for E2E (invoked via GLAB_BIN="node .../fake-glab.mjs").
// Simulates an OLDER glab: `issue list --output json` exits 1, forcing the
// publish script's per-line text fallback. Env:
//   FAKE_GLAB_LIST          text for `issue list --all` (one "#N  title" per line)
//   FAKE_GLAB_CLOSED_STATE  file accumulating closed issue numbers (close/view)
//   FAKE_GLAB_MERGE_BLOCKED "1"/"checks" -> `mr merge` fails, pipeline not passed;
//                           "protection" -> fails because the TARGET branch is protected
//                           (clears once the MR is retargeted — issue #139)
// MR state lives in <repo>/.git (self-contained); `mr merge` performs a REAL merge
// into the bare origin so deliver-ticket's post-merge ancestry check is faithful.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const joined = args.join(' ')
const flag = (name) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '' }

const gitq = (a, opts = {}) => execFileSync('git', a, { encoding: 'utf8', ...opts })
const mapFile = () => {
  try { return join(gitq(['rev-parse', '--git-dir']).trim(), 'fake-mr.json') } catch { return join('.git', 'fake-mr.json') }
}
const readMap = () => { const f = mapFile(); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { seq: 0, mrs: [] } }
const writeMap = (m) => writeFileSync(mapFile(), JSON.stringify(m))
const logBody = (label, body) => {
  const f = process.env.FAKE_GLAB_BODY_LOG
  if (f) writeFileSync(f, (existsSync(f) ? readFileSync(f, 'utf8') : '') + `=== ${label} ===\n` + body + '\n')
}

// Every argument this fake was invoked with, one per line. The point is issue #134's
// property: no argument may ever be body-sized. Recording argv is the only way to assert
// that on Linux CI, where the 32,767-character Windows cap never bites.
if (process.env.FAKE_GLAB_ARGV_LOG) {
  writeFileSync(process.env.FAKE_GLAB_ARGV_LOG,
    (existsSync(process.env.FAKE_GLAB_ARGV_LOG) ? readFileSync(process.env.FAKE_GLAB_ARGV_LOG, 'utf8') : '')
    + args.join('\n') + '\n')
}

if (joined.startsWith('auth status')) {
  // catalog issue #220. FAKE_GLAB_STALE_HOST names a host that is configured but dead.
  // Unscoped `auth status` checks EVERY configured host and fails if any does; scoping it
  // to --hostname <the repo's host> succeeds. Exit 0 unless we are asked to reproduce that.
  const stale = process.env.FAKE_GLAB_STALE_HOST || ''
  const i = args.indexOf('--hostname')
  const scoped = i !== -1 ? args[i + 1] : ''
  if (!stale) process.exit(0)
  if (scoped && scoped !== stale) {
    console.log(`${scoped}\n  - Logged in to ${scoped} as e2e`)
    process.exit(0)
  }
  if (scoped === stale) {
    console.error(`${stale}\n  x API call failed: 401 {error: invalid_token}`)
    process.exit(1)
  }
  // unscoped: every host, so the stale one fails the whole probe
  console.error(`${stale}\n  x API call failed: 401 {error: invalid_token}\n  X could not authenticate to one or more of the configured instances.`)
  process.exit(1)
}

// simulate an org whose token has Issues API but a 403 MR API (catalog issue #56):
// every `glab mr *` is denied, Issues verbs keep working.
if (process.env.FAKE_GLAB_MR_API_DENIED === '1' && joined.startsWith('mr ')) {
  console.error('403 Forbidden: insufficient scope for the merge requests API')
  process.exit(1)
}

// `issue list`. Two modes, because until catalog issue #132 this fake only ever simulated
// the OLD glab (no --output json) — so the JSON path that EVERY current install takes had
// never been exercised by a single test, which is precisely how the pagination bug shipped.
//
//   FAKE_GLAB_ISSUES_JSON  JSON array of {iid,title,state,description} -> real --output
//                          json path, paginated with --per-page/--page
//   FAKE_GLAB_ISSUES_FILE  same, read from a FILE. Required for fixtures over ~128 KB:
//                          Linux caps a single env string at MAX_ARG_STRLEN (128 KB), so
//                          a multi-MB fixture in the env fails to spawn at all — which is
//                          the same "bulk data through a process boundary" limit the
//                          script itself hits on argv (catalog issue #134)
//   FAKE_GLAB_LIST         legacy text mode; --output json exits 1 (old CLI simulation)
//   FAKE_GLAB_IGNORE_PAGE  '1' -> honour --per-page but IGNORE --page, always serving
//                          page 1. Models a CLI that silently does not paginate; the
//                          script must detect it rather than truncate.
// Exit from the write CALLBACK, never straight after the write. Node's stdout to a pipe
// is async on POSIX and sync on Windows, so `write(big); process.exit(0)` truncates a
// multi-MB payload on Linux while looking perfect on Windows — P18 was green locally and
// red on Linux CI for exactly that. A truncated page reaches the script as malformed
// JSON, i.e. the fake would manufacture the very failure P18 exists to rule out.
//
// The branches below are if/ELSE rather than early-exit: write() with a callback returns
// IMMEDIATELY, and this is an ES module so a top-level `return` is a syntax error. Falling
// through to the legacy `--output` branch made it exit 1 before the callback ever ran.
// Because the exit is deferred to that callback, execution continues past this block to
// the bottom-of-file catch-all — which would exit(1) first. `handled` guards it.
let handled = false
const writeOut = (s) => { handled = true; process.stdout.write(s, () => process.exit(0)) }

if (joined.startsWith('issue list')) {
  const raw = process.env.FAKE_GLAB_ISSUES_FILE
    ? readFileSync(process.env.FAKE_GLAB_ISSUES_FILE, 'utf8')
    : process.env.FAKE_GLAB_ISSUES_JSON
  if (raw && args.includes('--output')) {
    const all = JSON.parse(raw)
    const perPage = Number(flag('--per-page') || 30)
    const page = process.env.FAKE_GLAB_IGNORE_PAGE === '1' ? 1 : Number(flag('--page') || 1)
    const start = (page - 1) * perPage
    writeOut(JSON.stringify(all.slice(start, start + perPage)))
  } else if (raw) {
    // text mode against a JSON fixture: emit the same "#N  title" shape
    const rows = JSON.parse(raw).map((i) => `#${i.iid}  ${i.title}`).join('\n')
    writeOut(rows + (rows ? '\n' : ''))
  } else if (args.includes('--output')) {
    console.error('unknown flag: --output')
    process.exit(1)
  } else {
    writeOut(process.env.FAKE_GLAB_LIST || '')
  }
}

// ---- REST surface (issue #134) ----
// Issue bodies now go through `glab api --field description=@<file>` instead of
// `issue create --description <body>`, because a --description value is an ARGV element
// and Windows caps a command line at 32,767 characters. This fake asserts the property
// that matters on every platform, not just where the limit bites: the body arrives as a
// FILE REFERENCE, and no argument is ever body-sized.
const fieldValue = (name) => {
  for (let i = 0; i < args.length - 1; i++) {
    if ((args[i] === '--field' || args[i] === '-f' || args[i] === '--raw-field') && args[i + 1].startsWith(name + '=')) {
      return args[i + 1].slice(name.length + 1)
    }
  }
  return ''
}
const readFieldFile = (name) => {
  const v = fieldValue(name)
  if (!v.startsWith('@')) {
    // The fake refuses the old shape outright rather than accepting it quietly — an
    // inline body is the defect, so it must fail here and not merely be "supported".
    console.error(`fake-glab: field ${name} must be a file reference (@path), got a ${v.length}-char inline value`)
    process.exit(1)
  }
  return readFileSync(v.slice(1), 'utf8')
}

if (joined.startsWith('api projects/:fullpath/issues') && args.includes('POST')) {
  logBody('create', readFieldFile('description'))
  // The number is returned as a FIELD. The old code scraped it out of a URL and could
  // bind the wrong issue when GitLab switched to /-/work_items/N; there is nothing to
  // parse here. web_url deliberately uses the work_items form so a regression back to
  // URL-scraping fails against the shape that actually broke in the field.
  // FAKE_GLAB_CREATE_OUT lets a test drive the exact response shape — the JSON form, the
  // legacy /-/issues/N URL, the newer /-/work_items/N one, and outputs carrying a decoy
  // `#N`. Default is the work_items shape, so a regression back to URL-scraping fails
  // against the form that actually broke in the field.
  const iid = Number(process.env.FAKE_GLAB_NEW_IID || 77)
  // writeOut is asynchronous, so these must be exclusive — calling both concatenates two
  // JSON objects into one unparseable blob and the test measures the wrong thing.
  writeOut(process.env.FAKE_GLAB_CREATE_OUT || JSON.stringify({
    iid,
    title: fieldValue('title'),
    web_url: `https://gitlab.example.com/acme/repo/-/work_items/${iid}`,
  }))
}

if (/^api projects\/:fullpath\/issues\/\d+/.test(joined) && args.includes('PUT')) {
  const num = (joined.match(/issues\/(\d+)/) || [])[1]
  logBody('update ' + num, readFieldFile('description'))
  writeOut(JSON.stringify({ iid: Number(num) }))
}

// The old CLI shapes must NOT be reachable any more. Keeping them working would let the
// argv path survive a refactor with every test still green.
if (joined.startsWith('issue create') || joined.startsWith('issue update')) {
  console.error(`fake-glab: '${args.slice(0, 2).join(' ')}' is no longer used — issue bodies must go through 'glab api --field description=@file' (issue #134)`)
  process.exit(1)
}

if (joined.startsWith('issue close')) {
  const st = process.env.FAKE_GLAB_CLOSED_STATE
  if (st) writeFileSync(st, (existsSync(st) ? readFileSync(st, 'utf8') : '') + args[2] + '\n')
  console.log(`Closed issue #${args[2]}`)
  process.exit(0)
}

if (joined.startsWith('issue view')) {
  const st = process.env.FAKE_GLAB_CLOSED_STATE
  const closed = st && existsSync(st) && readFileSync(st, 'utf8').split('\n').includes(args[2])
  console.log(closed ? `#${args[2]}: closed` : `#${args[2]}: open`)
  process.exit(0)
}

if (joined.startsWith('issue note')) { console.log(`https://gitlab.example.com/acme/repo/-/issues/${args[2]}#note_1`); process.exit(0) }

// ---- MR surface ----
// catalog issue #202: the GitLab branch had the same first-match-wins shape, and the
// CLI listing carries no state — so the fix reads the merge_requests API. Served here so
// that branch is TESTED rather than merely written; the reporter left it alone for want of
// a way to exercise it.
if (args[0] === 'api' && /merge_requests\?/.test(joined)) {
  const src = (joined.match(/source_branch=([^&\s]+)/) || [])[1] || ''
  const branch = decodeURIComponent(src)
  const m = readMap()
  const closed = new Set(String(process.env.FAKE_GLAB_CLOSED_MRS || '').split(',').map((x) => x.trim()).filter(Boolean))
  const rows = m.mrs
    .filter((p) => !branch || p.branch === branch)
    .map((p) => ({
      iid: p.number,
      web_url: p.url,
      state: p.merged ? 'merged' : (closed.has(p.branch) ? 'closed' : 'opened'),
    }))
  console.log(JSON.stringify(rows))
  process.exit(0)
}

if (joined.startsWith('mr list')) {
  const src = flag('--source-branch')
  const m = readMap()
  const hit = m.mrs.filter((x) => !src || x.branch === src)
  process.stdout.write(hit.map((x) => `!${x.number}\t${x.branch}`).join('\n'))
  process.exit(0)
}

if (joined.startsWith('mr create')) {
  const m = readMap()
  const number = ++m.seq
  const url = `https://gitlab.example.com/acme/repo/-/merge_requests/${number}`
  m.mrs.push({ number, branch: flag('--source-branch'), base: flag('--target-branch'), url, merged: false, notes: [] })
  writeMap(m)
  console.log(url)
  process.exit(0)
}

if (joined.startsWith('mr note')) {
  const number = Number(args[2])
  const m = readMap()
  const mr = m.mrs.find((x) => x.number === number)
  if (mr) { mr.notes.push(flag('--message')); writeMap(m) }
  console.log(`https://gitlab.example.com/acme/repo/-/merge_requests/${number}#note_1`)
  process.exit(0)
}

if (joined.startsWith('mr update')) {
  const number = Number(args[2])
  const m = readMap()
  const mr = m.mrs.find((x) => x.number === number)
  const target = flag('--target-branch')
  if (!mr) { console.error(`no MR !${number}`); process.exit(1) }
  if (target) { mr.base = target; writeMap(m) }
  console.log(`Updated MR !${number}`)
  process.exit(0)
}

// GET a merge request (issues #135, #152). deliver-ticket polls detailed_merge_status
// before merging, because GitLab is still COMPUTING mergeability right after an MR is
// created and merging into that window returns 405.
//
//   FAKE_GLAB_MERGE_STATUS_SEQ  comma-separated statuses served one per call, the last
//                               repeating — e.g. "checking,ci_still_running,mergeable"
//   FAKE_GLAB_SQUASH            "1" -> a merge produces a NEW squash commit and the
//                               source is never an ancestor, as squash_option: default_on
//                               behaves. This is what made ancestry-only detection report
//                               `not-delivered` for five MRs that had all landed.
if (/^api projects\/:fullpath\/merge_requests\/\d+$/.test(joined)) {
  const number = Number((joined.match(/merge_requests\/(\d+)/) || [])[1])
  const m = readMap()
  const mr = m.mrs.find((x) => x.number === number)
  if (!mr) { console.error(`no MR !${number}`); process.exit(1) }
  const seqFile = join(gitq(['rev-parse', '--git-dir']).trim(), `fake-mr-poll-${number}`)
  const seq = (process.env.FAKE_GLAB_MERGE_STATUS_SEQ || 'mergeable').split(',')
  const n = existsSync(seqFile) ? Number(readFileSync(seqFile, 'utf8')) : 0
  writeFileSync(seqFile, String(n + 1))
  writeOut(JSON.stringify({
    iid: number,
    state: mr.merged ? 'merged' : 'opened',
    detailed_merge_status: mr.merged ? 'mergeable' : seq[Math.min(n, seq.length - 1)],
    merge_commit_sha: mr.merged ? mr.mergeSha || null : null,
    squash_commit_sha: mr.merged && mr.squashSha ? mr.squashSha : null,
  }))
}

if (joined.startsWith('mr merge')) {
  const blocked = process.env.FAKE_GLAB_MERGE_BLOCKED
  const number = Number(args[2])
  const m = readMap()
  const mr = m.mrs.find((x) => x.number === number)
  // GitLab rejects a merge with no --sha: modern glab defaults --auto-merge on, and
  // auto-merge requires one. The fake reproduces the exact 400, and ALSO checks the value
  // against the real branch head — so passing a present-but-wrong SHA cannot pass a test.
  const shaIx = args.indexOf('--sha')
  const sha = shaIx !== -1 ? args[shaIx + 1] : ''
  if (!sha) { console.error('400 {message: SHA must be provided when merging}'); process.exit(1) }
  if (mr) {
    const head = gitq(['rev-parse', `origin/${mr.branch}`]).trim()
    if (!head.startsWith(sha) && !sha.startsWith(head)) {
      console.error(`409 {message: SHA does not match HEAD of source branch} (got ${sha}, head ${head})`)
      process.exit(1)
    }
  }
  if (blocked === '1' || blocked === 'checks') { console.error('merge failed: pipeline must succeed'); process.exit(1) }
  if (blocked === 'protection' && mr && mr.base === (process.env.FAKE_GLAB_PROTECTED_BRANCH || 'main')) {
    console.error('403 Forbidden: protected branch — you are not allowed to merge into main')
    process.exit(1)
  }
  if (!mr) { console.error(`no MR !${number}`); process.exit(1) }
  try {
    const origin = gitq(['remote', 'get-url', 'origin']).trim()
    const tmp = mkdtempSync(join(tmpdir(), 'fake-glab-merge-'))
    try {
      // `--branch <base>` is load-bearing, not tidiness. `git init --bare` leaves HEAD at
      // refs/heads/master, and pushing `main` does not move it — so a plain clone reports
      // "remote HEAD refers to nonexistent ref, unable to checkout" and lands on an UNBORN
      // branch where `rev-parse HEAD` is fatal. That produced an intermittent G5 failure
      // whose only symptom was a clone warning, which is why it read as unexplained flake
      // rather than a bug (recorded honestly in PR #171; diagnosed 2026-08-11).
      gitq(['clone', '-q', '--branch', mr.base, origin, tmp])
      const g = (a) => gitq(['-C', tmp, ...a])
      g(['config', 'user.email', 'fake-glab@example.com'])
      g(['config', 'user.name', 'fake-glab'])
      g(['checkout', '-q', mr.base])
      if (process.env.FAKE_GLAB_SQUASH === '1') {
        // squash_option: default_on — the source commits become ONE NEW commit, so the
        // original tip is never an ancestor of the target. Ancestry-only detection reports
        // a landed merge as not-delivered forever; that is defect 2 of issue #152.
        const before = g(['rev-parse', 'HEAD']).trim()
        g(['merge', '--squash', `origin/${mr.branch}`])
        g(['commit', '-q', '-m', `${mr.branch} (!${number})`])
        mr.squashSha = g(['rev-parse', 'HEAD']).trim()
        // Self-check: a squash that produced no commit would leave the target unchanged
        // and the test would then measure the wrong thing while looking like a git
        // warning. Fail here, with a message that says what actually happened.
        if (mr.squashSha === before) {
          console.error(`fake-glab: squash merge of ${mr.branch} produced no new commit on ${mr.base}`)
          process.exit(1)
        }
      } else {
        g(['merge', '--no-ff', '--no-edit', '-m', `Merge branch '${mr.branch}' into '${mr.base}' (!${number})`, `origin/${mr.branch}`])
        mr.mergeSha = g(['rev-parse', 'HEAD']).trim()
      }
      g(['push', '-q', 'origin', mr.base])
    } finally {
      // Cleanup must NEVER fail the merge. On Windows git can still hold a freshly
      // written object file for a beat, so rmSync throws ENOTEMPTY — and because this
      // finally sits inside the try whose catch reports "merge failed", a temp-directory
      // problem was reported as a failed merge on a merge that had already pushed.
      // Same class as the earlier G5 flake: harness failure wearing a product failure's
      // clothes. Retries for the common case, swallowed for the rest — a leftover temp
      // dir is worth nothing next to a false negative.
      try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
    }
    mr.merged = true; writeMap(m)
    console.log(`Merged !${number}`)
    process.exit(0)
  } catch (e) {
    console.error('merge failed: ' + String((e && (e.stderr || e.message)) || e).split('\n')[0])
    process.exit(1)
  }
}

if (joined.startsWith('mr view')) {
  const number = Number(args[2])
  const m = readMap()
  const mr = m.mrs.find((x) => x.number === number)
  console.log(mr && mr.merged ? `!${number}: merged` : `!${number}: opened`)
  process.exit(0)
}

if (!handled) {
  console.error(`fake-glab: unhandled args: ${joined}`)
  process.exit(1)
}
