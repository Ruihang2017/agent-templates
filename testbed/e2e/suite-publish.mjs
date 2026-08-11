// E2E for publish-tickets.mjs: runs the ACTUAL scaffold script against fixture
// ticket modules and fake gh/glab CLIs (injected via the GH_BIN/GLAB_BIN overrides).
// Covers idempotency, ambiguity, create/failure paths, degraded-CLI, and the
// machine-readable summary contract.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'publish'
const SCRIPT = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/publish-tickets.mjs', import.meta.url))
const FAKE_GH = 'node ' + fileURLToPath(new URL('./fake-gh.mjs', import.meta.url))
const FAKE_GLAB = 'node ' + fileURLToPath(new URL('./fake-glab.mjs', import.meta.url))

function ticket(id, title) {
  return `---\nid: ${id}\ntitle: ${title}\nmodule: 00-x\nsize: S\nagent: builder\nstatus: ready\ndate: 2026-07-17\n---\n\n# ${id} — body\n\n## Goal\nDo the thing.\n`
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'e2e-pub-'))
  const tdir = join(root, 'docs', 'prd', '00-x', 'tickets')
  mkdirSync(tdir, { recursive: true })
  writeFileSync(join(tdir, 'DEM-01-a.md'), ticket('DEM-01', 'Demo ticket one'))
  writeFileSync(join(tdir, 'DEM-02-b.md'), '﻿' + ticket('DEM-02', '"Deploy: enable \\"safe\\" mode"')) // BOM + quoted YAML title
  writeFileSync(join(tdir, 'DEM-03-dup.md'), ticket('DEM-01', 'Duplicate id'))
  writeFileSync(join(tdir, 'broken.md'), '---\ntitle: no id\n---\nbody\n')
  writeFileSync(join(tdir, 'notes.md'), 'no frontmatter\n')
  return root
}

function runPub(root, args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('PUBLISH-SUMMARY-JSON: '))
  let summary = null
  try { summary = line ? JSON.parse(line.slice('PUBLISH-SUMMARY-JSON: '.length)) : null } catch {}
  return { ...r, summary }
}
const entry = (summary, id, path) => (summary || []).find((e) => (id ? e.id === id : true) && (!path || e.path.includes(path)))

