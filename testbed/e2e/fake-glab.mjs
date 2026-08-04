#!/usr/bin/env node
// Canned `glab` CLI for E2E (invoked via GLAB_BIN="node .../fake-glab.mjs").
// Simulates an OLDER glab: `issue list --output json` exits 1, forcing the
// publish script's per-line text fallback. Env:
//   FAKE_GLAB_LIST          text for `issue list --all` (one "#N  title" per line)
//   FAKE_GLAB_CLOSED_STATE  file accumulating closed issue numbers (close/view)
//   FAKE_GLAB_MERGE_BLOCKED "1" -> `mr merge` fails (required pipeline not passed)
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
if (joined.startsWith('issue list')) {
  const raw = process.env.FAKE_GLAB_ISSUES_FILE
    ? readFileSync(process.env.FAKE_GLAB_ISSUES_FILE, 'utf8')
    : process.env.FAKE_GLAB_ISSUES_JSON
  if (raw) {
    if (!args.includes('--output')) {
      // text mode against a JSON fixture: emit the same "#N  title" shape
      const rows = JSON.parse(raw).map((i) => `#${i.iid}  ${i.title}`).join('\n')
      process.stdout.write(rows + (rows ? '\n' : ''))
      process.exit(0)
    }
    const all = JSON.parse(raw)
    const perPage = Number(flag('--per-page') || 30)
    const page = process.env.FAKE_GLAB_IGNORE_PAGE === '1' ? 1 : Number(flag('--page') || 1)
    const start = (page - 1) * perPage
    // Exit from the write CALLBACK, never straight after the write. Node's stdout to a
    // pipe is async on POSIX and sync on Windows, so `write(); process.exit(0)` truncates
    // a multi-MB payload on Linux while looking perfect on Windows — P18 was green locally
    // and red on Linux CI for exactly this. A truncated page would then reach the script
    // as malformed JSON, i.e. the fake would be manufacturing the failure it is testing for.
    process.stdout.write(JSON.stringify(all.slice(start, start + perPage)), () => process.exit(0))
  }
  if (args.includes('--output')) { console.error('unknown flag: --output'); process.exit(1) }
  process.stdout.write(process.env.FAKE_GLAB_LIST || '')
  process.exit(0)
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

if (joined.startsWith('mr merge')) {
  if (process.env.FAKE_GLAB_MERGE_BLOCKED === '1') { console.error('merge failed: pipeline must succeed'); process.exit(1) }
  const number = Number(args[2])
  const m = readMap()
  const mr = m.mrs.find((x) => x.number === number)
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
      g(['merge', '--no-ff', '--no-edit', '-m', `Merge branch '${mr.branch}' into '${mr.base}' (!${number})`, `origin/${mr.branch}`])
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

console.error(`fake-glab: unhandled args: ${joined}`)
process.exit(1)
