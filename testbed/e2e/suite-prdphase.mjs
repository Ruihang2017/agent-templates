// E2E for prd-phase.mjs (catalog issue #112): the deterministic half of adding a PRD
// phase after Gate 2. `context` tells the Architect what already exists so a later
// phase cannot collide with an earlier one; `check` enforces against git that the
// earlier phase was only ADDED TO, never rewritten.
//
// The load-bearing case is PP9/PP10: a modified or deleted pre-existing ticket must
// exit 1. Everything else in this suite exists to prove that verdict discriminates —
// the same tree with only additions (PP8) exits 0, so the check is not just "always
// red" (the #83 lesson, in reverse).

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'prdphase'
const SCRIPT = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/prd-phase.mjs', import.meta.url))

const ticket = (id) => `---\nid: ${id}\ntitle: Ticket ${id}\nmodule: m\nblocked_by: []\n---\n\n# ${id}\n`

function phase(cwd, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
  const grab = (tag) => {
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith(tag + ': '))
    try { return line ? JSON.parse(line.slice(tag.length + 2)) : null } catch { return null }
  }
  return { ...r, context: grab('PHASE-CONTEXT-JSON'), freeze: grab('FREEZE-CHECK-JSON') }
}

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' })

// A tree with two delivered-looking modules, committed so `check` has a baseline.
function makeRepo({ commit = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-phase-'))
  for (const [mod, ids] of [['00-foundation', ['FND-1', 'FND-2']], ['01-api', ['API-1']]]) {
    mkdirSync(join(root, 'docs', 'prd', mod, 'tickets'), { recursive: true })
    writeFileSync(join(root, 'docs', 'prd', mod, 'README.md'), `# ${mod}\n`)
    for (const id of ids) writeFileSync(join(root, 'docs', 'prd', mod, 'tickets', `${id}.md`), ticket(id))
  }
  writeFileSync(join(root, 'docs', 'prd', 'breakdown-plan.md'), '# phase 1 split\n')
  writeFileSync(join(root, 'docs', 'prd', 'dag.html'), '<html>generated</html>')
  if (commit) {
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'e2e@example.com'])
    git(root, ['config', 'user.name', 'e2e'])
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'phase 1 delivered'])
  }
  return root
}