export async function run() {
  const root = makeFixture()
  try {
    const mod = 'docs/prd/00-x'

    // P1: dry-run with one existing issue (exact prefix match)
    {
      const r = runPub(root, [mod], { GH_BIN: FAKE_GH, FAKE_GH_LIST: JSON.stringify([{ number: 7, title: '[DEM-01] Demo ticket one' }]) })
      eq(S, 'P1 exit 0', r.status, 0)
      eq(S, 'P1 DEM-01 skipped as existing #7', entry(r.summary, 'DEM-01', 'DEM-01-a') && entry(r.summary, 'DEM-01', 'DEM-01-a').issue, 7)
      const d2 = entry(r.summary, 'DEM-02')
      check(S, 'P1 DEM-02 planned with clean quoted title', d2 && d2.issue === null && d2.title === '[DEM-02] Deploy: enable "safe" mode')
      eq(S, 'P1 error classes recorded', (r.summary || []).filter((e) => e.error).map((e) => e.error).sort(), ['duplicate-id', 'missing-id-title', 'no-frontmatter'])
    }

    // P2: mention-but-not-prefix is ambiguous, never a silent skip or create
    {
      const r = runPub(root, [mod], { GH_BIN: FAKE_GH, FAKE_GH_LIST: JSON.stringify([{ number: 5, title: 'Discuss [DEM-01] rollout plan' }]) })
      eq(S, 'P2 exit 0 (dry-run)', r.status, 0)
      const d1 = entry(r.summary, 'DEM-01', 'DEM-01-a')
      check(S, 'P2 DEM-01 flagged ambiguous-existing', d1 && d1.error === 'ambiguous-existing' && d1.issue === null)
    }

    // P3: create path with issue-number capture
    {
      const state = join(root, 'gh-state.txt')
      const r = runPub(root, [mod, '--create'], { GH_BIN: FAKE_GH, FAKE_GH_LIST: '[]', FAKE_GH_STATE: state })
      eq(S, 'P3 exit 0', r.status, 0)
      eq(S, 'P3 DEM-01 created as #101', entry(r.summary, 'DEM-01', 'DEM-01-a').issue, 101)
      eq(S, 'P3 DEM-02 created as #102', entry(r.summary, 'DEM-02').issue, 102)
    }

    // P4: label failure triggers retry-without-labels, still created
    {
      const state = join(root, 'gh-state2.txt')
      const r = runPub(root, [mod, '--create'], { GH_BIN: FAKE_GH, FAKE_GH_LIST: '[]', FAKE_GH_STATE: state, FAKE_GH_FAIL_LABELS: '1' })
      eq(S, 'P4 exit 0 after label retry', r.status, 0)
      check(S, 'P4 retry warning on stderr', /retrying without labels/.test(r.stderr))
      check(S, 'P4 tickets still created', entry(r.summary, 'DEM-01', 'DEM-01-a').issue === 101 && entry(r.summary, 'DEM-02').issue === 102)
    }

    // P5: hard create failure — summary must survive, exit 1
    {
      const r = runPub(root, [mod, '--create'], { GH_BIN: FAKE_GH, FAKE_GH_LIST: '[]', FAKE_GH_FAIL_CREATE: '1' })
      eq(S, 'P5 exit 1 on create failure', r.status, 1)
      check(S, 'P5 summary still printed', Array.isArray(r.summary))
      check(S, 'P5 create-failed recorded', /create-failed/.test((entry(r.summary, 'DEM-01', 'DEM-01-a') || {}).error || ''))
    }

    // P6: CLI missing — dry-run degrades, --create refuses
    {
      const dry = runPub(root, [mod], { GH_BIN: 'definitely-not-a-real-binary-xyz' })
      eq(S, 'P6 dry-run exit 0 without CLI', dry.status, 0)
      check(S, 'P6 degraded note printed', /unavailable/.test(dry.stdout))
      const create = runPub(root, [mod, '--create'], { GH_BIN: 'definitely-not-a-real-binary-xyz' })
      eq(S, 'P6 --create exit 1 without CLI', create.status, 1)
    }

    // P7: a glab too old for `--output json` no longer silently falls back to text
    // parsing (catalog issue #132). That fallback inherited the same 30-item window and
    // reported no state/body, so it could only ever degrade into duplicates while
    // disabling drift detection. It is now a fetch FAILURE: dry-run degrades and says so,
    // --create refuses outright.
    {
      const list = '#5 Discuss [DEM-01] rollout plan\n#9 [DEM-01] Demo ticket one\n'
      const r = runPub(root, [mod, '--platform', 'glab'], { GLAB_BIN: FAKE_GLAB, FAKE_GLAB_LIST: list })
      eq(S, 'P7 dry-run with a legacy glab still exits 0', r.status, 0)
      check(S, 'P7 it does NOT resolve issues by text-parsing', entry(r.summary, 'DEM-01', 'DEM-01-a').issue === null)
      check(S, 'P7 the fetch failure is printed, not swallowed', /could not fetch the existing-issue list/.test(r.stdout + r.stderr))
      const c = runPub(root, [mod, '--platform', 'glab', '--create'], { GLAB_BIN: FAKE_GLAB, FAKE_GLAB_LIST: list })
      eq(S, 'P7 --create REFUSES rather than dedupe blind', c.status, 1)
      check(S, 'P7 and it created nothing', !/^\+ created/m.test(c.stdout))
    }

    // P9 (issue #134): the GitLab body must never travel through argv, and the issue
    // number must be READ rather than scraped out of a URL.
    {
      // A body far past Windows' 32,767-character command-line cap. Asserted on every
      // platform, not just where the limit bites — the property is "no argument is ever
      // body-sized", and Linux CI must be able to fail on it too.
      const big = 'x'.repeat(40000)
      const root2 = mkdtempSync(join(tmpdir(), 'e2e-pub-big-'))
      const tdir2 = join(root2, 'docs', 'prd', '00-x', 'tickets')
      mkdirSync(tdir2, { recursive: true })
      writeFileSync(join(tdir2, 'BIG-01-a.md'),
        `---\nid: BIG-01\ntitle: Big ticket\nmodule: 00-x\nsize: S\nagent: builder\nstatus: ready\ndate: 2026-08-11\n---\n\n# BIG-01\n\n## Goal\n${big}\n`)
      const log = join(root2, 'bodies.txt')
      const argvLog = join(root2, 'argv.txt')
      const c = runPub(root2, ['docs/prd/00-x', '--platform', 'glab', '--create'], {
        GLAB_BIN: FAKE_GLAB,
        FAKE_GLAB_ISSUES_JSON: '[]',
        FAKE_GLAB_BODY_LOG: log,
        FAKE_GLAB_ARGV_LOG: argvLog,
      })
      eq(S, 'P9 a 40 KB body publishes on glab', c.status, 0)
      check(S, 'P9 the full body reached the tracker', existsSync(log) && readFileSync(log, 'utf8').includes(big))
      // the load-bearing one: the body was a FILE reference, never an argument
      const argvSeen = existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : ''
      check(S, 'P9 no single argument is body-sized',
        argvSeen && !argvSeen.split('\n').some((a) => a.length > 4000))
      check(S, 'P9 the description arrived as a file reference',
        /description=@/.test(argvSeen))

      // the number came from a field, and the fake returns the /-/work_items/N URL form
      // that broke the old scraper — so a regression to URL parsing fails here
      const entryBig = entry(c.summary, 'BIG-01', 'BIG-01-a')
      eq(S, 'P9 the issue number is read from the API response', entryBig.issue, 77)
      rmSync(root2, { recursive: true, force: true })
    }

    // P10 (issue #134): a decoy `#N` in the create output must never bind the ticket. The
    // old fallback matched any `#digits` anywhere, so it did not merely fail — it could
    // bind the WRONG issue, which is unrecoverable where a missing number is not.
    // Driven through the real script and the fake, so this covers the integration rather
    // than a helper in isolation.
    const createShapes = [
      ['iid in JSON', '{"iid":77,"web_url":"https://g.example/acme/repo/-/work_items/77"}', 77],
      ['the newer work_items URL', 'https://g.example/acme/repo/-/work_items/77', 77],
      ['the legacy issues URL', 'https://g.example/acme/repo/-/issues/77', 77],
      ['a decoy #12 ahead of the real URL', 'relates to #12\nhttps://g.example/acme/repo/-/work_items/77', 77],
      ['a bare #12 with no URL', 'created, see #12 for context', null],
    ]
    for (const [label, out, want] of createShapes) {
      const rootP = mkdtempSync(join(tmpdir(), 'e2e-pub-parse-'))
      const tdirP = join(rootP, 'docs', 'prd', '00-x', 'tickets')
      mkdirSync(tdirP, { recursive: true })
      writeFileSync(join(tdirP, 'PRS-01-a.md'), ticket('PRS-01', 'Parse shape'))
      const c = runPub(rootP, ['docs/prd/00-x', '--platform', 'glab', '--create'], {
        GLAB_BIN: FAKE_GLAB, FAKE_GLAB_ISSUES_JSON: '[]', FAKE_GLAB_CREATE_OUT: out,
      })
      eq(S, `P10 ${label} binds ${want === null ? 'nothing' : '#' + want}`,
        entry(c.summary, 'PRS-01', 'PRS-01-a').issue, want)
      rmSync(rootP, { recursive: true, force: true })
    }

    // P8: invocation edge cases
    {
      const noVal = runPub(root, [mod, '--platform'], {})
      eq(S, 'P8 --platform without value exits 1', noVal.status, 1)
      const bogus = runPub(root, [mod, '--platform', 'gitea'], {})
      eq(S, 'P8 bogus platform exits 1', bogus.status, 1)
      const noArgs = runPub(root, [], {})
      eq(S, 'P8 no args exits 1 with usage', noArgs.status, 1)
    }

    // P9: the dependency line is rendered into the issue body with real #numbers (issue #52)
    {
      const droot = mkdtempSync(join(tmpdir(), 'e2e-pub-dep-'))
      const dtd = join(droot, 'docs', 'prd', '00-x', 'tickets')
      mkdirSync(dtd, { recursive: true })
      writeFileSync(join(dtd, 'FND-07.md'), '---\nid: FND-07\ntitle: Wire it up\nmodule: 00-x\nsize: S\nagent: builder\nstatus: ready\ndate: 2026-07-23\nblocked_by: [FND-01]\nblocks: [FND-09]\n---\n\n# FND-07 — body\n')
      const log = join(droot, 'bodies.txt')
      try {
        const r = runPub(droot, ['docs/prd/00-x', '--create'], {
          GH_BIN: FAKE_GH,
          FAKE_GH_LIST: JSON.stringify([{ number: 7, title: '[FND-01] Foundations' }]),
          FAKE_GH_BODY_LOG: log,
        })
        eq(S, 'P9 exit 0', r.status, 0)
        check(S, 'P9 FND-07 created', entry(r.summary, 'FND-07') && entry(r.summary, 'FND-07').issue !== null)
        const bodies = existsSync(log) ? readFileSync(log, 'utf8') : ''
        check(S, 'P9 body renders Blocked by #7 (resolved number)', /Blocked by:\*\* #7/.test(bodies), bodies.slice(0, 300))
        check(S, 'P9 unpublished blocks target shown as pending', /Blocks:\*\* `FND-09` \(pending\)/.test(bodies), bodies.slice(0, 300))
      } finally { rmSync(droot, { recursive: true, force: true }) }
    }

    // P10: --sync regenerates an EXISTING issue body from its ticket (issue #52 backfill + #53 ticket->issue flow)
    {
      const sroot = mkdtempSync(join(tmpdir(), 'e2e-pub-sync-'))
      const std = join(sroot, 'docs', 'prd', '00-x', 'tickets')
      mkdirSync(std, { recursive: true })
      writeFileSync(join(std, 'FND-07.md'), '---\nid: FND-07\ntitle: Wire it up\nmodule: 00-x\nsize: S\nagent: builder\nstatus: ready\ndate: 2026-07-23\nblocked_by: [FND-01]\n---\n\n# FND-07 — updated body\n')
      const log = join(sroot, 'bodies.txt')
      try {
        const r = runPub(sroot, ['docs/prd/00-x', '--create', '--sync'], {
          GH_BIN: FAKE_GH,
          FAKE_GH_LIST: JSON.stringify([{ number: 7, title: '[FND-01] Foundations' }, { number: 12, title: '[FND-07] Wire it up' }]),
          FAKE_GH_BODY_LOG: log,
        })
        eq(S, 'P10 exit 0', r.status, 0)
        const e = entry(r.summary, 'FND-07')
        check(S, 'P10 FND-07 synced (existing #12 body regenerated)', e && e.issue === 12 && e.synced === true, JSON.stringify(e))
        const bodies = existsSync(log) ? readFileSync(log, 'utf8') : ''
        check(S, 'P10 edit carried the regenerated deps + prose', /edit 12/.test(bodies) && /Blocked by:\*\* #7/.test(bodies) && /updated body/.test(bodies), bodies.slice(0, 300))
      } finally { rmSync(sroot, { recursive: true, force: true }) }
    }

    // P11-P15 (issue #112): issue state and post-delivery drift.
    // /start-all drops CLOSED tickets — that is the resume filter, and it is what makes
    // a re-run after an appended phase execute only the new work. The hole it left: edit
    // an already-delivered ticket, re-run, and NOTHING happens and nothing says so.
    {
      const droot = mkdtempSync(join(tmpdir(), 'e2e-pub-state-'))
      const dtd = join(droot, 'docs', 'prd', '00-x', 'tickets')
      mkdirSync(dtd, { recursive: true })
      const body = '# STA-01 — body\n\n## Goal\nDo the thing.\n'
      writeFileSync(join(dtd, 'STA-01.md'), `---\nid: STA-01\ntitle: Stateful\nmodule: 00-x\n---\n\n${body}`)
      const mod2 = 'docs/prd/00-x'
      const list = (extra) => JSON.stringify([{ number: 21, title: '[STA-01] Stateful', ...extra }])
      try {
        // P11: state flows through to the summary, both ways
        {
          const open = runPub(droot, [mod2], { GH_BIN: FAKE_GH, FAKE_GH_LIST: list({ state: 'OPEN', body }) })
          eq(S, 'P11 open issue reported as open', entry(open.summary, 'STA-01').state, 'open')
          const closed = runPub(droot, [mod2], { GH_BIN: FAKE_GH, FAKE_GH_LIST: list({ state: 'CLOSED', body }) })
          eq(S, 'P11 closed issue reported as closed', entry(closed.summary, 'STA-01').state, 'closed')
        }

        // P12: closed AND matching -> an ordinary skip, no drift noise
        {
          const r = runPub(droot, [mod2], { GH_BIN: FAKE_GH, FAKE_GH_LIST: list({ state: 'CLOSED', body }) })
          check(S, 'P12 a delivered, unchanged ticket does NOT drift', entry(r.summary, 'STA-01').drift === undefined)
          check(S, 'P12 and prints no drift warning', !/DRIFTED-CLOSED/.test(r.stdout))
          // the tracker round-trips CRLF and trims; treating that as an edit would flag everything
          const noisy = runPub(droot, [mod2], { GH_BIN: FAKE_GH, FAKE_GH_LIST: list({ state: 'CLOSED', body: body.replace(/\n/g, '\r\n') + '\n\n' }) })
          check(S, 'P12 CRLF/trailing-whitespace round-trip is not drift', entry(noisy.summary, 'STA-01').drift === undefined)
        }

        // P13: THE case — the ticket was edited after it was delivered
        {
          const r = runPub(droot, [mod2], { GH_BIN: FAKE_GH, FAKE_GH_LIST: list({ state: 'CLOSED', body: '# STA-01 — the ORIGINAL delivered text\n' }) })
          check(S, 'P13 edited-after-delivery flagged as drift', entry(r.summary, 'STA-01').drift === true)
          check(S, 'P13 warning names the ticket and says it will be SKIPPED', /STA-01/.test(r.stderr) && /SKIP/.test(r.stderr))
          check(S, 'P13 the run summary surfaces the count', /DRIFTED-CLOSED: 1/.test(r.stdout))
        }

        // P14: an OPEN issue with a stale body is not drift — the run will execute it
        {
          const r = runPub(droot, [mod2], { GH_BIN: FAKE_GH, FAKE_GH_LIST: list({ state: 'OPEN', body: 'totally different' }) })
          check(S, 'P14 an open issue is never drift (it still runs)', entry(r.summary, 'STA-01').drift === undefined)
        }

        // P15: a CLI that cannot report a body must degrade, not manufacture drift
        {
          const r = runPub(droot, [mod2], { GH_BIN: FAKE_GH, FAKE_GH_LIST: list({ state: 'CLOSED' }) })
          check(S, 'P15 no body available -> no drift claimed', entry(r.summary, 'STA-01').drift === undefined)
          // glab reporting a state but no body: state drives the resume filter, body
          // drives drift — the two degrade independently and neither may be invented.
          const g = runPub(droot, [mod2, '--platform', 'glab'], {
            GLAB_BIN: FAKE_GLAB,
            FAKE_GLAB_ISSUES_JSON: JSON.stringify([{ iid: 21, title: '[STA-01] Stateful', state: 'closed', description: '' }]),
          })
          check(S, 'P15 glab reports state from JSON', entry(g.summary, 'STA-01').state === 'closed')
          check(S, 'P15 an empty body yields no drift claim', entry(g.summary, 'STA-01').drift === undefined)
        }
      } finally { rmSync(droot, { recursive: true, force: true }) }
    }
    // ---------------------------------------------------------------------
    // P16-P22: pagination + dedup correctness (catalog issue #132, field report)
    //
    // The headline case is P16. On the reporting repo — 44 tickets, 44 issues — a single
    // --create produced 43 duplicates, because `glab issue list --all --output json`
    // returns only 30 items (--all is a STATE filter; --per-page defaults to 30) and the
    // script never paginated. Everything past the window read as "never published".
    //
    // Every assertion below counts the FAKE's creates, never the script's own summary:
    // a script that created duplicates and then deduped its own report would otherwise
    // pass. And they are only meaningful because P1/P2 above prove a normal run does
    // create issues — otherwise "created nothing" would just mean "never works".
    {
      const proot = mkdtempSync(join(tmpdir(), 'e2e-pub-page-'))
      const pdir = join(proot, 'docs', 'prd', '00-x', 'tickets')
      mkdirSync(pdir, { recursive: true })
      const N = 44 // the reporter's number
      for (let i = 1; i <= N; i++) {
        writeFileSync(join(pdir, `PAG-${i}.md`), ticket(`PAG-${i}`, `Ticket ${i}`))
      }
      // A tracker where all 44 are already published — far past one 30-item page.
      const published = Array.from({ length: N }, (_, i) => ({
        iid: i + 1, title: `[PAG-${i + 1}] Ticket ${i + 1}`, state: 'opened', description: '',
      }))
      const pmod = 'docs/prd/00-x'
      try {
        const r = runPub(proot, [pmod, '--platform', 'glab', '--create'], {
          GLAB_BIN: FAKE_GLAB, FAKE_GLAB_ISSUES_JSON: JSON.stringify(published),
        })
        eq(S, 'P16 exit 0 re-publishing 44 already-published tickets', r.status, 0)
        // THE regression: not one create, even though 14 of the 44 sit past page 1.
        check(S, 'P16 re-run across >1 page creates NOTHING (the #132 bug)', !/^\+ created/m.test(r.stdout), (r.stdout.match(/^\+ created.*/gm) || []).slice(0, 3).join(' | '))
        eq(S, 'P16 all 44 resolved to their existing issue', r.summary.filter((e) => e.issue !== null).length, N)
        // Specifically the ones the old 30-item window could not see.
        eq(S, 'P16 ticket 44 (well past page 1) resolved', entry(r.summary, 'PAG-44').issue, 44)
        eq(S, 'P16 ticket 31 (first past the old window) resolved', entry(r.summary, 'PAG-31').issue, 31)
      } finally { rmSync(proot, { recursive: true, force: true }) }
    }

    // P17: a CLI that ignores --page must be DETECTED, not silently truncated to page 1.
    // Silent truncation is the original bug, so the fix may not be able to do it either.
    {
      const proot = mkdtempSync(join(tmpdir(), 'e2e-pub-nopage-'))
      mkdirSync(join(proot, 'docs', 'prd', '00-x', 'tickets'), { recursive: true })
      writeFileSync(join(proot, 'docs', 'prd', '00-x', 'tickets', 'PAG-1.md'), ticket('PAG-1', 'One'))
      const many = Array.from({ length: 250 }, (_, i) => ({ iid: i + 1, title: `[OTHER-${i + 1}] x`, state: 'opened', description: '' }))
      try {
        const r = runPub(proot, ['docs/prd/00-x', '--platform', 'glab', '--create'], {
          GLAB_BIN: FAKE_GLAB, FAKE_GLAB_ISSUES_JSON: JSON.stringify(many), FAKE_GLAB_IGNORE_PAGE: '1',
        })
        eq(S, 'P17 a non-advancing pager exits 1', r.status, 1)
        check(S, 'P17 it names the cause', /--page appears to be ignored/.test(r.stdout + r.stderr))
        check(S, 'P17 and it created nothing', !/^\+ created/m.test(r.stdout))
      } finally { rmSync(proot, { recursive: true, force: true }) }
    }

    // P18: >1 MB of issue bodies must not ENOBUFS. Pre-fix, execFileSync's 1 MB default
    // threw, and the throw was swallowed into the text fallback — so the buffer limit was
    // itself a duplicate trigger.
    {
      const proot = mkdtempSync(join(tmpdir(), 'e2e-pub-buf-'))
      mkdirSync(join(proot, 'docs', 'prd', '00-x', 'tickets'), { recursive: true })
      writeFileSync(join(proot, 'docs', 'prd', '00-x', 'tickets', 'BIG-1.md'), ticket('BIG-1', 'Big'))
      const big = Array.from({ length: 60 }, (_, i) => ({
        iid: i + 1, title: `[BIG-${i + 1}] x`, state: 'opened', description: 'y'.repeat(40000),
      }))
      // Via a FILE, not the env: Linux caps a single env string at 128 KB
      // (MAX_ARG_STRLEN), so a 2.4 MB fixture in the env fails to spawn at all — green on
      // Windows, red on Linux CI. Same "bulk data through a process boundary" limit the
      // script itself hits on argv (issue #134); the fixture must not share the defect
      // it is testing around.
      const bigFile = join(proot, 'big.json')
      writeFileSync(bigFile, JSON.stringify(big))
      try {
        const r = runPub(proot, ['docs/prd/00-x', '--platform', 'glab', '--create'], {
          GLAB_BIN: FAKE_GLAB, FAKE_GLAB_ISSUES_FILE: bigFile,
        })
        eq(S, 'P18 a >1 MB issue list is fetched without ENOBUFS', r.status, 0)
        check(S, 'P18 no fetch failure was reported', !/could not fetch/.test(r.stdout + r.stderr))
        eq(S, 'P18 BIG-1 resolved to its existing issue', entry(r.summary, 'BIG-1').issue, 1)
      } finally { rmSync(proot, { recursive: true, force: true }) }
    }

    // P19: resolve to the OLDEST match, on BOTH platforms. gh returns newest-first, so
    // before #132 the gh branch tracked the NEWEST issue — the invariant every dedup rule
    // here assumes was false on half the branches, and untested because the fake echoed
    // the fixture order back.
    {
      const droot = mkdtempSync(join(tmpdir(), 'e2e-pub-old-'))
      mkdirSync(join(droot, 'docs', 'prd', '00-x', 'tickets'), { recursive: true })
      writeFileSync(join(droot, 'docs', 'prd', '00-x', 'tickets', 'OLD-1.md'), ticket('OLD-1', 'Original'))
      // #5 original (open), #90 duplicate (closed) — a repaired tracker.
      const gh = JSON.stringify([
        { number: 5, title: '[OLD-1] Original', state: 'OPEN', body: '' },
        { number: 90, title: '[OLD-1] Original', state: 'CLOSED', body: '' },
      ])
      const gl = JSON.stringify([
        { iid: 5, title: '[OLD-1] Original', state: 'opened', description: '' },
        { iid: 90, title: '[OLD-1] Original', state: 'closed', description: '' },
      ])
      try {
        const g = runPub(droot, ['docs/prd/00-x'], { GH_BIN: FAKE_GH, FAKE_GH_LIST: gh })
        eq(S, 'P19 gh resolves to the OLDEST issue despite newest-first ordering', entry(g.summary, 'OLD-1').issue, 5)
        const l = runPub(droot, ['docs/prd/00-x', '--platform', 'glab'], { GLAB_BIN: FAKE_GLAB, FAKE_GLAB_ISSUES_JSON: gl })
        eq(S, 'P19 glab resolves to the OLDEST issue', entry(l.summary, 'OLD-1').issue, 5)
      } finally { rmSync(droot, { recursive: true, force: true }) }
    }

    // P20-P22: the pre-create duplicate guard. One case per row of the matrix, each
    // asserting BOTH the verdict and that nothing was created on a refusal.
    {
      const droot = mkdtempSync(join(tmpdir(), 'e2e-pub-guard-'))
      mkdirSync(join(droot, 'docs', 'prd', '00-x', 'tickets'), { recursive: true })
      writeFileSync(join(droot, 'docs', 'prd', '00-x', 'tickets', 'GRD-1.md'), ticket('GRD-1', 'Guarded'))
      const gl = (rows) => JSON.stringify(rows.map(([iid, state]) => ({ iid, title: '[GRD-1] Guarded', state, description: '' })))
      const run = (rows) => runPub(droot, ['docs/prd/00-x', '--platform', 'glab', '--create'], {
        GLAB_BIN: FAKE_GLAB, FAKE_GLAB_ISSUES_JSON: gl(rows),
      })
      try {
        eq(S, 'P20 single issue passes', run([[5, 'opened']]).status, 0)
        eq(S, 'P20 oldest open + rest closed passes (a repaired tracker)', run([[5, 'opened'], [90, 'closed']]).status, 0)
        eq(S, 'P20 all closed passes (delivered)', run([[5, 'closed'], [90, 'closed']]).status, 0)

        const twoOpen = run([[5, 'opened'], [90, 'opened']])
        eq(S, 'P21 two OPEN duplicates refuse', twoOpen.status, 1)
        check(S, 'P21 the refusal names both issue numbers', /#5/.test(twoOpen.stderr) && /#90/.test(twoOpen.stderr))
        check(S, 'P21 nothing was created', !/^\+ created/m.test(twoOpen.stdout))
        check(S, 'P21 the summary carries the machine-readable reason',
          Array.isArray(twoOpen.summary) && twoOpen.summary.some((e) => e.error === 'duplicate-issues-present'))

        // The subtle one: dedup would resolve to the CLOSED oldest, the resume filter
        // would drop the ticket, and the open issue would be orphaned forever.
        const orphan = run([[5, 'closed'], [90, 'opened']])
        eq(S, 'P22 oldest closed while a newer is open refuses', orphan.status, 1)
        check(S, 'P22 the refusal explains the orphaning', /orphan/.test(orphan.stderr))
        check(S, 'P22 nothing was created', !/^\+ created/m.test(orphan.stdout))
      } finally { rmSync(droot, { recursive: true, force: true }) }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
