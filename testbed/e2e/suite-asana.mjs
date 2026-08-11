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

import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'asana'
const SCRIPT = fileURLToPath(new URL('../../integrations/asana/.claude/scripts/asana-sync.mjs', import.meta.url))
// The deliver->Asana wiring (issue #126) is exercised HERE rather than in suite-deliver,
// because that suite is spawnSync-based and would deadlock against an in-process fake.
const DELIVER = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/deliver-ticket.mjs', import.meta.url))
const FAKE_GH = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url))

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
          // Real pagination (catalog issue #176). This route used to return every child in
          // one response, so the truncation bug it exists to catch could never occur here:
          // the script asked for limit=100, the fake ignored it, and 250 subtasks came back
          // looking complete. A fake that is more capable than the API hides the defect.
          const all = parent.children.map((g) => {
            const t = tasks.get(g)
            return { gid: t.gid, name: t.name, completed: t.completed }
          })
          const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100)
          const offset = Number(url.searchParams.get('offset') || 0)

          // Servers that mishandle pagination, both of which the script must DETECT rather
          // than quietly under-report:
          //   no-paginate  full page, no next_page — indistinguishable from a complete
          //                list unless you refuse to guess
          //   stuck-offset hands back a token but always serves page 1 — an infinite loop
          //                for any client that trusts the token
          if (mode === 'no-paginate') return send(200, { data: all.slice(0, limit) })
          if (mode === 'stuck-offset') {
            return send(200, { data: all.slice(0, limit), next_page: { offset: 'always-the-same', path, uri: path } })
          }

          const page = all.slice(offset, offset + limit)
          const more = offset + limit < all.length
          return send(200, {
            data: page,
            ...(more ? { next_page: { offset: String(offset + limit), path, uri: path } } : {}),
          })
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

// ---------------------------------------------------------------------------
// deliver-ticket wiring harness (issue #126)
// ---------------------------------------------------------------------------

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

// A deliverable repo that ALSO carries the Asana integration installed, mirroring what
// adopt.mjs produces. `config: false` models the overwhelmingly common case: a repo that
// never connected Asana, which must pay nothing.
// `conflict: true` makes the merge FAIL while still reaching deliver's step 4. That
// distinction is load-bearing: pointing at a nonexistent branch aborts far earlier, so it
// exercises nothing about the mirror's landed-gate (W3 was vacuous that way at first).
function makeDeliverRepo({ config = true, conflict = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-asana-deliver-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'e2e@example.com'])
  git(repo, ['config', 'user.name', 'E2E'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'README.md'), 'base\n')
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
  writeFileSync(join(repo, 'docs', 'plans', 'FND-1.md'), 'plan\n')
  // the module tree, so `sync` has tickets and `status` has something to report
  mkdirSync(join(repo, 'docs', 'prd', '01-foundation', 'tickets'), { recursive: true })
  writeFileSync(join(repo, 'docs', 'prd', '01-foundation', 'README.md'), '# Foundation\n')
  for (const [id, title] of [['FND-1', 'Bootstrap the schema'], ['FND-2', 'Wire the health check']]) {
    writeFileSync(join(repo, 'docs', 'prd', '01-foundation', 'tickets', `${id}.md`),
      `---\nid: ${id}\ntitle: ${title}\nmodule: 01-foundation\nblocked_by: []\n---\n\n# ${id}\n`)
  }
  // the integration as installed by adopt
  mkdirSync(join(repo, '.claude', 'scripts'), { recursive: true })
  cpSync(SCRIPT, join(repo, '.claude', 'scripts', 'asana-sync.mjs'))
  if (config) {
    writeFileSync(join(repo, '.claude', 'asana.json'), JSON.stringify({
      mode: 'task', repoTask: REPO_TASK, workspace: WORKSPACE, addTicketsToProject: null,
    }, null, 2) + '\n')
  }
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])
  const origin = join(root, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin], { encoding: 'utf8' })
  git(repo, ['remote', 'add', 'origin', origin])
  git(repo, ['push', '-q', '-u', 'origin', 'main'])
  git(repo, ['checkout', '-q', '-b', 'ticket/FND-1'])
  writeFileSync(join(repo, 'feature.txt'), 'feature\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', '[FND-1] feature'])
  git(repo, ['checkout', '-q', 'main'])
  if (conflict) {
    // same file, different content, on main -> the --no-ff merge cannot resolve
    writeFileSync(join(repo, 'feature.txt'), 'conflicting content on main\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'conflicting change on main'])
    git(repo, ['push', '-q', 'origin', 'main'])
  }
  return { root, repo }
}

