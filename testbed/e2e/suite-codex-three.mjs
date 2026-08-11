// Codex three-agent scaffold integrity. Zero tokens, zero network.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { check, eq } from './lib.mjs'

const S = 'codex-three'
const ROOT = fileURLToPath(new URL('../../patterns/codex-three-agent-architect-builder-reviewer/', import.meta.url))
const SCAFFOLD = join(ROOT, 'scaffold')

const expected = [
  'README.md', 'scaffold/INSTALL.md', 'scaffold/agents-md-snippet.md', 'scaffold/next-steps.txt',
  'scaffold/.codex/config.toml',
  ...['architect', 'builder', 'reviewer', 'delivery', 'triage'].map((n) => `scaffold/.codex/agents/${n}.toml`),
  ...['dag-core', 'dag-report', 'dag-scan', 'deliver-ticket', 'milestone-dag', 'prd-phase', 'publish-tickets'].map((n) => `scaffold/.codex/scripts/${n}.mjs`),
  ...['breakdown-prd', 'plan-ticket', 'build-ticket', 'review-ticket', 'run-ticket', 'publish-tickets', 'start-milestone', 'start-all', 'verify-delivery'].map((n) => `scaffold/.agents/skills/${n}/SKILL.md`),
]

export async function run() {
  for (const rel of expected) check(S, `ships ${rel}`, existsSync(join(ROOT, rel)))

  const config = readFileSync(join(SCAFFOLD, '.codex/config.toml'), 'utf8')
  check(S, 'primary is read-only', /^sandbox_mode = "read-only"$/m.test(config))
  check(S, 'subagents enabled with bounded threads', /\[agents\]/.test(config) && /^enabled = true$/m.test(config) && /^max_concurrent_threads_per_session = 4$/m.test(config))

  const agents = {}
  for (const name of ['architect', 'builder', 'reviewer', 'delivery', 'triage']) {
    const body = readFileSync(join(SCAFFOLD, `.codex/agents/${name}.toml`), 'utf8')
    agents[name] = body
    for (const key of ['name', 'description', 'model', 'model_reasoning_effort', 'sandbox_mode', 'developer_instructions']) {
      check(S, `${name} declares ${key}`, new RegExp(`^${key}\\s*=`, 'm').test(body))
    }
  }
  // Every pinned model must be a REAL id. This shipped with `model = "gpt-5.6"`, which is
  // a tier family, not a model id — Codex exposes gpt-5.6-sol / -terra / -luna — so both
  // the Architect and the Builder would have failed at spawn. The original assertion
  // hardcoded that value and therefore locked the bug in: a green gate over a wrong value,
  // which is worse than no gate. Membership in the documented set catches the whole class.
  // Source: https://learn.chatgpt.com/docs/models, verified 2026-08-11.
  const CODEX_MODEL_IDS = new Set([
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    'gpt-5.3-codex-spark', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini',
  ])
  for (const [name, body] of Object.entries(agents)) {
    const pinned = (body.match(/^model = "([^"]+)"$/m) || [])[1] || ''
    check(S, `${name} pins a real Codex model id (${pinned || 'none'})`, CODEX_MODEL_IDS.has(pinned))
  }
  // The README's §3 table must pin the SAME ids as the scaffold. A table that disagrees
  // with the files is how a reader adopts a configuration nobody ever ran.
  const patternReadme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  for (const [name, body] of Object.entries(agents)) {
    const pinned = (body.match(/^model = "([^"]+)"$/m) || [])[1] || ''
    check(S, `README §3 pins the same model as ${name}.toml`, pinned && patternReadme.includes('`' + pinned + '`'))
  }
  check(S, 'Architect/Builder use the flagship tier',
    /^model = "gpt-5\.6-sol"$/m.test(agents.architect) && /^model = "gpt-5\.6-sol"$/m.test(agents.builder))
  // §2's independence requirement, made mechanical: the Reviewer must not share the
  // Builder's model, in either direction. Collapsing them is the failure this forbids.
  const modelOf = (b) => (b.match(/^model = "([^"]+)"$/m) || [])[1] || ''
  check(S, 'Reviewer is a different model from the Builder',
    modelOf(agents.reviewer) && modelOf(agents.reviewer) !== modelOf(agents.builder))
  check(S, 'Reviewer uses a distinct model tier', /^model = "gpt-5\.6-terra"$/m.test(agents.reviewer))
  check(S, 'Reviewer is read-only', /^sandbox_mode = "read-only"$/m.test(agents.reviewer))
  check(S, 'Builder is workspace-write', /^sandbox_mode = "workspace-write"$/m.test(agents.builder))
  check(S, 'Delivery is narrow low-effort Luna', /^model = "gpt-5\.6-luna"$/m.test(agents.delivery) && /^model_reasoning_effort = "low"$/m.test(agents.delivery))

  const skillsRoot = join(SCAFFOLD, '.agents/skills')
  const skills = readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  eq(S, 'skill set is complete', skills, ['breakdown-prd', 'build-ticket', 'plan-ticket', 'publish-tickets', 'review-ticket', 'run-ticket', 'start-all', 'start-milestone', 'verify-delivery'])
  for (const name of skills) {
    const body = readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8')
    const fm = (body.match(/^---\n([\s\S]*?)\n---/) || [])[1] || ''
    check(S, `${name} skill name matches directory`, new RegExp(`^name: ${name}$`, 'm').test(fm))
    check(S, `${name} skill has a trigger description`, /^description: .+/m.test(fm))
    check(S, `${name} skill is non-empty`, body.split('\n').length >= 8)
  }
  check(S, 'run-ticket enforces artifact-only fresh review', /Pass only ticket path, plan path, and branch\/commit diff reference/.test(readFileSync(join(skillsRoot, 'run-ticket/SKILL.md'), 'utf8')))
  check(S, 'start-all rejects unsafe parallel Builders', /Reject any concurrency argument greater than 1/.test(readFileSync(join(skillsRoot, 'start-all/SKILL.md'), 'utf8')))

  const scriptsDir = join(SCAFFOLD, '.codex/scripts')
  for (const name of readdirSync(scriptsDir).filter((n) => n.endsWith('.mjs'))) {
    const path = join(scriptsDir, name)
    const body = readFileSync(path, 'utf8')
    check(S, `${name} has no Claude runtime path`, !/\.claude\//.test(body))
    const syntax = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
    check(S, `${name} parses`, syntax.status === 0, syntax.stderr)
  }

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  check(S, 'README status is proposed', /\| \*\*Status\*\* \| `proposed` \|/.test(readme))
  const headings = [...readme.matchAll(/^## ([1-7])\./gm)].map((m) => Number(m[1]))
  eq(S, 'README has schema sections in order', headings, [1, 2, 3, 4, 5, 6, 7])
  check(S, 'model claims carry official sources', (readme.match(/`\[official\]`/g) || []).length >= 5)
  check(S, 'README records the unverified real-run gap', /No Codex Level-1 run/.test(readme) && /None recorded yet/.test(readme))

  const snippet = readFileSync(join(SCAFFOLD, 'agents-md-snippet.md'), 'utf8')
  check(S, 'AGENTS snippet has an idempotency heading and runtime skills', /^## Delivery pipeline — Codex/m.test(snippet) && /\$run-ticket/.test(snippet))
  check(S, 'AGENTS snippet states the sequential boundary', /rejects `concurrency > 1`/.test(snippet))

  // ---------------------------------------------------------------------------
  // Script parity with the Claude pattern.
  //
  // `.codex/scripts/*` are hand-maintained COPIES of `.claude/scripts/*`, differing only
  // in runtime paths. Today they are identical apart from those. Nothing enforced that,
  // and a copy is the single most reliable way this catalog ships a bug twice: fix
  // deliver-ticket for GitLab in one runtime and the other silently keeps the defect,
  // with every test still green because each suite only ever reads its own copy.
  //
  // Normalising the runtime tokens and requiring EQUALITY is the strongest available
  // gate short of extracting a shared module. It fails the moment the two diverge for any
  // reason other than a path — including a deliberate improvement, which is the point:
  // an intentional divergence should have to be stated, not discovered later.
  {
    const claudeScripts = fileURLToPath(new URL(
      '../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/', import.meta.url))
    const codexScripts = join(SCAFFOLD, '.codex', 'scripts')
    // Compare CODE, not prose. Whole-line comments are stripped because the two runtimes
    // legitimately explain themselves differently — Codex has no Workflow tool, so
    // dag-scan's header rationale is genuinely not the same story. What must not diverge
    // is behaviour. Only lines whose trimmed form STARTS with `//` are dropped, so a `//`
    // inside a regex or string (`/\.claude\/tmp\//`) is never mangled.
    const normalise = (s) => s
      .replace(/\r\n/g, '\n')
      .split('.codex/').join('.claude/')
      .split("'.codex'").join("'.claude'")
      .split('AGENTS.md').join('CLAUDE.md')
      .split('.codex\\').join('.claude\\')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('//'))
      .join('\n')

    const shared = readdirSync(codexScripts).filter((f) => f.endsWith('.mjs')).sort()
    check(S, 'the Codex pattern ships the deterministic scripts', shared.length >= 7)
    let compared = 0
    for (const f of shared) {
      const counterpart = join(claudeScripts, f)
      if (!existsSync(counterpart)) {
        // A Codex-only script is allowed, but it must be a deliberate, visible fact.
        check(S, `${f} has a Claude counterpart (or is a deliberate Codex-only script)`, false,
          'no .claude/scripts/' + f + ' — if this is intentional, note it in README §6')
        continue
      }
      compared += 1
      const a = normalise(readFileSync(join(codexScripts, f), 'utf8'))
      const b = normalise(readFileSync(counterpart, 'utf8'))
      check(S, `${f} is in sync with the Claude copy (runtime paths aside)`, a === b,
        a === b ? '' : 'the two copies have diverged — port the change or record the divergence in README §6')
    }
    // guard the guard: if the loop compared nothing, every check above passed vacuously
    check(S, 'parity gate actually compared the scripts', compared >= 7, `compared ${compared}`)

    // Shared project state must NOT be runtime-scoped (catalog issue #181). One project can
    // run both patterns side by side — they share docs/prd/, the ticket ids, the branch
    // names and the tracker — so a record of what shipped that lived under `.claude/` or
    // `.codex/` would give each runtime its own truth and let the other re-run delivered
    // work. The parity gate above CANNOT see this: it normalises `.codex/` to `.claude/`,
    // so two divergent paths compare equal. This reads the raw literals instead.
    const rawLedger = (p) => (readFileSync(p, 'utf8').match(/^const LEDGER = (.+)$/m) || [])[1] || ''
    const claudeLedger = rawLedger(join(claudeScripts, 'deliver-ticket.mjs'))
    const codexLedger = rawLedger(join(codexScripts, 'deliver-ticket.mjs'))
    check(S, 'both runtimes declare a delivery ledger', claudeLedger && codexLedger)
    eq(S, 'the delivery ledger path is identical across runtimes', codexLedger, claudeLedger)
    check(S, 'the delivery ledger is not runtime-scoped',
      !/\.claude|\.codex|\.agents/.test(claudeLedger), claudeLedger)
  }
}

