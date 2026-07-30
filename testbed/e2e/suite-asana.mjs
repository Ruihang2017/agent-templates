// E2E for asana-sync.mjs (catalog issue #124): the deterministic Asana write path.
//
// Driven against a FAKE Asana API bound to 127.0.0.1 on an ephemeral port, injected via
// ASANA_API_BASE — the same test-double idiom as GH_BIN/GLAB_BIN in suite-publish. No
// network, no token, no Asana account.
//
// Two load-bearing groups, both written so they cannot pass vacuously:
//
//   FAIL-SOFT (A12/A13/A20). Asana is a reporting mirror, never a gate: an HTTP 500, a
//   missing token, and a missing config must each exit 0 with the failure named in
//   ASANA-SYNC-JSON.errors. That verdict is only meaningful because A16 proves the script
//   CAN exit 1 (bad invocation) and A7 proves a healthy run reports ok:true — otherwise
//   "exit 0" would just mean "never fails", which is the #83 lesson.
//
//   IDEMPOTENCE (A8/A9). A re-run must create nothing. Asserted on the fake's own task
//   count AND on its POST count, so a script that re-created and then deduped in its own
//   summary could not pass.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'asana'
const SCRIPT = fileURLToPath(new URL('../../integrations/asana/.claude/scripts/asana-sync.mjs', import.meta.url))

const TOKEN = 'fake-pat-do-not-use'
const WORKSPACE = '1200000000000001'
const REPO_TASK = '1201234567890123'

// ---------------------------------------------------------------------------
// fake Asana API
// ---------------------------------------------------------------------------

// mode: 'ok' | 'fail500' | 'rate-limit-once'
function startFake({ mode = 'ok', repoTaskParent = null } = {}) {
  let nextGid = 9000000000000001n
  const tasks = new Map()
  tasks.set(REPO_TASK, {
    gid: REPO_TASK,
    name: 'my-service (repo)',
    completed: false,
    workspace: { gid: WORKSPACE },
    parent: repoTaskParent,
    children: [],
    projects: [],
  })
  const counts = { GET: 0, POST: 0, PUT: 0, total: 0 }
  let rateLimited = false

  const server = createServer((req, res) => {
    counts.total++
    counts[req.method] = (counts[req.method] || 0) + 1

    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
      res.end(JSON.stringify(obj))
    }
    // Auth is checked so a script that forgot the header would fail loudly here rather
    // than silently "working" against the fake.
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { errors: [{ message: 'Not Authorized' }] })
    if (mode === 'fail500') return send(500, { errors: [{ message: 'Server Error' }] })
    if (mode === 'rate-limit-once' && !rateLimited) {
      rateLimited = true
      return send(429, { errors: [{ message: 'Too Many Requests' }] }, { 'Retry-After': '0' })
    }

    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const data = (() => { try { return JSON.parse(body).data } catch { return null } })()

      let m = path.match(/^\/tasks\/(\d+)\/subtasks$/)
      if (m) {
        const parent = tasks.get(m[1])
        if (!parent) return send(404, { errors: [{ message: 'Not Found' }] })
        if (req.method === 'GET') {
          return send(200, { data: parent.children.map((g) => {
            const t = tasks.get(g)
            return { gid: t.gid, name: t.name, completed: t.completed }
          }) })
        }
        if (req.method === 'POST') {
          const gid = String(nextGid++)
          tasks.set(gid, { gid, name: data.name, completed: false, workspace: { gid: WORKSPACE }, parent: { gid: parent.gid, name: parent.name }, children: [], projects: [] })
          parent.children.push(gid)
          return send(201, { data: { gid, name: data.name } })
        }
      }

      m = path.match(/^\/tasks\/(\d+)\/addProject$/)
      if (m && req.method === 'POST') {
        const t = tasks.get(m[1])
        if (!t) return send(404, { errors: [{ message: 'Not Found' }] })
        t.projects.push(data.project)
        return send(200, { data: {} })
      }

      m = path.match(/^\/tasks\/(\d+)$/)
      if (m) {
        const t = tasks.get(m[1])
        if (!t) return send(404, { errors: [{ message: 'Not Found' }] })
        if (req.method === 'GET') {
          return send(200, { data: { gid: t.gid, name: t.name, completed: t.completed, workspace: t.workspace, parent: t.parent } })
        }
        if (req.method === 'PUT') {
          if (data && typeof data.completed === 'boolean') t.completed = data.completed
          if (data && typeof data.name === 'string') t.name = data.name
          return send(200, { data: { gid: t.gid, name: t.name, completed: t.completed } })
        }
      }
      return send(404, { errors: [{ message: `no fake route for ${req.method} ${path}` }] })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        base: `http://127.0.0.1:${port}`,
        tasks,
        counts,
        stop: () => new Promise((r) => server.close(r)),
        // Every task whose name starts with "[key]", at any depth.
        byKey: (key) => [...tasks.values()].filter((t) => String(t.name).startsWith(`[${key}]`)),
        childrenOf: (gid) => (tasks.get(gid) ? tasks.get(gid).children.map((g) => tasks.get(g)) : []),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function makeRepo({ config = true, addProject = null, moduleTitle = 'Foundation' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-asana-'))
  const mod = join(root, 'docs', 'prd', '01-foundation')
  mkdirSync(join(mod, 'tickets'), { recursive: true })
  writeFileSync(join(mod, 'README.md'), `# ${moduleTitle}\n\nsub-PRD body\n`)
  for (const [id, title] of [['FND-1', 'Bootstrap the schema'], ['FND-2', 'Wire the health check']]) {
    writeFileSync(join(mod, 'tickets', `${id}.md`), `---\nid: ${id}\ntitle: ${title}\nmodule: 01-foundation\nblocked_by: []\n---\n\n# ${id}\n`)
  }
  if (config) {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'asana.json'), JSON.stringify({
      mode: 'task', repoTask: REPO_TASK, repoTaskName: 'my-service (repo)',
      workspace: WORKSPACE, addTicketsToProject: addProject,
    }, null, 2) + '\n')
  }
  return root
}

