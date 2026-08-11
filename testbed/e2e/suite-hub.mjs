// E2E for the hub-and-spoke pattern's deterministic half: the file firewall, the brief
// dispatch gate, the driver (against a controllable stand-in executor), and the collect
// gate. Zero tokens, zero network.
//
// Every assertion here is written to be able to FAIL. Where a check could pass for an
// unrelated reason, it is paired with a sentinel that must NOT pass — this repo has
// shipped vacuous gates before (catalog issues #109, #115, #119, #127, #132, #141, #143)
// and a green check over an artifact that never arrived is its recurring failure class.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'
import { DEFAULT_DENY, auditPaths, globMatch, isDenied } from '../../patterns/hub-and-spoke-orchestrator-executors/scaffold/.claude/scripts/firewall.mjs'
import { danglingDeps, findCycle, globsIntersect, parseBrief, readyBriefs, scopeConflicts, validateBrief } from '../../patterns/hub-and-spoke-orchestrator-executors/scaffold/.claude/scripts/brief.mjs'

const S = 'hub'
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SCAFFOLD = join(REPO, 'patterns', 'hub-and-spoke-orchestrator-executors', 'scaffold')
const FAKE_CODEX = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))

// --------------------------------------------------------------------------- helpers

function sh(cmd, args, opts = {}) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { encoding: 'utf8', ...opts })
    let out = '', err = ''
    p.stdout?.on('data', (d) => { out += d })
    p.stderr?.on('data', (d) => { err += d })
    p.on('error', (e) => res({ status: null, out, err: String(e.message) }))
    p.on('close', (status) => res({ status, out, err }))
  })
}

const brief = ({ id, blocked_by = [], scope = ['src/**'], test_cmd = 'node ./check.mjs', sections = {} }) => {
  const s = {
    contract: 'export function f(): number', deliverables: '1. add f()', 'done when': 'f() returns 1', ...sections,
  }
  return [
    '---',
    `id: ${id}`,
    `title: implement ${id}`,
    `blocked_by: [${blocked_by.join(', ')}]`,
    'file_scope:',
    ...scope.map((g) => `  - ${g}`),
    `test_cmd: ${test_cmd}`,
    '---',
    '',
    `# ${id}`,
    '',
    ...Object.entries(s).flatMap(([k, v]) => (v === null ? [] : [`## ${k}`, '', v, ''])),
  ].join('\n')
}

/** A throwaway git repo with a driver, briefs, and a controllable executor. */
async function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-hub-'))
  mkdirSync(join(dir, '.claude', 'scripts'), { recursive: true })
  for (const f of ['firewall.mjs', 'brief.mjs', 'dispatch-spokes.mjs', 'collect.mjs']) {
    writeFileSync(join(dir, '.claude', 'scripts', f), readFileSync(join(SCAFFOLD, '.claude', 'scripts', f), 'utf8'))
  }
  mkdirSync(join(dir, 'docs', 'briefs'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'seed\n')
  // the project's own "test suite": passes iff src/ok.txt exists with the right content
  writeFileSync(join(dir, 'check.mjs'), `
import { existsSync, readFileSync } from 'node:fs'
const p = new URL('./src/ok.txt', import.meta.url)
process.exit(existsSync(p) && readFileSync(p, 'utf8').trim() === 'ok' ? 0 : 1)
`)
  const g = (args) => sh('git', args, { cwd: dir })
  await g(['init', '-q', '-b', 'main'])
  await g(['config', 'user.email', 'e2e@local'])
  await g(['config', 'user.name', 'e2e'])
  await g(['add', '-A'])
  await g(['commit', '-qm', 'seed'])
  // Harness scratch (the executor scenario, its invocation log) lives OUTSIDE the repo.
  // Inside, it would leave the working tree dirty and collect.mjs would correctly refuse
  // to merge — a real behaviour, failing for a reason that has nothing to do with the
  // code under test.
  const side = mkdtempSync(join(tmpdir(), 'e2e-hub-side-'))
  return { dir, side, g }
}

/**
 * Commit whatever the test just staged into the repo.
 *
 * Briefs are committed artifacts in real use — `/hub-brief` writes them, a human signs
 * them off at Gate 1, and they go in. Leaving them untracked here would make
 * `collect.mjs --merge` refuse on a dirty working tree, which is correct behaviour
 * failing for a reason unrelated to what the test is measuring.
 */
