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

if (joined.startsWith('auth status')) process.exit(0)

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

if (joined.startsWith('issue create')) { logBody('create', flag('--description')); console.log('https://gitlab.example.com/acme/repo/-/issues/77'); process.exit(0) }

if (joined.startsWith('issue update')) { logBody('update ' + args[2], flag('--description')); console.log(`Updated issue #${args[2]}`); process.exit(0) }

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
      gitq(['clone', '-q', origin, tmp])
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
    } finally { rmSync(tmp, { recursive: true, force: true }) }
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
