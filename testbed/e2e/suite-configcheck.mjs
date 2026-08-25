// E2E for check-pipeline-config.mjs against REAL git repositories (catalog issue #200).
//
// The pattern version-controls its own configuration under `.claude/`, and the Builder
// checks out the ticket branch — in the MAIN working tree at `concurrency = 1`, the default
// and the recommended on-ramp. So a branch whose base predates a `.claude` change reverts
// that change on disk, mid-run. One observed bounce round reverted `agents/builder.md` to an
// archived variant: the run used a different Builder definition than the one it was
// configured with, and nothing reported it.
//
// Tested against real repositories with real checkouts because the whole question is what
// git actually did to the working tree.
//
// Zero tokens, zero network.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'configcheck'
const SCRIPT = fileURLToPath(
  new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/check-pipeline-config.mjs', import.meta.url)
)

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-cfg-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'e2e')
  git('config', 'core.autocrlf', 'false')
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(dir, '.claude', 'scripts'), { recursive: true })
  mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'agents', 'builder.md'), 'builder v2\n')
  writeFileSync(join(dir, '.claude', 'scripts', 'deliver-ticket.mjs'), '// v2\n')
  writeFileSync(join(dir, '.claude', 'hooks', 'guard.mjs'), '// v2\n')
  writeFileSync(join(dir, '.claude', 'settings.json'), '{"v":2}\n')
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  return { dir, git }
}

function probe(cwd, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('CONFIG-CHECK-JSON: '))
  let json = null
  try { json = line ? JSON.parse(line.slice('CONFIG-CHECK-JSON: '.length)) : null } catch {}
  return { status: r.status, out, json }
}