const commitAll = async (dir) => {
  await sh('git', ['add', '-A'], { cwd: dir })
  await sh('git', ['commit', '-qm', 'briefs'], { cwd: dir })
}

const dispatch = async (dir, args, script) => {
  await commitAll(dir)
  return sh(process.execPath, [join(dir, '.claude', 'scripts', 'dispatch-spokes.mjs'), ...args], {
    cwd: dir,
    env: { ...process.env, FAKE_CODEX_SCRIPT: script, FAKE_CODEX_LOG: script.replace(/script\.json$/, 'codex.log') },
  })
}

const collect = (dir, args) =>
  sh(process.execPath, [join(dir, '.claude', 'scripts', 'collect.mjs'), ...args], { cwd: dir })

// --------------------------------------------------------------------------- suite

export async function run() {
  // ======================================================================= firewall

  check(S, 'glob ** spans directories', globMatch('src/**', 'src/a/b/c.js'))
  check(S, 'glob * does not span directories', !globMatch('src/*', 'src/a/b.js'))
  check(S, 'glob **/ matches zero segments', globMatch('src/**/x.js', 'src/x.js'))
  // the exact regression the character-scanner rewrite fixed: a replace-chain matcher
  // makes `src/**` match the bare directory only, so every file under it reads
  // out-of-scope and the whole pattern quarantines everything.
  check(S, 'glob src/** matches a direct child', globMatch('src/**', 'src/a.js'))
  check(S, 'glob is anchored at both ends', !globMatch('src/*.js', 'lib/src/a.js') && !globMatch('a.js', 'a.js.bak'))

  check(S, 'deny matches a lockfile at the repo root', isDenied('package-lock.json'))
  check(S, 'deny matches a lockfile at any depth', isDenied('services/api/package.json'))
  check(S, 'deny covers CI config by path', isDenied('.github/workflows/test.yml'))
  check(S, 'deny covers the agent harness itself', isDenied('.claude/settings.json'))
  check(S, 'deny covers dotenv variants', isDenied('.env') && isDenied('.env.production'))
  // non-vacuous: ordinary source must NOT be denied, or every audit would "pass" by
  // quarantining everything and the deny list would be indistinguishable from a block-all
  check(S, 'deny does not match ordinary source', !isDenied('src/app.ts') && !isDenied('src/lib/go.modifier.ts'))
  check(S, 'deny list is non-empty', DEFAULT_DENY.length > 10)

  eq(S, 'audit passes an in-scope change', auditPaths(['src/a.js'], { scope: ['src/**'] }).ok, true)
  eq(S, 'audit flags an out-of-scope change', auditPaths(['lib/a.js'], { scope: ['src/**'] }).outOfScope, ['lib/a.js'])
  eq(S, 'audit flags a denied change', auditPaths(['go.mod'], { scope: ['**'] }).denied, ['go.mod'])
  // the ordering rule: deny is checked before scope, so a scope of `**` cannot launder a
  // lockfile edit into an in-scope change
  eq(S, 'a repo-wide scope cannot launder a denied path', auditPaths(['yarn.lock'], { scope: ['**'] }).ok, false)
  // fail-closed: this is the assertion that would flip if someone "fixed" the empty-scope
  // case by treating it as permissive
  eq(S, 'a missing scope allows nothing (fail closed)', auditPaths(['src/a.js'], {}).outOfScope, ['src/a.js'])
  eq(S, 'an empty scope allows nothing (fail closed)', auditPaths(['src/a.js'], { scope: [] }).outOfScope, ['src/a.js'])
  eq(S, 'denied and out-of-scope stay distinguishable',
    (() => { const r = auditPaths(['go.mod', 'lib/x.js'], { scope: ['src/**'] }); return [r.denied, r.outOfScope] })(),
    [['go.mod'], ['lib/x.js']])

  // ==================================================================== brief gate

  const ok = parseBrief(brief({ id: 'FND-01' }), 'FND-01.md')
  eq(S, 'a complete brief validates clean', validateBrief(ok), [])
  eq(S, 'brief frontmatter list parsed', ok.data.file_scope, ['src/**'])

  const errs = (md, name = 'x.md') => validateBrief(parseBrief(md, name)).join(' | ')
  check(S, 'brief without a contract section is rejected',
    /## contract/.test(errs(brief({ id: 'FND-01', sections: { contract: null } }))))
  check(S, 'brief with an EMPTY contract section is rejected',
    /## contract/.test(errs(brief({ id: 'FND-01', sections: { contract: '' } }))))
  check(S, 'brief with a repo-wide scope is rejected', /whole repo/.test(errs(brief({ id: 'FND-01', scope: ['**'] }))))
  check(S, 'brief scoping a denied path is rejected', /deny list/.test(errs(brief({ id: 'FND-01', scope: ['package.json'] }))))
  check(S, 'brief without test_cmd is rejected', /test_cmd/.test(errs(brief({ id: 'FND-01', test_cmd: '' }))))
  check(S, 'brief with a malformed id is rejected', /MOD-NN/.test(errs(brief({ id: 'lowercase-1' }))))
  check(S, 'brief with no frontmatter is rejected', /no frontmatter/.test(errs('# just a heading')))

  const graph = [
    parseBrief(brief({ id: 'A-1' }), 'a.md'),
    parseBrief(brief({ id: 'A-2', blocked_by: ['A-1'] }), 'b.md'),
  ]
  eq(S, 'dangling deps: none in a sound graph', danglingDeps(graph), [])
  eq(S, 'dangling deps detected', danglingDeps([parseBrief(brief({ id: 'A-3', blocked_by: ['NOPE-9'] }), 'c.md')]),
    [{ id: 'A-3', missing: 'NOPE-9' }])
  eq(S, 'no cycle in a sound graph', findCycle(graph), null)
  check(S, 'cycle detected', Array.isArray(findCycle([
    parseBrief(brief({ id: 'C-1', blocked_by: ['C-2'] }), 'a.md'),
    parseBrief(brief({ id: 'C-2', blocked_by: ['C-1'] }), 'b.md'),
  ])))
  eq(S, 'ready wave respects blocked_by', readyBriefs(graph, []).map((b) => b.data.id), ['A-1'])
  eq(S, 'ready wave opens once the dep is done', readyBriefs(graph, ['A-1']).map((b) => b.data.id), ['A-2'])

  check(S, 'globs intersect when they can', globsIntersect('src/**', 'src/api/x.js'))
  check(S, 'globs do not intersect when they cannot', !globsIntersect('src/**', 'lib/**'))
  eq(S, 'unordered briefs with overlapping scope are flagged',
    scopeConflicts([
      parseBrief(brief({ id: 'X-1', scope: ['src/**'] }), 'a.md'),
      parseBrief(brief({ id: 'X-2', scope: ['src/api/**'] }), 'b.md'),
    ]).map((c) => [c.a, c.b]), [['X-1', 'X-2']])
  // ordering makes the same overlap safe — without this the report would flag every
  // dependent pair and be ignored in practice
  eq(S, 'ordered briefs with overlapping scope are not flagged',
    scopeConflicts([
      parseBrief(brief({ id: 'X-1', scope: ['src/**'] }), 'a.md'),
      parseBrief(brief({ id: 'X-2', scope: ['src/api/**'], blocked_by: ['X-1'] }), 'b.md'),
    ]), [])
  // transitive ordering, A -> B -> C: A and C are ordered although neither names the other
  eq(S, 'transitively ordered briefs are not flagged',
    scopeConflicts([
      parseBrief(brief({ id: 'T-1', scope: ['src/**'] }), 'a.md'),
      parseBrief(brief({ id: 'T-2', scope: ['other/**'], blocked_by: ['T-1'] }), 'b.md'),
      parseBrief(brief({ id: 'T-3', scope: ['src/api/**'], blocked_by: ['T-2'] }), 'c.md'),
    ]), [])

  // ====================================================================== driver

  {
    const { dir, side } = await makeRepo()
    try {
      // one valid brief, one invalid — the gate must dispatch NOTHING
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-01.md'), brief({ id: 'FND-01' }))
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-02.md'), brief({ id: 'FND-02', scope: ['**'] }))
      writeFileSync(join(side, 'script.json'), JSON.stringify({ default: { write: { 'src/ok.txt': 'ok' } } }))
      const r = await dispatch(dir, ['--briefs', 'docs/briefs', '--codex', FAKE_CODEX], join(side, 'script.json'))
      eq(S, 'an invalid brief set exits 2', r.status, 2)
      check(S, 'the gate names the offending brief', /FND-02/.test(r.err))
      check(S, 'nothing was dispatched — no worktree exists', !existsSync(join(dir, '.claude', 'worktrees')))
      check(S, 'nothing was dispatched — no spoke branch exists',
        !(await sh('git', ['branch', '--list', 'spoke/*'], { cwd: dir })).out.trim())
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  {
    const { dir, side } = await makeRepo()
    try {
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-01.md'), brief({ id: 'FND-01' }))
      writeFileSync(join(side, 'script.json'), JSON.stringify({ 'FND-01': { write: { 'src/ok.txt': 'ok' } } }))
      const r = await dispatch(dir, ['--briefs', 'docs/briefs', '--base', 'main', '--codex', FAKE_CODEX, '--json'], join(side, 'script.json'))
      const rep = JSON.parse(r.out)
      eq(S, 'happy path exits 0', r.status, 0)
      eq(S, 'happy path reports passed', rep.passed, ['FND-01'])
      eq(S, 'happy path needs no repair round', rep.records[0].repairs, 0)
      eq(S, 'happy path audit is clean', rep.records[0].audit.ok, true)
      eq(S, 'only the in-scope file changed', rep.records[0].changed, ['src/ok.txt'])
      check(S, 'driver scratch files stay out of the diff',
        !rep.records[0].changed.some((f) => /TASK\.md|\.test_cmd|spoke-(result|schema)/.test(f)))

      // the flags the driver actually passed to the executor — a contract that is only
      // described in a comment is not a contract
      const log = readFileSync(join(side, 'codex.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      eq(S, 'executor invoked exactly once on the happy path', log.length, 1)
      eq(S, 'executor gets low reasoning effort', log[0].effort, 'low')
      eq(S, 'executor gets a writable sandbox, not --full-auto', log[0].sandbox, 'workspace-write')
      check(S, 'executor is given an output schema', Boolean(log[0].schemaPath))
      check(S, 'executor is pointed at its own worktree', /FND-01/.test(log[0].cwd))
      check(S, 'prompt is not passed as an argv element', log[0].argv.includes('-') && !log[0].argv.some((a) => a.length > 400))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  {
    const { dir, side } = await makeRepo()
    try {
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-01.md'), brief({ id: 'FND-01' }))
      // round 0 writes the wrong content (tests fail); round 1 fixes it
      writeFileSync(join(side, 'script.json'), JSON.stringify({
        'FND-01': { rounds: [{ write: { 'src/ok.txt': 'WRONG' } }, { write: { 'src/ok.txt': 'ok' } }] },
      }))
      const r = await dispatch(dir, ['--briefs', 'docs/briefs', '--base', 'main', '--codex', FAKE_CODEX, '--json'], join(side, 'script.json'))
      const rep = JSON.parse(r.out)
      eq(S, 'a failing test triggers a repair round', rep.records[0].repairs, 1)
      eq(S, 'the repair round is allowed to succeed', rep.passed, ['FND-01'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  {
    const { dir, side } = await makeRepo()
    try {
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-01.md'), brief({ id: 'FND-01' }))
      writeFileSync(join(side, 'script.json'), JSON.stringify({ 'FND-01': { write: { 'src/ok.txt': 'WRONG' } } }))
      const r = await dispatch(dir, ['--briefs', 'docs/briefs', '--base', 'main', '--repair-cap', '2', '--codex', FAKE_CODEX, '--json'], join(side, 'script.json'))
      const rep = JSON.parse(r.out)
      eq(S, 'the repair loop terminates at the cap', rep.records[0].repairs, 2)
      eq(S, 'a permanently failing spoke is reported failed', rep.failed, ['FND-01'])
      eq(S, 'a failing run exits 1', r.status, 1)
      const log = readFileSync(join(side, 'codex.log'), 'utf8').trim().split('\n')
      eq(S, 'cap 2 means three executor invocations, not unbounded', log.length, 3)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  {
    const { dir, side } = await makeRepo()
    try {
      // The load-bearing case. The executor exits 0 and writes a passing file, but leaves
      // no result artifact. A driver that trusted the exit code would call this passed.
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-01.md'), brief({ id: 'FND-01' }))
      writeFileSync(join(side, 'script.json'), JSON.stringify({
        'FND-01': { write: { 'src/ok.txt': 'ok' }, noResult: true, exit: 0 },
      }))
      const r = await dispatch(dir, ['--briefs', 'docs/briefs', '--base', 'main', '--codex', FAKE_CODEX, '--json'], join(side, 'script.json'))
      const rep = JSON.parse(r.out)
      eq(S, 'exit 0 with no result artifact is NOT a pass', rep.passed, [])
      check(S, 'the reason names the missing artifact', /result artifact/.test(rep.records[0].reason))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  {
    const { dir, side } = await makeRepo()
    try {
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-01.md'), brief({ id: 'FND-01' }))
      writeFileSync(join(side, 'script.json'), JSON.stringify({
        'FND-01': { status: 'blocked', blocked_reason: 'needs a new dependency' },
      }))
      const r = await dispatch(dir, ['--briefs', 'docs/briefs', '--base', 'main', '--codex', FAKE_CODEX, '--json'], join(side, 'script.json'))
      const rep = JSON.parse(r.out)
      eq(S, 'a self-reported block is surfaced as blocked', rep.blocked, ['FND-01'])
      check(S, 'the block reason is carried through', /new dependency/.test(rep.records[0].reason))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  {
    const { dir, side } = await makeRepo()
    try {
      // Passing tests AND an out-of-scope write. Quarantine must outrank the green run —
      // if this ever reports `passed`, the audit has become decorative.
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-01.md'), brief({ id: 'FND-01', scope: ['src/**'] }))
      writeFileSync(join(side, 'script.json'), JSON.stringify({
        'FND-01': { write: { 'src/ok.txt': 'ok', 'lib/sneaky.js': 'x', 'go.mod': 'module x' } },
      }))
      const r = await dispatch(dir, ['--briefs', 'docs/briefs', '--base', 'main', '--codex', FAKE_CODEX, '--json'], join(side, 'script.json'))
      const rep = JSON.parse(r.out)
      eq(S, 'a scope violation quarantines despite green tests', rep.quarantined, ['FND-01'])
      eq(S, 'a quarantined spoke is not reported passed', rep.passed, [])
      eq(S, 'the firewall hit is reported separately', rep.records[0].audit.denied, ['go.mod'])
      eq(S, 'the scope hit is reported separately', rep.records[0].audit.outOfScope, ['lib/sneaky.js'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  {
    const { dir, side } = await makeRepo()
    try {
      writeFileSync(join(dir, 'docs', 'briefs', 'A-1.md'), brief({ id: 'A-1', scope: ['src/a/**'] }))
      writeFileSync(join(dir, 'docs', 'briefs', 'A-2.md'), brief({ id: 'A-2', scope: ['src/b/**'], blocked_by: ['A-1'] }))
      writeFileSync(join(side, 'script.json'), JSON.stringify({ default: { write: { 'src/ok.txt': 'ok' } } }))
      const r = await dispatch(dir, ['--briefs', 'docs/briefs', '--dry-run', '--json', '--codex', FAKE_CODEX], join(side, 'script.json'))
      const plan = JSON.parse(r.out)
      eq(S, 'dry run exits 0', r.status, 0)
      eq(S, 'dry run schedules only the ready brief', plan.wave.map((w) => w.id), ['A-1'])
      eq(S, 'dry run holds the blocked brief back', plan.blocked, ['A-2'])
      check(S, 'dry run creates nothing', !existsSync(join(dir, '.claude', 'worktrees')))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // ===================================================================== collect gate

  {
    const { dir, side } = await makeRepo()
    try {
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-01.md'), brief({ id: 'FND-01' }))
      writeFileSync(join(side, 'script.json'), JSON.stringify({ 'FND-01': { write: { 'src/ok.txt': 'ok' } } }))
      await dispatch(dir, ['--briefs', 'docs/briefs', '--base', 'main', '--codex', FAKE_CODEX], join(side, 'script.json'))

      const r = await collect(dir, ['--briefs', 'docs/briefs', '--all', '--base', 'main', '--json'])
      const rep = JSON.parse(r.out)
      eq(S, 'collect clears a clean spoke', rep.clear, ['FND-01'])
      eq(S, 'collect exits 0 when everything clears', r.status, 0)

      const m = await collect(dir, ['--briefs', 'docs/briefs', '--all', '--base', 'main', '--merge', '--json'])
      eq(S, 'merge exits 0', m.status, 0)
      eq(S, 'the branch is recorded as merged', JSON.parse(m.out).records[0].merged, true)
      const log = await sh('git', ['log', '--oneline', 'main'], { cwd: dir })
      check(S, 'the merge actually landed on main', /FND-01/.test(log.out))
      // non-vacuous: the delivered file is really on main, not merely claimed to be
      const show = await sh('git', ['show', 'main:src/ok.txt'], { cwd: dir })
      eq(S, 'the delivered file is present on main', show.out.trim(), 'ok')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  {
    const { dir, side } = await makeRepo()
    try {
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-01.md'), brief({ id: 'FND-01', scope: ['src/**'] }))
      writeFileSync(join(side, 'script.json'), JSON.stringify({
        'FND-01': { write: { 'src/ok.txt': 'ok', 'lib/sneaky.js': 'x' } },
      }))
      await dispatch(dir, ['--briefs', 'docs/briefs', '--base', 'main', '--codex', FAKE_CODEX], join(side, 'script.json'))

      const r = await collect(dir, ['--briefs', 'docs/briefs', '--all', '--base', 'main', '--merge', '--json'])
      const rep = JSON.parse(r.out)
      eq(S, 'collect blocks an out-of-scope branch', rep.blocked, ['FND-01'])
      eq(S, 'a blocked branch is not merged', rep.records[0].merged, false)
      eq(S, 'collect exits 1 when something is blocked', r.status, 1)
      const show = await sh('git', ['show', 'main:lib/sneaky.js'], { cwd: dir })
      check(S, 'the out-of-scope file never reached main', show.status !== 0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  {
    const { dir, side } = await makeRepo()
    try {
      // Audit-clean branch whose worktree is gone: the tests cannot be re-run here. This
      // must NOT merge — "could not verify" is not "passed", which is the failure class
      // this repo has shipped most often.
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-01.md'), brief({ id: 'FND-01' }))
      writeFileSync(join(side, 'script.json'), JSON.stringify({ 'FND-01': { write: { 'src/ok.txt': 'ok' } } }))
      await dispatch(dir, ['--briefs', 'docs/briefs', '--base', 'main', '--codex', FAKE_CODEX], join(side, 'script.json'))
      await sh('git', ['worktree', 'remove', '--force', join(dir, '.claude', 'worktrees', 'FND-01')], { cwd: dir })

      const r = await collect(dir, ['--briefs', 'docs/briefs', '--all', '--base', 'main', '--merge', '--json'])
      const rep = JSON.parse(r.out)
      eq(S, 'a branch whose tests could not run is unverified, not clear', rep.unverified, ['FND-01'])
      eq(S, 'unverified is not clear', rep.clear, [])
      eq(S, 'unverified never merges', rep.records[0].merged, false)
      eq(S, 'unverified exits 1', r.status, 1)
      const log = await sh('git', ['log', '--oneline', 'main'], { cwd: dir })
      check(S, 'nothing landed on main', !/FND-01/.test(log.out))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  {
    const { dir, side } = await makeRepo()
    try {
      // A brief the collector has no contract for cannot be cleared: without a declared
      // file_scope there is nothing to audit against, and audit-by-absence is not a pass.
      writeFileSync(join(dir, 'docs', 'briefs', 'FND-01.md'), brief({ id: 'FND-01' }))
      writeFileSync(join(side, 'script.json'), JSON.stringify({ 'FND-01': { write: { 'src/ok.txt': 'ok' } } }))
      await dispatch(dir, ['--briefs', 'docs/briefs', '--base', 'main', '--codex', FAKE_CODEX], join(side, 'script.json'))
      rmSync(join(dir, 'docs', 'briefs', 'FND-01.md'))
      writeFileSync(join(dir, 'docs', 'briefs', 'OTHER-1.md'), brief({ id: 'OTHER-1' }))
      await commitAll(dir)

      const r = await collect(dir, ['--briefs', 'docs/briefs', '--id', 'FND-01', '--base', 'main', '--merge', '--json'])
      const rep = JSON.parse(r.out)
      eq(S, 'a branch with no brief is blocked', rep.blocked, ['FND-01'])
      check(S, 'the reason names the missing brief', /no brief defines/.test(rep.records[0].reasons.join(' ')))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // ======================================================= committed rehearsal briefs

  {
    // The Level-1 rehearsal target is committed, and its briefs are the artifact a reader
    // will copy as an example of what a good brief looks like. Validate them here — for
    // free — so they cannot rot silently between the (token-spending) rehearsal runs that
    // are the only other thing that reads them.
    const briefsDir = join(REPO, 'testbed', 'hub-rehearsal', 'docs', 'briefs')
    check(S, 'the rehearsal target ships briefs', existsSync(briefsDir))
    if (existsSync(briefsDir)) {
      const parsed = readdirSync(briefsDir).filter((f) => f.endsWith('.md'))
        .map((f) => parseBrief(readFileSync(join(briefsDir, f), 'utf8'), f))
      eq(S, 'the rehearsal ships four briefs', parsed.length, 4)
      for (const b of parsed) eq(S, `rehearsal brief ${b.data.id || b.source} validates clean`, validateBrief(b), [])
      eq(S, 'rehearsal briefs have no dangling dependency', danglingDeps(parsed), [])
      eq(S, 'rehearsal briefs have no cycle', findCycle(parsed), null)
      eq(S, 'rehearsal brief scopes never collide', scopeConflicts(parsed), [])
      // the graph must actually fan out, or the target stops exercising what it exists for
      eq(S, 'wave 1 dispatches two independent briefs', readyBriefs(parsed, []).map((b) => b.data.id).sort(), ['CAT-01', 'MNY-01'])
      eq(S, 'wave 2 opens once wave 1 is done',
        readyBriefs(parsed, ['MNY-01', 'CAT-01']).map((b) => b.data.id).sort(), ['CLI-01', 'RPT-01'])
      // the finding from the first 4-brief run: a whole-suite command fails every brief
      // but the last, so no brief here may use one
      for (const b of parsed) {
        check(S, `rehearsal brief ${b.data.id} scopes test_cmd to its own module`,
          !/^(npm|yarn|pnpm) (run )?test\s*$/.test(String(b.data.test_cmd).trim()) && /test[\/\\]/.test(String(b.data.test_cmd)))
      }
    }
    // the implementation must NOT be committed — a rehearsal that starts green proves nothing
    check(S, 'the rehearsal target ships no implementation',
      !existsSync(join(REPO, 'testbed', 'hub-rehearsal', 'src')))
  }

  // ============================================================== adopt idempotency

  {
    // The bug this pattern exposed: adopt used to look for a HARDCODED three-agent
    // heading as its CLAUDE.md marker. Adopting any other pattern would never find it,
    // so every re-run appended the whole pipeline section again. Two adopts must leave
    // exactly one copy — of THIS pattern's heading, not of some other pattern's.
    const dir = mkdtempSync(join(tmpdir(), 'e2e-hub-adopt-'))
    try {
      // NO --platform, and a bare temp dir with no git remote to infer one from. This
      // pattern declares `"tracker": false`, so adopt must not demand a platform it will
      // never read (issue #158). Passing one here would hide a regression.
      const adopt = (extra = []) => sh(process.execPath,
        [join(REPO, 'scripts', 'adopt.mjs'), 'hub-and-spoke-orchestrator-executors', dir, ...extra], { cwd: REPO })
      const first = await adopt()
      eq(S, 'adopt exits 0 for the hub-and-spoke pattern', first.status, 0)
      const second = await adopt()
      eq(S, 'a second adopt also exits 0', second.status, 0)

      const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
      const heading = '## Delivery pipeline — hub-and-spoke (agent-templates)'
      eq(S, 'the pipeline section appears exactly once after two adopts',
        claudeMd.split(heading).length - 1, 1)
      check(S, 'the second adopt reported the snippet as already present',
        /already present/.test(second.out))
      // non-vacuous: the heading really is the one we counted
      check(S, 'the installed CLAUDE.md is this pattern, not the other one',
        claudeMd.includes(heading) && !claudeMd.includes('Architect / Builder / Reviewer'))

      check(S, 'the pattern commands installed', existsSync(join(dir, '.claude', 'commands', 'hub-brief.md')))
      check(S, 'the deterministic scripts installed', existsSync(join(dir, '.claude', 'scripts', 'dispatch-spokes.mjs')))
      check(S, 'worktrees are git-ignored', readFileSync(join(dir, '.gitignore'), 'utf8').includes('.claude/worktrees/'))
      // NEXT STEPS must belong to the pattern that was installed — naming another
      // pattern's commands is worse than printing none
      check(S, 'next steps name this pattern\'s first command', /\/hub-brief/.test(first.out))
      check(S, 'next steps do NOT name the other pattern\'s commands',
        !/\/breakdown-prd|\/start-milestone/.test(first.out))

      // issue #158: a tracker-less pattern must neither demand a platform nor receive
      // tracker templates it never references.
      check(S, 'adopt says the platform is not required', /platform: not required/.test(first.out))
      check(S, 'no tracker issue/MR templates were installed',
        !existsSync(join(dir, '.github')) && !existsSync(join(dir, '.gitlab')))
      check(S, 'adopt says it skipped the tracker templates', /skip.*tracker/i.test(first.out))
      // and no dag.html eol rule either — that file belongs to the other pattern
      const ga = existsSync(join(dir, '.gitattributes')) ? readFileSync(join(dir, '.gitattributes'), 'utf8') : ''
      check(S, 'no dag.html eol rule for a pattern that has no dag.html', !ga.includes('docs/prd/dag.html'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  // ================================================================ scaffold integrity

  {
    const settings = JSON.parse(readFileSync(join(SCAFFOLD, '.claude', 'settings.json'), 'utf8'))
    const deny = settings.permissions?.deny || []
    check(S, 'settings deny writes under .claude/worktrees/',
      deny.includes('Write(.claude/worktrees/**)') && deny.includes('Edit(.claude/worktrees/**)'))
    // reads stay allowed on purpose: a hub that cannot read a failing branch works blind
    check(S, 'settings do NOT deny reads under .claude/worktrees/',
      !deny.some((d) => d.startsWith('Read(.claude/worktrees')))

    const driver = readFileSync(join(SCAFFOLD, '.claude', 'scripts', 'dispatch-spokes.mjs'), 'utf8')

    // The provider validates the output schema in STRICT mode and rejects the request
    // with a 400 `invalid_json_schema` unless `required` lists every key in `properties`.
    // An optional field must therefore be a nullable type, never an omission from
    // `required`. This shipped broken and was caught only by the first real run
    // (2026-08-10); the literal is checked here so it cannot regress silently, since no
    // amount of stand-in-executor testing reaches the provider's validator.
    const literal = driver.match(/const RESULT_SCHEMA = (\{[\s\S]*?\n\})\n/)
    check(S, 'the result schema literal is extractable', Boolean(literal))
    if (literal) {
      const schema = new Function('return ' + literal[1])()
      const props = Object.keys(schema.properties || {})
      const required = schema.required || []
      check(S, 'result schema has properties to check', props.length >= 3)
      eq(S, 'every schema property is listed in `required` (provider strict mode)',
        props.filter((p) => !required.includes(p)), [])
      // the optional field must be expressed as nullable, which is what makes listing it
      // in `required` correct rather than a lie about the executor's obligations
      check(S, 'the optional field is nullable rather than omitted',
        Array.isArray(schema.properties.blocked_reason?.type) && schema.properties.blocked_reason.type.includes('null'))
      check(S, 'the schema is closed', schema.additionalProperties === false)
    }
    check(S, 'driver uses the current sandbox flag, not the deprecated --full-auto',
      driver.includes("'--sandbox', 'workspace-write'") && !driver.includes('--full-auto'))
    check(S, 'driver reads completion from the artifact, not the exit code',
      /never from r\.status|not the exit code|NOT A COMPLETION SIGNAL/i.test(driver))

    const snippet = readFileSync(join(SCAFFOLD, 'claude-md-snippet.md'), 'utf8')
    check(S, 'the CLAUDE.md snippet has a heading to use as its adopt marker', /^## .+$/m.test(snippet))
    // the pattern's defining honesty requirement: the non-independent review is stated in
    // the artifact the adopting project actually reads, not only in the catalog write-up
    // tolerant of markdown emphasis inside the phrase ("*not* independent")
    check(S, 'the snippet states the non-independent-review limit', /not\W{0,3}independent/i.test(snippet))

    const readme = readFileSync(join(REPO, 'patterns', 'hub-and-spoke-orchestrator-executors', 'README.md'), 'utf8')
    check(S, 'README section 4 records the self-review constraint', /reviews its own contract/i.test(readme))
    check(S, 'README does not repeat the unverified 80% saving as a benefit',
      !/(saves|saving of)\s*(~|about )?80%/i.test(readme))
    // Scoped to the RECOMMENDING sections (1-6). Section 7 names the proposal's
    // non-existent models and flags on purpose — recording what was corrected is the
    // point of a provenance log, and a check that forbade the words there would push the
    // correction out of the record to stay green.
    const recommending = readme.split(/^## 7\./m)[0]
    check(S, 'no invented model or CLI name reaches the recommending sections',
      !/claude-3\.7|Claude 3\.7|codex-headless|thinking-budget|--full-auto`? *\|/i.test(recommending))
    check(S, 'the provenance log DOES record the corrections',
      /claude-3\.7|Claude 3\.7/.test(readme.split(/^## 7\./m)[1] || ''))
  }
}