// ASYNC on purpose. spawnSync would BLOCK this process's event loop, so the fake server
// hosted here could never accept the child's connection — an instant deadlock, which is
// exactly how this suite first failed.
//
// `input` is always written, even when empty: `--issues -` does readFileSync(0), which
// blocks forever on an inherited terminal stdin. A closed pipe makes that a clean read.
function sync(cwd, args, { base, token = TOKEN, env = {}, input = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ASANA_API_BASE: base || '',
        ASANA_TOKEN: token,
        ASANA_MAX_RETRY_SLEEP_MS: '10',
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.stdin.end(input)
    // A hang here would otherwise stall the whole E2E run with no diagnosis.
    const killer = setTimeout(() => child.kill('SIGKILL'), 20000)
    child.on('close', (status) => {
      clearTimeout(killer)
      const line = stdout.split('\n').find((l) => l.startsWith('ASANA-SYNC-JSON: '))
      let json = null
      try { json = line ? JSON.parse(line.slice('ASANA-SYNC-JSON: '.length)) : null } catch {}
      resolve({ status, stdout, stderr, json, codes: json ? json.errors.map((e) => e.code) : [] })
    })
  })
}

const MOD = 'docs/prd/01-foundation'

export async function run() {
  // ---- exit-code contract: the ONLY exit 1 is bad invocation -------------
  {
    const root = makeRepo()
    try {
      const r = await sync(root, ['wat'], {})
      eq(S, 'A16 unknown verb exits 1 (bad invocation is the only exit 1)', r.status, 1)
      check(S, 'A16 usage is printed on stderr', /usage:/.test(r.stderr || ''))
      const r2 = await sync(root, ['sync'], {})
      eq(S, 'A17 missing <module-dir> exits 0 and reports it (fail-soft, not a crash)', r2.status, 0)
      check(S, 'A17 error code is missing-module-dir', r2.codes.includes('missing-module-dir'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  // ---- fail-soft: no token, no config -----------------------------------
  {
    const root = makeRepo()
    try {
      const r = await sync(root, ['sync', MOD, '--create'], { base: 'http://127.0.0.1:1', token: '' })
      eq(S, 'A20 missing ASANA_TOKEN exits 0 (Asana is never a gate)', r.status, 0)
      check(S, 'A20 error code is no-token', r.codes.includes('no-token'))
      check(S, 'A20 summary reports ok:false', r.json && r.json.ok === false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  {
    const root = makeRepo({ config: false })
    try {
      const r = await sync(root, ['check'], { base: 'http://127.0.0.1:1' })
      eq(S, 'A21 missing .claude/asana.json exits 0', r.status, 0)
      check(S, 'A21 error code is not-configured', r.codes.includes('not-configured'))
      check(S, 'A21 configured:false', r.json && r.json.configured === false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  {
    const root = makeRepo({ config: false })
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'asana.json'), '{ not json')
    try {
      const r = await sync(root, ['check'], { base: 'http://127.0.0.1:1' })
      eq(S, 'A22 unparseable config exits 0', r.status, 0)
      check(S, 'A22 error code is bad-config', r.codes.includes('bad-config'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  // ---- resolve: URL shapes, workspace from the API not the URL ----------
  {
    const fake = await startFake()
    const root = makeRepo({ config: false })
    try {
      const shapes = [
        [`https://app.asana.com/1/99999/project/55555/task/${REPO_TASK}`, 'current /1/<org>/project/<p>/task/<t>'],
        [`https://app.asana.com/1/99999/task/${REPO_TASK}`, 'short /1/<org>/task/<t>'],
        [`https://app.asana.com/0/55555/${REPO_TASK}`, 'legacy /0/<p>/<t>'],
        [`https://app.asana.com/0/55555/${REPO_TASK}/f`, 'legacy /0/<p>/<t>/f'],
        [REPO_TASK, 'bare gid'],
      ]
      for (const [url, label] of shapes) {
        const r = await sync(root, ['resolve', '--url', url], { base: fake.base })
        eq(S, `A3 resolve parses ${label}`, r.status, 0)
        check(S, `A3 resolve finds the task gid in ${label}`, r.json && r.json.items[0] && r.json.items[0].gid === REPO_TASK)
        // The org id in the UI URL (99999 / 55555) is NOT the API workspace gid.
        check(S, `A3 workspace comes from GET /tasks, not the URL (${label})`,
          r.json && r.json.items[0] && r.json.items[0].workspace === WORKSPACE)
      }
      const bad = await sync(root, ['resolve', '--url', 'https://example.com/nope'], { base: fake.base })
      eq(S, 'A3 unparseable URL exits 0', bad.status, 0)
      check(S, 'A3 unparseable URL reports unparseable-url', bad.codes.includes('unparseable-url'))
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // ---- configure: writes config, never a secret, refuses to clobber -----
  {
    const fake = await startFake()
    const root = makeRepo({ config: false })
    try {
      const r = await sync(root, ['configure', '--url', `https://app.asana.com/1/9/task/${REPO_TASK}`], { base: fake.base })
      eq(S, 'A4 configure exits 0', r.status, 0)
      check(S, 'A4 configure reports no errors', r.json && r.json.ok === true)
      const cfgPath = join(root, '.claude', 'asana.json')
      check(S, 'A4 configure wrote .claude/asana.json', existsSync(cfgPath))
      const raw = readFileSync(cfgPath, 'utf8')
      // The whole point of putting the write in the script: the token cannot reach disk.
      check(S, 'A4 config contains NO token value', !raw.includes(TOKEN))
      check(S, 'A4 config has no key that looks like a token', !/token/i.test(JSON.stringify(Object.keys(JSON.parse(raw)))))
      const cfg = JSON.parse(raw)
      eq(S, 'A4 config records repoTask', cfg.repoTask, REPO_TASK)
      eq(S, 'A4 config records the workspace from the API', cfg.workspace, WORKSPACE)
      eq(S, 'A4 config records mode:task (the chosen hierarchy)', cfg.mode, 'task')

      const again = await sync(root, ['configure', '--url', `https://app.asana.com/1/9/task/${REPO_TASK}`], { base: fake.base })
      eq(S, 'A5 re-configure without --force exits 0', again.status, 0)
      check(S, 'A5 re-configure without --force refuses', again.codes.includes('already-configured'))
      const forced = await sync(root, ['configure', '--url', `https://app.asana.com/1/9/task/${REPO_TASK}`, '--force', '--project', '777'], { base: fake.base })
      check(S, 'A5 --force repoints and succeeds', forced.json && forced.json.ok === true)
      eq(S, 'A5 --project lands in the config', JSON.parse(readFileSync(cfgPath, 'utf8')).addTicketsToProject, '777')
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // ---- dry-run writes nothing -------------------------------------------
  {
    const fake = await startFake()
    const root = makeRepo()
    try {
      const r = await sync(root, ['sync', MOD], { base: fake.base })
      eq(S, 'A6 dry-run exits 0', r.status, 0)
      eq(S, 'A6 dry-run created NOTHING in Asana', fake.counts.POST || 0, 0)
      eq(S, 'A6 dry-run still reports both tickets as planned', r.json.items.filter((i) => i.planned).length, 2)
      check(S, 'A6 dry-run reports the module as planned', r.json.module && r.json.module.planned === true)
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // ---- create, naming, idempotence --------------------------------------
  {
    const fake = await startFake()
    const root = makeRepo()
    try {
      const r = await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      eq(S, 'A7 sync --create exits 0', r.status, 0)
      check(S, 'A7 sync --create reports ok:true (a healthy run is distinguishable)', r.json.ok === true)

      const mods = fake.childrenOf(REPO_TASK)
      eq(S, 'A7 exactly one module subtask under the repo task', mods.length, 1)
      eq(S, 'A7 module subtask name uses [key] + the sub-PRD H1', mods[0].name, '[01-foundation] Foundation')
      const kids = fake.childrenOf(mods[0].gid)
      eq(S, 'A7 both tickets became sub-subtasks (3 levels deep)', kids.length, 2)
      eq(S, 'A7 ticket subtask name is "[id] title"', kids[0].name, '[FND-1] Bootstrap the schema')
      check(S, 'A7 no issue number when none was supplied', !kids[0].name.includes('#'))

      const posts = fake.counts.POST
      const r2 = await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      eq(S, 'A8 idempotent re-run exits 0', r2.status, 0)
      eq(S, 'A8 idempotent re-run issued NO further POSTs', fake.counts.POST, posts)
      eq(S, 'A8 idempotent re-run left the task count unchanged', fake.childrenOf(mods[0].gid).length, 2)
      eq(S, 'A8 re-run reports both tickets as existing', r2.json.items.filter((i) => i.gid && !i.created).length, 2)
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // ---- --issues renders #N, and a later run renames to pick it up -------
  {
    const fake = await startFake()
    const root = makeRepo()
    try {
      const summaryLine = 'PUBLISH-SUMMARY-JSON: ' + JSON.stringify([
        { id: 'FND-1', issue: 41 }, { id: 'FND-2', issue: 42 },
      ])
      writeFileSync(join(root, 'issues.txt'), summaryLine + '\n')

      // First create WITHOUT issue numbers, as happens when tickets are synced before
      // they are published — then a second run must converge the names.
      await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      const mods = fake.childrenOf(REPO_TASK)
      check(S, 'A9 pre-publish name has no issue number', !fake.childrenOf(mods[0].gid)[0].name.includes('#'))

      const r = await sync(root, ['sync', MOD, '--create', '--issues', 'issues.txt'], { base: fake.base })
      eq(S, 'A9 sync with --issues exits 0', r.status, 0)
      const names = fake.childrenOf(mods[0].gid).map((t) => t.name)
      check(S, 'A9 issue number appended to FND-1', names.includes('[FND-1] Bootstrap the schema · #41'))
      check(S, 'A9 issue number appended to FND-2', names.includes('[FND-2] Wire the health check · #42'))
      eq(S, 'A9 renaming created no duplicate subtasks', fake.childrenOf(mods[0].gid).length, 2)
      eq(S, 'A9 both were reported as renamed', r.json.items.filter((i) => i.renamed).length, 2)

      // Accepting the PUBLISH-SUMMARY-JSON prefix means a caller can pipe publish-tickets
      // stdout straight in. Proven by piping a REAL-shaped stdout, not a bare array.
      const piped = await sync(root, ['sync', MOD, '--issues', '-'], {
        base: fake.base,
        input: `platform: gh\n+ created FND-1\n${summaryLine}\n`,
      })
      eq(S, 'A9 --issues - reads the summary from stdin', piped.status, 0)
      check(S, 'A9 --issues - parsed it (no error reported)', piped.json.ok === true)
      check(S, 'A9 --issues - resolved the same names, so nothing needed renaming',
        piped.json.items.every((i) => !i.renamed))
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // ---- complete ---------------------------------------------------------
  {
    const fake = await startFake()
    const root = makeRepo()
    try {
      await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      const mods = fake.childrenOf(REPO_TASK)

      const dry = await sync(root, ['complete', 'FND-1'], { base: fake.base })
      eq(S, 'A10 complete dry-run exits 0', dry.status, 0)
      check(S, 'A10 complete dry-run did NOT complete anything',
        fake.childrenOf(mods[0].gid).every((t) => t.completed === false))

      const r = await sync(root, ['complete', 'FND-1', '--create'], { base: fake.base })
      eq(S, 'A10 complete --create exits 0', r.status, 0)
      const fnd1 = fake.byKey('FND-1')[0]
      eq(S, 'A10 the ticket subtask is now completed', fnd1.completed, true)
      check(S, 'A10 only the named ticket was completed', fake.byKey('FND-2')[0].completed === false)

      const twice = await sync(root, ['complete', 'FND-1', '--create'], { base: fake.base })
      check(S, 'A10 completing twice is not an error', twice.json.ok === true)
      check(S, 'A10 the second completion is reported as already-complete', twice.json.items[0].alreadyCompleted === true)

      const missing = await sync(root, ['complete', 'NOPE-9', '--create'], { base: fake.base })
      eq(S, 'A11 completing an unsynced ticket exits 0', missing.status, 0)
      check(S, 'A11 it reports ticket-subtask-missing', missing.codes.includes('ticket-subtask-missing'))
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // ---- fail-soft on a broken API ---------------------------------------
  {
    const fake = await startFake({ mode: 'fail500' })
    const root = makeRepo()
    try {
      const r = await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      eq(S, 'A12 HTTP 500 exits 0 (fail-soft, so a delivered ticket never fails on Asana)', r.status, 0)
      check(S, 'A12 the failure is reported, not swallowed', r.codes.includes('asana-unavailable'))
      check(S, 'A12 summary reports ok:false', r.json.ok === false)
      check(S, 'A12 the JSON summary line is still emitted on the error path', r.json !== null)
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // ---- 429 is retried, and the retry is proven to have happened --------
  {
    const fake = await startFake({ mode: 'rate-limit-once' })
    const root = makeRepo()
    try {
      const r = await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      eq(S, 'A13 a 429 with Retry-After is retried and the run succeeds', r.status, 0)
      check(S, 'A13 the run reports ok:true after the retry', r.json.ok === true)
      // Non-vacuous: the first request was rejected, so a script that did NOT retry
      // would have produced fewer requests and no module subtask.
      check(S, 'A13 the retry actually happened (more requests than the happy path)', fake.counts.total > 1)
      eq(S, 'A13 the module subtask exists despite the 429', fake.childrenOf(REPO_TASK).length, 1)
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // ---- ambiguity is refused, not guessed -------------------------------
  {
    const fake = await startFake()
    const root = makeRepo()
    try {
      await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      const mods = fake.childrenOf(REPO_TASK)
      // A hand-made subtask that MENTIONS [FND-1] without it being a prefix, and rename
      // the real one away, so no clean prefix remains. Completing the wrong task later is
      // the risk this guards.
      const real = fake.byKey('FND-1')[0]
      real.name = 'see [FND-1] for context'
      const r = await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      eq(S, 'A14 an ambiguous name exits 0', r.status, 0)
      check(S, 'A14 ambiguity is reported', r.codes.includes('ambiguous-ticket'))
      check(S, 'A14 nothing was created for the ambiguous ticket',
        fake.childrenOf(mods[0].gid).filter((t) => t.name.startsWith('[FND-1]')).length === 0)
      const c = await sync(root, ['complete', 'FND-1', '--create'], { base: fake.base })
      check(S, 'A14 complete refuses an ambiguous match rather than guessing', c.codes.includes('ambiguous-ticket'))
      check(S, 'A14 the ambiguous task was NOT completed', real.completed === false)
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // ---- addTicketsToProject mitigation ----------------------------------
  {
    const fake = await startFake()
    const root = makeRepo({ addProject: '4242' })
    try {
      const r = await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      eq(S, 'A15 sync with addTicketsToProject exits 0', r.status, 0)
      const kids = fake.childrenOf(fake.childrenOf(REPO_TASK)[0].gid)
      check(S, 'A15 every ticket subtask was added to the project', kids.every((t) => t.projects.includes('4242')))
      check(S, 'A15 the module subtask was NOT added to the project', !fake.childrenOf(REPO_TASK)[0].projects.includes('4242'))
      check(S, 'A15 the summary records the project it was added to', r.json.items.every((i) => i.addedToProject === '4242'))
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // ---- check / status --------------------------------------------------
  {
    const fake = await startFake()
    const root = makeRepo()
    try {
      const c = await sync(root, ['check'], { base: fake.base })
      eq(S, 'A18 check exits 0 when configured and reachable', c.status, 0)
      check(S, 'A18 check reports configured:true and ok:true', c.json.configured === true && c.json.ok === true)
      eq(S, 'A18 check made no writes', fake.counts.POST || 0, 0)

      await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      await sync(root, ['complete', 'FND-1', '--create'], { base: fake.base })
      const st = await sync(root, ['status', MOD], { base: fake.base })
      eq(S, 'A19 status exits 0', st.status, 0)
      eq(S, 'A19 status reports the module', st.json.items.length, 1)
      eq(S, 'A19 status counts the completed ticket', st.json.items[0].tickets.filter((t) => t.completed).length, 1)
      eq(S, 'A19 status counts both tickets', st.json.items[0].tickets.length, 2)

      const none = await sync(root, ['status', 'docs/prd/99-absent'], { base: fake.base })
      check(S, 'A19 status on an unsynced module reports module-subtask-missing', none.codes.includes('module-subtask-missing'))
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // ---- no tickets dir --------------------------------------------------
  {
    const fake = await startFake()
    const root = makeRepo()
    try {
      const r = await sync(root, ['sync', 'docs/prd/nope', '--create'], { base: fake.base })
      eq(S, 'A23 a missing tickets directory exits 0', r.status, 0)
      check(S, 'A23 it reports no-tickets-dir', r.codes.includes('no-tickets-dir'))
      eq(S, 'A23 nothing was created', fake.counts.POST || 0, 0)
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }
}