function deliver(repo, args, { base, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DELIVER, ...args], {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GH_BIN: `node ${FAKE_GH}`,
        FAKE_GH_CLOSED_STATE: '1',
        ASANA_API_BASE: base || '',
        ASANA_TOKEN: TOKEN,
        ASANA_MAX_RETRY_SLEEP_MS: '10',
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.stdin.end('')
    const killer = setTimeout(() => child.kill('SIGKILL'), 40000)
    child.on('close', (status) => {
      clearTimeout(killer)
      const line = stdout.split('\n').reverse().find((l) => l.startsWith('DELIVER-SUMMARY-JSON: '))
      let sum = null
      try { sum = line ? JSON.parse(line.slice('DELIVER-SUMMARY-JSON: '.length)) : null } catch {}
      resolve({ status, stdout, stderr, sum })
    })
  })
}

const DELIVER_ARGS = ['--id', 'FND-1', '--branch', 'ticket/FND-1', '--issue', '7', '--delivery', 'direct']

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

  // ---- deliver -> Asana wiring (issue #126) ----------------------------
  //
  // W2 is the one that matters: dodPassed must be BIT-IDENTICAL with Asana healthy and
  // with Asana returning 500. Comparing the two runs is what makes "Asana is not in the
  // DoD" a tested property instead of a promise in a comment.
  {
    const fake = await startFake()
    const { root, repo } = makeDeliverRepo()
    try {
      await sync(repo, ['sync', MOD, '--create'], { base: fake.base })
      check(S, 'W1 setup: the ticket subtask starts incomplete', fake.byKey('FND-1')[0].completed === false)

      const d = await deliver(repo, DELIVER_ARGS, { base: fake.base })
      eq(S, 'W1 delivery exits 0', d.status, 0)
      check(S, 'W1 delivery merged and closed the issue', d.sum.merged === true && d.sum.issueClosed === true)
      check(S, 'W1 dodPassed', d.sum.dodPassed === true)
      check(S, 'W1 the Asana subtask was completed by the deliver step', fake.byKey('FND-1')[0].completed === true)
      check(S, 'W1 the sibling ticket was NOT completed', fake.byKey('FND-2')[0].completed === false)
      check(S, 'W1 the mirror outcome is reported in the summary', d.sum.asana && d.sum.asana.ok === true)
      check(S, 'W1 no Asana note polluted a clean delivery', !/Asana mirror:/.test(d.sum.notes || ''))
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }
  {
    // Same delivery, Asana broken. dodPassed must not move.
    const healthy = await startFake()
    const a = makeDeliverRepo()
    let dodHealthy = null
    try {
      await sync(a.repo, ['sync', MOD, '--create'], { base: healthy.base })
      dodHealthy = (await deliver(a.repo, DELIVER_ARGS, { base: healthy.base })).sum
    } finally { await healthy.stop(); rmSync(a.root, { recursive: true, force: true }) }

    const broken = await startFake({ mode: 'fail500' })
    const b = makeDeliverRepo()
    try {
      const d = await deliver(b.repo, DELIVER_ARGS, { base: broken.base })
      eq(S, 'W2 delivery still exits 0 with Asana returning 500', d.status, 0)
      check(S, 'W2 the ticket is still delivered', d.sum.merged === true && d.sum.issueClosed === true)
      eq(S, 'W2 dodPassed is IDENTICAL to the Asana-healthy run (mirror is never a gate)',
        d.sum.dodPassed, dodHealthy.dodPassed)
      check(S, 'W2 dodPassed is actually true in both, so the comparison is not two falses',
        dodHealthy.dodPassed === true)
      check(S, 'W2 the Asana failure is reported, not swallowed', d.sum.asana && d.sum.asana.ok === false)
      check(S, 'W2 the failure reaches notes so escalation carries it', /Asana mirror:/.test(d.sum.notes || ''))
    } finally { await broken.stop(); rmSync(b.root, { recursive: true, force: true }) }
  }
  {
    // Not delivered must not complete the subtask — the same rule closeIssue follows,
    // for the same reason: a completed subtask would report delivery that never happened.
    //
    // A CONFLICTING merge, not a missing branch: the run must actually reach step 4 with
    // landed=false, or this asserts nothing about the gate. Verified by deleting the gate
    // and watching W3 fail.
    const fake = await startFake()
    const { root, repo } = makeDeliverRepo({ conflict: true })
    try {
      await sync(repo, ['sync', MOD, '--create'], { base: fake.base })
      const d = await deliver(repo, DELIVER_ARGS, { base: fake.base })
      check(S, 'W3 the conflicting merge did not land', d.sum && d.sum.merged === false)
      check(S, 'W3 the run reached the bookkeeping stage (so the gate was exercised)',
        d.sum !== null && /skipping tracker close/.test(d.sum.notes || ''))
      check(S, 'W3 an unlanded merge leaves the Asana subtask INCOMPLETE', fake.byKey('FND-1')[0].completed === false)
      check(S, 'W3 dodPassed is false, and not because of Asana', d.sum.dodPassed === false)
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }
  {
    // The common case: not connected. Must cost nothing at all.
    const fake = await startFake()
    const { root, repo } = makeDeliverRepo({ config: false })
    try {
      const before = fake.counts.total
      const d = await deliver(repo, DELIVER_ARGS, { base: fake.base })
      eq(S, 'W4 delivery exits 0 without an Asana config', d.status, 0)
      check(S, 'W4 the ticket is delivered normally', d.sum.dodPassed === true)
      eq(S, 'W4 an unconfigured repo makes ZERO Asana requests', fake.counts.total, before)
      check(S, 'W4 summary reports asana:null, not a fabricated failure', d.sum.asana === null)
      check(S, 'W4 no Asana note was added', !/[Aa]sana/.test(d.sum.notes || ''))
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }
  {
    // Configured, but the ticket was never synced: report it, do not invent success.
    const fake = await startFake()
    const { root, repo } = makeDeliverRepo()
    try {
      const d = await deliver(repo, DELIVER_ARGS, { base: fake.base })
      check(S, 'W5 delivery still succeeds when the subtask was never created', d.sum.dodPassed === true)
      check(S, 'W5 the missing subtask is reported', d.sum.asana && d.sum.asana.ok === false &&
        d.sum.asana.errors.some((e) => e.code === 'ticket-subtask-missing'))
      check(S, 'W5 it names the repair in notes', /asana-sync/.test(d.sum.notes || ''))
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

  // ---- A24 (issue #176): the subtask list must be paginated in FULL ------
  //
  // Asana caps a page at 100. The old code asked for limit=100 and stopped, and `api()`
  // discarded `next_page` entirely — so a parent with more than 100 subtasks returned a
  // TRUNCATED list, and every caller treats "not in the list" as "does not exist yet" and
  // creates it. Same defect as catalog issue #132, which produced 43 duplicate issues on a
  // 44-ticket repo, arriving through a different API.
  {
    const fake = await startFake()
    const root = makeRepo()
    try {
      // 250 existing module subtasks — well past one page, and past two.
      const names = []
      for (let i = 1; i <= 250; i++) {
        const name = `[MOD-${String(i).padStart(3, '0')}] module ${i}`
        names.push(name)
        const gid = String(900000 + i)
        fake.tasks.set(gid, { gid, name, completed: false, workspace: { gid: WORKSPACE }, parent: { gid: REPO_TASK }, children: [], projects: [] })
        fake.tasks.get(REPO_TASK).children.push(gid)
      }
      const r = await sync(root, ['status'], { base: fake.base })
      eq(S, 'A24 status exits 0 across three pages', r.status, 0)
      eq(S, 'A24 every subtask is listed, not just the first page', r.json && r.json.items.length, 250)
      // non-vacuous: a truncating client would report exactly the page size, so name the
      // wrong answer the old code gave
      check(S, 'A24 it did not stop at one page', r.json && r.json.items.length !== 100)
      const gids = new Set((r.json.items || []).map((i) => i.gid))
      eq(S, 'A24 no subtask is double-counted', gids.size, 250)
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // A25: the harm itself — a module past the first page must NOT be recreated.
  {
    const fake = await startFake()
    const root = makeRepo()
    try {
      // 150 filler modules, then the one this repo's fixture actually syncs. It sits
      // beyond the first page, which is exactly where the old code stopped looking.
      for (let i = 1; i <= 150; i++) {
        const gid = String(800000 + i)
        fake.tasks.set(gid, { gid, name: `[FILL-${i}] filler`, completed: false, workspace: { gid: WORKSPACE }, parent: { gid: REPO_TASK }, children: [], projects: [] })
        fake.tasks.get(REPO_TASK).children.push(gid)
      }
      const first = await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      eq(S, 'A25 first sync exits 0', first.status, 0)
      const afterFirst = fake.childrenOf(REPO_TASK).filter((t) => String(t.name).startsWith('[01-foundation]')).length
      eq(S, 'A25 the module subtask was created once', afterFirst, 1)

      // Re-run. The module is now the 151st child — past page 1. A truncating client
      // cannot see it and creates a second one.
      const second = await sync(root, ['sync', MOD, '--create'], { base: fake.base })
      eq(S, 'A25 second sync exits 0', second.status, 0)
      const afterSecond = fake.childrenOf(REPO_TASK).filter((t) => String(t.name).startsWith('[01-foundation]')).length
      eq(S, 'A25 re-running created NO duplicate past the first page', afterSecond, 1)
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // A26: a server that does not paginate must FAIL, not be believed. A full page with no
  // continuation token is indistinguishable from a complete list, and guessing is the bug.
  {
    const fake = await startFake({ mode: 'no-paginate' })
    const root = makeRepo()
    try {
      for (let i = 1; i <= 120; i++) {
        const gid = String(700000 + i)
        fake.tasks.set(gid, { gid, name: `[X-${i}] x`, completed: false, workspace: { gid: WORKSPACE }, parent: { gid: REPO_TASK }, children: [], projects: [] })
        fake.tasks.get(REPO_TASK).children.push(gid)
      }
      const r = await sync(root, ['status'], { base: fake.base })
      check(S, 'A26 a non-paginating server is reported, not trusted',
        JSON.stringify(r.json || {}).includes('no next_page') || (r.codes || []).length > 0,
        JSON.stringify(r.json))
      check(S, 'A26 it does not silently report a short list',
        !(r.json && r.json.items && r.json.items.length === 100))
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }

  // A27: a server whose offset never advances must fail rather than loop forever. An
  // unattended run that never ends is worse than one that stops with a reason.
  {
    const fake = await startFake({ mode: 'stuck-offset' })
    const root = makeRepo()
    try {
      for (let i = 1; i <= 120; i++) {
        const gid = String(600000 + i)
        fake.tasks.set(gid, { gid, name: `[Y-${i}] y`, completed: false, workspace: { gid: WORKSPACE }, parent: { gid: REPO_TASK }, children: [], projects: [] })
        fake.tasks.get(REPO_TASK).children.push(gid)
      }
      const r = await sync(root, ['status'], { base: fake.base })
      check(S, 'A27 an ignored offset is reported rather than looped on',
        JSON.stringify(r.json || {}).includes('offset appears to be ignored') || (r.codes || []).length > 0,
        JSON.stringify(r.json))
    } finally { await fake.stop(); rmSync(root, { recursive: true, force: true }) }
  }
}