export async function run() {
  // ---- PP0 (catalog issue #230): a ticket whose frontmatter is preceded by an HTML
  // comment must be READ, on this path as well as the DAG scan's.
  //
  // #185 fixed exactly that, in two places: dag-core's `fmOf` and a hand-copied twin here.
  // The copy lost every backslash — `/^(?:s*<!--[sS]*?-->s*)*/` matches the letter s, strips
  // nothing, and is a perfectly valid regex no linter objects to. It shipped that way in
  // 0.16.0 and 0.16.1: one path honoured #185, the other silently did not.
  //
  // Nothing caught it because this suite's own `ticket()` helper writes frontmatter with no
  // preamble, while the template the Architect is told to follow opens with a comment. A
  // fixture more permissive than the real input cannot exercise the bug, so the first case
  // below drives the REAL shipped template — the same guard suite-dag applies to the scan.
  {
    const root = mkdtempSync(join(tmpdir(), 'e2e-phase-tpl-'))
    try {
      const tdir = join(root, 'docs', 'prd', '00-foundation', 'tickets')
      mkdirSync(tdir, { recursive: true })
      writeFileSync(join(root, 'docs', 'prd', '00-foundation', 'README.md'), '# 00-foundation\n')
      const template = readFileSync(fileURLToPath(new URL('../../templates/ticket.template.md', import.meta.url)), 'utf8')
      check(S, 'PP0 the shipped ticket template still opens with a comment', /^\s*<!--/.test(template))
      writeFileSync(join(tdir, 'MOD-NN.md'), template)
      const r = phase(root, ['context', 'docs/prd'])
      eq(S, 'PP0 exits 0 on a tree written from the shipped template', r.status, 0)
      check(S, 'PP0 the template ticket is SEEN, not silently skipped',
        !!r.context && (r.context.modules || []).some((m) => (m.tickets || []).length === 1),
        JSON.stringify(r.context && r.context.modules))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    // The same property stated directly, so a template that stops opening with a comment
    // does not quietly retire the coverage above.
    const root = mkdtempSync(join(tmpdir(), 'e2e-phase-cmt-'))
    try {
      const tdir = join(root, 'docs', 'prd', '00-foundation', 'tickets')
      mkdirSync(tdir, { recursive: true })
      writeFileSync(join(root, 'docs', 'prd', '00-foundation', 'README.md'), '# 00-foundation\n')
      writeFileSync(join(tdir, 'FND-1.md'), '<!-- generated; edit the PRD instead -->\n' + ticket('FND-1'))
      writeFileSync(join(tdir, 'FND-2.md'), ticket('FND-2'))
      const r = phase(root, ['context', 'docs/prd'])
      const ids = ((r.context && r.context.modules) || []).flatMap((m) => m.tickets || [])
      check(S, 'PP0 a comment above the frontmatter does not hide the ticket',
        ids.includes('FND-1') && ids.includes('FND-2'), JSON.stringify(ids))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  // ---- context ----
  {
    const root = mkdtempSync(join(tmpdir(), 'e2e-phase-empty-'))
    try {
      const r = phase(root, ['context', 'docs/prd'])
      eq(S, 'PP1 empty tree exits 0 (first decomposition is not an error)', r.status, 0)
      check(S, 'PP1 reports phase 1, not append', r.context && r.context.phase === 1 && r.context.append === false)
      eq(S, 'PP1 nextPrefix starts at 00', r.context && r.context.nextPrefix, '00')
      eq(S, 'PP1 default plan file keeps the historical name', r.context && r.context.planFile, 'breakdown-plan.md')
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    const root = makeRepo({ commit: false })
    try {
      const r = phase(root, ['context', 'docs/prd'])
      eq(S, 'PP2 exits 0 on an existing tree', r.status, 0)
      check(S, 'PP2 detects append mode', r.context && r.context.append === true)
      eq(S, 'PP2 nextPrefix follows the highest module', r.context && r.context.nextPrefix, '02')
      eq(S, 'PP2 collects every used ticket id', r.context && r.context.usedIds, ['API-1', 'FND-1', 'FND-2'])
      eq(S, 'PP2 lists the existing modules', r.context && r.context.modules.map((m) => m.dir), ['00-foundation', '01-api'])
      const files = (r.context && r.context.existingFiles) || []
      check(S, 'PP2 existingFiles carries the frozen ticket files',
        files.includes('00-foundation/tickets/FND-1.md') && files.includes('01-api/tickets/API-1.md'))
      check(S, 'PP2 existingFiles carries the earlier phase plan', files.includes('breakdown-plan.md'))
      // dag.html is regenerated on every breakdown; freezing it would fail every phase
      check(S, 'PP2 existingFiles excludes the regenerated dag.html', !files.includes('dag.html'))

      // a phase PRD names its own plan file so phase 1's rationale is not clobbered
      const r2 = phase(root, ['context', 'docs/prd', '--prd', 'docs/PRD-02-billing.md'])
      eq(S, 'PP3 phase PRD gets its own plan file', r2.context && r2.context.planFile, 'breakdown-plan-02-billing.md')
      const r3 = phase(root, ['context', 'docs/prd', '--prd', 'docs/PRD.md'])
      eq(S, 'PP3 master PRD keeps breakdown-plan.md', r3.context && r3.context.planFile, 'breakdown-plan.md')
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    // the nightly sweep writes 99-nightly; it must not push the next phase to 100
    const root = makeRepo({ commit: false })
    try {
      mkdirSync(join(root, 'docs', 'prd', '99-nightly', 'tickets'), { recursive: true })
      writeFileSync(join(root, 'docs', 'prd', '99-nightly', 'tickets', 'NGT-1.md'), ticket('NGT-1'))
      const r = phase(root, ['context', 'docs/prd'])
      eq(S, 'PP4 reserved 99-nightly does not advance nextPrefix', r.context && r.context.nextPrefix, '02')
      check(S, 'PP4 but its ticket id is still reserved against collision',
        r.context && r.context.usedIds.includes('NGT-1'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    const root = mkdtempSync(join(tmpdir(), 'e2e-phase-missing-'))
    try {
      const r = phase(root, ['context', 'docs/prd'])
      eq(S, 'PP5 a missing root is phase 1, not a failure', r.status, 0)
      check(S, 'PP5 reports an empty context', r.context && r.context.modules.length === 0 && r.context.existingFiles.length === 0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  // ---- check ----
  {
    const root = makeRepo()
    try {
      const clean = phase(root, ['check', 'docs/prd'])
      eq(S, 'PP6 a clean tree passes', clean.status, 0)
      check(S, 'PP6 reports the check actually ran', clean.freeze && clean.freeze.checked === true)
      eq(S, 'PP6 no violations', clean.freeze && clean.freeze.violations, [])
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    // the append case: a whole new module, nothing touched
    const root = makeRepo()
    try {
      mkdirSync(join(root, 'docs', 'prd', '02-billing', 'tickets'), { recursive: true })
      writeFileSync(join(root, 'docs', 'prd', '02-billing', 'README.md'), '# billing\n')
      writeFileSync(join(root, 'docs', 'prd', '02-billing', 'tickets', 'BIL-1.md'), ticket('BIL-1'))
      writeFileSync(join(root, 'docs', 'prd', 'breakdown-plan-02-billing.md'), '# phase 2 split\n')
      // adding a NEW ticket to an EXISTING module is legal — the rule is per file
      writeFileSync(join(root, 'docs', 'prd', '01-api', 'tickets', 'API-2.md'), ticket('API-2'))
      const r = phase(root, ['check', 'docs/prd'])
      eq(S, 'PP7 additions only -> exit 0', r.status, 0)
      eq(S, 'PP7 no violations for pure additions', r.freeze && r.freeze.violations, [])
      // -uall: without it an entirely-untracked directory collapses to one entry (#83)
      check(S, 'PP7 additions list the FILES of a new module, not the directory',
        r.freeze && r.freeze.additions.includes('docs/prd/02-billing/tickets/BIL-1.md') &&
          r.freeze.additions.includes('docs/prd/02-billing/README.md'))
      check(S, 'PP7 a new ticket inside an existing module is an addition',
        r.freeze && r.freeze.additions.includes('docs/prd/01-api/tickets/API-2.md'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    // THE case this script exists for: a delivered ticket rewritten
    const root = makeRepo()
    try {
      writeFileSync(join(root, 'docs', 'prd', '00-foundation', 'tickets', 'FND-1.md'), ticket('FND-1') + '\nrewritten after delivery\n')
      const r = phase(root, ['check', 'docs/prd'])
      eq(S, 'PP8 a modified delivered ticket -> exit 1', r.status, 1)
      // exit 1 alone is not proof: a missing/broken script also exits 1. Require that
      // the check actually RAN and reported a violation (#83, vacuous pass).
      check(S, 'PP8 exit 1 because the check ran, not because it blew up', r.freeze && r.freeze.checked === true && r.freeze.violations.length > 0)
      check(S, 'PP8 names the violating file',
        r.freeze && r.freeze.violations.some((v) => v.path === 'docs/prd/00-foundation/tickets/FND-1.md'))
      check(S, 'PP8 the failure is loud on stderr', /FND-1\.md/.test(r.stderr || ''))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    const root = makeRepo()
    try {
      unlinkSync(join(root, 'docs', 'prd', '01-api', 'tickets', 'API-1.md'))
      const r = phase(root, ['check', 'docs/prd'])
      eq(S, 'PP9 a deleted delivered ticket -> exit 1', r.status, 1)
      check(S, 'PP9 exit 1 because the check ran', r.freeze && r.freeze.checked === true && r.freeze.violations.length > 0)
      check(S, 'PP9 names the deleted file',
        r.freeze && r.freeze.violations.some((v) => v.path === 'docs/prd/01-api/tickets/API-1.md'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    // an earlier phase's breakdown plan is history too
    const root = makeRepo()
    try {
      writeFileSync(join(root, 'docs', 'prd', 'breakdown-plan.md'), '# phase 1 split, silently rewritten\n')
      const r = phase(root, ['check', 'docs/prd'])
      eq(S, "PP10 rewriting an earlier phase's plan -> exit 1", r.status, 1)
      check(S, 'PP10 names breakdown-plan.md as the violation, and the check ran',
        r.freeze && r.freeze.checked === true && r.freeze.violations.some((v) => v.path === 'docs/prd/breakdown-plan.md'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    // dag.html is regenerated by dag-report on every breakdown — exempt by design
    const root = makeRepo()
    try {
      writeFileSync(join(root, 'docs', 'prd', 'dag.html'), '<html>regenerated</html>')
      const r = phase(root, ['check', 'docs/prd'])
      eq(S, 'PP11 a regenerated dag.html is not a violation', r.status, 0)
      eq(S, 'PP11 and is not reported as one', r.freeze && r.freeze.violations, [])
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    // the escape hatch: a pre-Gate-1 decomposition that was simply wrong
    const root = makeRepo()
    try {
      writeFileSync(join(root, 'docs', 'prd', '00-foundation', 'tickets', 'FND-1.md'), ticket('FND-1') + '\nredone\n')
      const r = phase(root, ['check', 'docs/prd', '--redo'])
      eq(S, 'PP12 --redo bypasses the freeze', r.status, 0)
      check(S, 'PP12 and says the check did NOT run', r.freeze && r.freeze.checked === false && /redo/.test(r.freeze.reason || ''))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    // no git = the check cannot run. Exit 0 so a fresh project is not blocked, but
    // `checked: false` so the caller cannot report an unrun check as a passed one.
    const root = makeRepo({ commit: false })
    try {
      const r = phase(root, ['check', 'docs/prd'])
      eq(S, 'PP13 outside a git repo -> exit 0 (does not block a fresh project)', r.status, 0)
      check(S, 'PP13 but checked:false with a reason — not a pass',
        r.freeze && r.freeze.checked === false && String(r.freeze.reason || '').length > 0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    const root = makeRepo({ commit: false })
    try {
      git(root, ['init', '-q'])
      git(root, ['config', 'user.email', 'e2e@example.com'])
      git(root, ['config', 'user.name', 'e2e'])
      const r = phase(root, ['check', 'docs/prd'])
      eq(S, 'PP14 a repo with no commits -> exit 0', r.status, 0)
      eq(S, 'PP14 reported as unchecked, reason "no commits yet"', r.freeze && r.freeze.reason, 'no commits yet')
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  {
    const root = mkdtempSync(join(tmpdir(), 'e2e-phase-usage-'))
    try {
      const r = phase(root, ['nonsense'])
      eq(S, 'PP15 an unknown verb fails loudly', r.status, 1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
}
