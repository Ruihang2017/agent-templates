#!/usr/bin/env node
// Canned `gh` CLI for E2E (invoked via GH_BIN="node .../fake-gh.mjs").
// Issue surface (publish-tickets.mjs / deliver-ticket.mjs) driven by env:
//   FAKE_GH_LIST         JSON array returned by `issue list --json number,title`
//   FAKE_GH_STATE        counter file for created-issue numbers (start 101)
//   FAKE_GH_FAIL_LABELS  "1" -> `issue create` fails when any --label is present
//   FAKE_GH_FAIL_CREATE  "1" -> every `issue create` fails
//   FAKE_GH_CLOSED_STATE file accumulating closed issue numbers (close/view)
//   FAKE_GH_FAIL_CLOSE   "1" -> `issue close` fails
// PR surface (deliver-ticket.mjs pr mode):
//   FAKE_GH_MERGE_BLOCKED "1" -> `pr merge` fails (simulates a required check not met)
// PR state (number/branch/base/comments) is self-contained in <repo>/.git so it is
// cleaned up with the repo and needs no env wiring. `pr merge` performs a REAL merge
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
  try { return join(gitq(['rev-parse', '--git-dir']).trim(), 'fake-pr.json') } catch { return join('.git', 'fake-pr.json') }
}
const readMap = () => { const f = mapFile(); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { seq: 100, prs: [] } }
const writeMap = (m) => writeFileSync(mapFile(), JSON.stringify(m))

if (joined.startsWith('auth status')) process.exit(0)

if (joined.startsWith('issue list')) { process.stdout.write(process.env.FAKE_GH_LIST || '[]'); process.exit(0) }

if (joined.startsWith('issue create')) {
  if (args.includes('--body-file')) readFileSync(0, 'utf8')
  if (process.env.FAKE_GH_FAIL_CREATE === '1') { console.error('GraphQL: boom (createIssue)'); process.exit(1) }
  if (process.env.FAKE_GH_FAIL_LABELS === '1' && args.includes('--label')) { console.error("could not add label: 'module:00-x' not found"); process.exit(1) }
  let n = 101
  const state = process.env.FAKE_GH_STATE
  if (state && existsSync(state)) n = Number(readFileSync(state, 'utf8')) || 101
  if (state) writeFileSync(state, String(n + 1))
  console.log(`https://github.com/acme/repo/issues/${n}`)
  process.exit(0)
}

if (joined.startsWith('issue close')) {
  if (process.env.FAKE_GH_FAIL_CLOSE === '1') { console.error('failed to close issue'); process.exit(1) }
  const st = process.env.FAKE_GH_CLOSED_STATE
  if (st) writeFileSync(st, (existsSync(st) ? readFileSync(st, 'utf8') : '') + args[2] + '\n')
  console.log(`Closed issue #${args[2]}`)
  process.exit(0)
}

if (joined.startsWith('issue view')) {
  const st = process.env.FAKE_GH_CLOSED_STATE
  const closed = st && existsSync(st) && readFileSync(st, 'utf8').split('\n').includes(args[2])
  if (args.includes('--json')) console.log(JSON.stringify({ state: closed ? 'CLOSED' : 'OPEN' }))
  else console.log(closed ? 'state:\tclosed' : 'state:\topen')
  process.exit(0)
}

// ---- PR surface ----
if (joined.startsWith('pr list')) {
  const head = flag('--head')
  const m = readMap()
  const hit = m.prs.filter((p) => !head || p.branch === head)
  console.log(JSON.stringify(hit.map((p) => ({ number: p.number, url: p.url, state: p.merged ? 'MERGED' : 'OPEN' }))))
  process.exit(0)
}

if (joined.startsWith('pr create')) {
  if (args.includes('--body-file')) { const f = flag('--body-file'); if (f && existsSync(f)) readFileSync(f, 'utf8') }
  const m = readMap()
  const number = ++m.seq
  const url = `https://github.com/acme/repo/pull/${number}`
  m.prs.push({ number, branch: flag('--head'), base: flag('--base'), url, merged: false, comments: [] })
  writeMap(m)
  console.log(url)
  process.exit(0)
}

if (joined.startsWith('pr comment')) {
  const number = Number(args[2])
  const m = readMap()
  const pr = m.prs.find((p) => p.number === number)
  const bodyFile = flag('--body-file')
  const body = bodyFile && existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : (flag('--body') || '')
  if (pr) { pr.comments.push(body); writeMap(m) }
  console.log(`https://github.com/acme/repo/pull/${number}#issuecomment-1`)
  process.exit(0)
}

if (joined.startsWith('pr merge')) {
  if (process.env.FAKE_GH_MERGE_BLOCKED === '1') { console.error('Pull request is not mergeable: required status checks have not passed'); process.exit(1) }
  const number = Number(args[2])
  const m = readMap()
  const pr = m.prs.find((p) => p.number === number)
  if (!pr) { console.error(`no PR #${number}`); process.exit(1) }
  // perform the real merge into the bare origin so post-merge ancestry is faithful
  try {
    const origin = gitq(['remote', 'get-url', 'origin']).trim()
    const tmp = mkdtempSync(join(tmpdir(), 'fake-gh-merge-'))
    try {
      gitq(['clone', '-q', origin, tmp])
      const g = (a) => gitq(['-C', tmp, ...a])
      g(['config', 'user.email', 'fake-gh@example.com'])
      g(['config', 'user.name', 'fake-gh'])
      g(['checkout', '-q', pr.base])
      g(['merge', '--no-ff', '--no-edit', '-m', `Merge pull request #${number} from ${pr.branch}`, `origin/${pr.branch}`])
      g(['push', '-q', 'origin', pr.base])
    } finally { rmSync(tmp, { recursive: true, force: true }) }
    pr.merged = true; writeMap(m)
    console.log(`Merged pull request #${number}`)
    process.exit(0)
  } catch (e) {
    console.error('merge failed: ' + String((e && (e.stderr || e.message)) || e).split('\n')[0])
    process.exit(1)
  }
}

if (joined.startsWith('pr view')) {
  const number = Number(args[2])
  const m = readMap()
  const pr = m.prs.find((p) => p.number === number)
  console.log(JSON.stringify({ state: pr && pr.merged ? 'MERGED' : 'OPEN', comments: pr ? pr.comments.map((b) => ({ body: b })) : [], url: pr ? pr.url : '' }))
  process.exit(0)
}

console.error(`fake-gh: unhandled args: ${joined}`)
process.exit(1)