export async function run() {
  // ---- C1: an unmodified tree is intact ------------------------------------------------
  {
    const { dir } = repo()
    const r = probe(dir)
    eq(S, 'C1 exit 0 when intact', r.status, 0)
    eq(S, 'C1 reported intact', r.json.intact, true)
    eq(S, 'C1 nothing listed as drifted', r.json.drifted, [])
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C2: an agent file rolled back — the observed failure -----------------------------
  {
    const { dir } = repo()
    writeFileSync(join(dir, '.claude', 'agents', 'builder.md'), 'builder v1 (archived)\n')
    const r = probe(dir)
    eq(S, 'C2 exit 1 on drift', r.status, 1)
    eq(S, 'C2 not intact', r.json.intact, false)
    eq(S, 'C2 the file is named', r.json.drifted, ['.claude/agents/builder.md'])
    eq(S, 'C2 classified as an AGENT drift', r.json.agentsDrifted, ['.claude/agents/builder.md'])
    eq(S, 'C2 and not as a live one', r.json.liveDrifted, [])
    // The finding that changes the remedy: restoring the file is NOT enough, because agent
    // definitions are read once per CLI process. Saying only "restore it" would be wrong.
    check(S, 'C2 says restoring is not sufficient and the session must restart',
      /RESTORING THE FILES IS NOT ENOUGH/.test(r.out) && /restarted/.test(r.out), r.out.slice(0, 300))
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C3: scripts/hooks/workflows/settings roll back LIVE -------------------------------
  {
    const { dir } = repo()
    writeFileSync(join(dir, '.claude', 'scripts', 'deliver-ticket.mjs'), '// v1\n')
    writeFileSync(join(dir, '.claude', 'hooks', 'guard.mjs'), '// v1\n')
    writeFileSync(join(dir, '.claude', 'settings.json'), '{"v":1}\n')
    const r = probe(dir)
    eq(S, 'C3 all three are live drifts', r.json.liveDrifted.sort(), [
      '.claude/hooks/guard.mjs', '.claude/scripts/deliver-ticket.mjs', '.claude/settings.json',
    ])
    check(S, 'C3 and are reported as taking effect immediately', /IMMEDIATELY/.test(r.out))
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C4: the two windows are reported SEPARATELY ---------------------------------------
  // They have different remedies, so a single undifferentiated list would leave the reader
  // to classify them — which is the step that produced the incomplete "just restore it".
  {
    const { dir } = repo()
    writeFileSync(join(dir, '.claude', 'agents', 'builder.md'), 'v1\n')
    writeFileSync(join(dir, '.claude', 'scripts', 'deliver-ticket.mjs'), '// v1\n')
    const r = probe(dir)
    eq(S, 'C4 agents and live drifts are split', [r.json.agentsDrifted.length, r.json.liveDrifted.length], [1, 1])
    eq(S, 'C4 and both appear in the combined list', r.json.drifted.length, 2)
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C5: an actual ticket-branch checkout, which is the real mechanism ------------------
  {
    const { dir, git } = repo()
    // a ticket branch cut BEFORE the .claude change
    git('checkout', '-q', '-b', 'ticket/T-01', 'HEAD')
    git('checkout', '-q', 'main')
    writeFileSync(join(dir, '.claude', 'agents', 'builder.md'), 'builder v3\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'update the builder definition')
    // the Builder now checks the ticket branch out in the MAIN tree — concurrency=1
    git('checkout', '-q', 'ticket/T-01')
    const r = probe(dir)
    eq(S, 'C5 a ticket checkout reverts the config and is caught', r.json.intact, false)
    check(S, 'C5 the reverted agent file is named', r.json.drifted.includes('.claude/agents/builder.md'))
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C6: ephemeral paths are not configuration -------------------------------------------
  {
    const { dir } = repo()
    mkdirSync(join(dir, '.claude', 'tmp'), { recursive: true })
    mkdirSync(join(dir, '.claude', 'worktrees', 'lane1'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'tmp', 'T-01-verdict.md'), 'a review record\n')
    writeFileSync(join(dir, '.claude', 'worktrees', 'lane1', 'junk'), 'x\n')
    writeFileSync(join(dir, '.claude', 'allow-main-writes'), '')
    const r = probe(dir)
    eq(S, 'C6 scratch, lanes and the override switch are ignored', r.status, 0)
    eq(S, 'C6 still intact', r.json.intact, true)
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C7: from inside a LANE worktree it must check the MAIN tree ---------------------------
  // At concurrency > 1 the Builder runs in a linked worktree. A check that inspected its own
  // cwd would report the lane, which is not where the pipeline's configuration lives.
  {
    const { dir, git } = repo()
    mkdirSync(join(dir, '.claude', 'worktrees'), { recursive: true })
    git('worktree', 'add', '-q', join('.claude', 'worktrees', 'lane1'), '-b', 'lane1')
    writeFileSync(join(dir, '.claude', 'agents', 'builder.md'), 'rolled back\n')
    const r = probe(join(dir, '.claude', 'worktrees', 'lane1'))
    eq(S, 'C7 drift in the MAIN tree is seen from inside a lane', r.json.intact, false)
    check(S, 'C7 and the main tree is the one reported', r.json.mainTree.replace(/\\/g, '/').endsWith(dir.replace(/\\/g, '/').split('/').pop()))
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C8: it never repairs anything ----------------------------------------------------------
  // Auto-repair would mutate a ticket branch or change the diff the Reviewer judged, trading
  // a reported problem for an unreported one.
  {
    const { dir, git } = repo()
    writeFileSync(join(dir, '.claude', 'agents', 'builder.md'), 'rolled back\n')
    const beforeSha = git('rev-parse', 'HEAD').trim()
    probe(dir)
    const after = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })
    check(S, 'C8 the drift is still there afterwards — nothing was restored', /builder\.md/.test(after), after)
    eq(S, 'C8 and HEAD did not move', git('rev-parse', 'HEAD').trim(), beforeSha)
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- C9: undeterminable is never reported as intact --------------------------------------
  {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-cfg-nogit-'))
    const r = probe(dir)
    eq(S, 'C9 outside a git repo it exits 2, not 0', r.status, 2)
    check(S, 'C9 and never claims intact', r.json === null || r.json.intact !== true, JSON.stringify(r.json))
    rmSync(dir, { recursive: true, force: true })
  }
}
