// E2E for the main-session write guard: feeds the ACTUAL scaffold hook the four
// input shapes it must handle (main-session call, subagent call, garbage input,
// override switch) and asserts the deny/allow contract.

import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'guard'
const HOOK = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/hooks/guard-main-session-writes.mjs', import.meta.url))
const OVERRIDE = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/allow-main-writes', import.meta.url))

const runHook = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' })

export async function run() {
  // main-session Edit -> structured deny with dispatch instruction
  {
    const r = runHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/x.ts' } }))
    eq(S, 'main-session call exits 0', r.status, 0)
    let out = null
    try { out = JSON.parse(r.stdout) } catch {}
    check(S, 'main-session call denied', out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny')
    check(S, 'deny reason teaches dispatch', out && /plan-ticket|build-ticket/.test(out.hookSpecificOutput.permissionDecisionReason))
    check(S, 'deny reason names the blocked target', out && /src\/x\.ts/.test(out.hookSpecificOutput.permissionDecisionReason))
  }

  // subagent call (agent_id present) -> silent allow
  {
    const r = runHook(JSON.stringify({ agent_id: 'uuid-1', agent_type: 'builder', tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } }))
    eq(S, 'subagent call exits 0', r.status, 0)
    eq(S, 'subagent call passes silently', r.stdout.trim(), '')
  }

  // ---- the .claude/tmp/ carve-out (catalog issues #206, #208) ------------------------
  // /deliver-ticket composes the PR/MR body from artifacts that already exist, in the main
  // session. That is reporting, not stage work, so one directory is carved out. It is a
  // SECURITY boundary, so it is tested by behaviour rather than by reading the source: the
  // interesting cases are the ones a naive prefix test would wave through.
  {
    const TMP = fileURLToPath(new URL('../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/tmp/', import.meta.url))
    const decide = (p) => {
      const r = runHook(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: p } }))
      return r.stdout.trim() === '' ? 'allow' : 'deny'
    }
    eq(S, 'carve-out: main session may write its PR body', decide(TMP + 'T-01-mrbody.md'), 'allow')
    eq(S, 'carve-out: and the verdict scratch path', decide(TMP + 'T-01-verdict.md'), 'allow')
    // A prefix test would pass BOTH of these. path.relative does not.
    eq(S, 'carve-out: a .. escape out of tmp is DENIED', decide(TMP + '../../src/app.ts'), 'deny')
    eq(S, 'carve-out: a sibling directory sharing the prefix is DENIED',
      decide(TMP.slice(0, -1) + 'evil' + TMP.slice(-1) + 'x.md'), 'deny')
    eq(S, 'carve-out: the rest of .claude/ is still denied', decide(TMP + '../settings.json'), 'deny')
    eq(S, 'carve-out: source files are still denied', decide('src/app.ts'), 'deny')
    // The deny message must mention the carve-out, or a model that hits the guard while
    // delivering will conclude it may not deliver at all.
    const r = runHook(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } }))
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
    check(S, 'carve-out: the deny message says delivery scratch is allowed',
      reason.includes('.claude/tmp/ is allowed'))
    check(S, 'carve-out: and still forbids planning/implementing/reviewing inline',
      /never plans, implements or reviews inline/.test(reason))
  }

  // ---- Bash writes from a write-forbidden role (catalog issue #218) -----------------
  // A Reviewer's tool list includes Bash because it must RUN the tests, so the one role
  // that may not write holds the one tool that can. One did: a python heredoc overwrote a
  // production file, and the hand-back then said it had not attempted to route around the
  // write restriction. This is not airtight — a shell is general-purpose — but the state
  // it replaces is one where nothing was even attempted.
  {
    const bash = (cmd, role = 'reviewer') =>
      runHook(JSON.stringify({ tool_name: 'Bash', agent_id: 'a1', agent_type: role, tool_input: { command: cmd } }))
    const denied = (cmd, role) => bash(cmd, role).stdout.trim() !== ''

    // the observed attack, verbatim in shape
    check(S, 'reviewer Bash: a heredoc overwriting a file is denied', denied('python - <<EOF\nopen("src/frame.ts","w")\nEOF'))
    check(S, 'reviewer Bash: redirection into a tracked file is denied', denied('echo x > src/frame.ts'))
    check(S, 'reviewer Bash: sed -i is denied', denied('sed -i s/a/b/ src/x.ts'))
    check(S, 'reviewer Bash: node -e is denied', denied('node -e "require(1)"'))
    check(S, 'reviewer Bash: git commit is denied', denied('git commit -am wip'))
    check(S, 'reviewer Bash: git checkout is denied', denied('git checkout -- src/'))

    // Catalog issue #233. Two Reviewers, same machine, same guard, same instruction: one was
    // refused `cp`, the other applied three mutations through `patch` and was not. `patch` was
    // absent from the list, and it writes wherever `-d` points — including inside the repo.
    // Probing for the same shape found five more. A guard that permits a technique through one
    // tool and refuses it through another is sampling a boundary, not enforcing one.
    check(S, 'reviewer Bash: patch is denied (the reported bypass)', denied('printf "%s" "$D" | patch -p1'))
    check(S, 'reviewer Bash: patch INSIDE the repo is denied', denied('patch -p1 -d . < /tmp/f.diff'))
    check(S, 'reviewer Bash: ed is denied', denied('ed -s src/app.ts'))
    check(S, 'reviewer Bash: ex is denied', denied('ex -sc wq src/app.ts'))
    check(S, 'reviewer Bash: curl -o is denied', denied('curl -o src/app.ts https://x/y'))
    check(S, 'reviewer Bash: wget -O is denied', denied('wget -O src/app.ts https://x/y'))
    check(S, 'reviewer Bash: tar -x is denied', denied('tar -xf pkg.tar -C src/'))
    check(S, 'reviewer Bash: unzip is denied', denied('unzip -o pkg.zip -d src/'))
    check(S, 'reviewer Bash: python -m pip install is denied', denied('python -m pip install foo'))

    // ...and the same commands in their READ-ONLY forms stay allowed. Each of the rules above
    // could be satisfied by banning the tool outright, which would take a working technique
    // away from the Reviewer to close a hole — an over-correction this suite has to catch too.
    check(S, 'reviewer Bash: curl without -o is allowed', !denied('curl -s https://api/x'))
    check(S, 'reviewer Bash: tar -t (list) is allowed', !denied('tar -tf pkg.tar'))
    check(S, 'reviewer Bash: python -m pytest is allowed', !denied('python -m pytest -q'))

    // A guard that stops a Reviewer reviewing is an outage, not a control.
    check(S, 'reviewer Bash: running the suite is ALLOWED', !denied('npm test'))
    check(S, 'reviewer Bash: node --test is allowed', !denied('node --test'))
    check(S, 'reviewer Bash: pytest is allowed', !denied('python -m pytest -q'))
    check(S, 'reviewer Bash: grep is allowed', !denied('grep -rn foo src/'))
    check(S, 'reviewer Bash: git diff and git log are allowed',
      !denied('git diff main...ticket/T-1') && !denied('git log --oneline -5'))

    // The one write the role MUST make: its own review record (#201). Forbidding it
    // would make delivery — which refuses a missing record — unable to proceed at all.
    check(S, 'reviewer Bash: writing its own review record is allowed',
      !denied('cat > .claude/tmp/T-01-verdict.md <<EOF\nfindings\nEOF'))

    // The sanctioned mutation probe (catalog issue #229). The role is ASKED to judge
    // whether the Builder's tests are load-bearing, and every mechanism for doing so was
    // denied — including into a scratch tree outside the repo, because the guard reads
    // mechanisms and not paths. Two Reviewers hit that wall on two repos in one day.
    //
    // review-probe.mjs does the isolation itself, so the allowance can be exact rather
    // than a judgement about where a shell will write.
    const PROBE = 'node .claude/scripts/review-probe.mjs --file src/x.ts --test "npm test" --line 4 --replace "return true"'
    check(S, 'reviewer Bash: the sanctioned mutation probe is ALLOWED', !denied(PROBE))
    check(S, 'reviewer Bash: the probe is allowed without the node prefix too',
      !denied('.claude/scripts/review-probe.mjs --file src/x.ts --test "npm test" --delete --line 4'))

    // ...and the allowance must not become a door for a second command. Each of these is
    // the probe plus something the role may not do; the whole command is refused.
    check(S, 'reviewer Bash: probe && rm is denied', denied(PROBE + ' && rm -rf src'))
    check(S, 'reviewer Bash: probe ; write is denied', denied(PROBE + '; echo x > src/app.ts'))
    check(S, 'reviewer Bash: probe with a redirect is denied', denied(PROBE + ' > src/app.ts'))
    check(S, 'reviewer Bash: probe piped into tee is denied', denied(PROBE + ' | tee src/app.ts'))
    check(S, 'reviewer Bash: probe with command substitution is denied',
      denied('node .claude/scripts/review-probe.mjs --file $(rm -rf src)'))
    check(S, 'reviewer Bash: probe with a backtick is denied',
      denied('node .claude/scripts/review-probe.mjs --file `rm -rf src`'))
    check(S, 'reviewer Bash: a name-alike script does not inherit the allowance',
      denied('node tools/evil-review-probe.mjsx --file a; rm -rf src'))

    // The old advice is now false and must not come back: the guard used to tell the
    // Reviewer to copy the tree itself, and then denied exactly that.
    check(S, 'reviewer Bash: copying the tree by hand is still denied', denied('cp -r . /tmp/rvw06'))
    const probeDenial = bash('cp -r . /tmp/rvw06').stdout
    check(S, 'reviewer Bash: and the denial points at the probe instead of a remedy it refuses',
      /review-probe\.mjs/.test(probeDenial) && !/copy the tree/.test(probeDenial), probeDenial.slice(0, 300))

    // The Builder is not write-forbidden; the same command must pass for it.
    check(S, 'builder Bash: the same write is allowed', !denied('echo x > src/frame.ts', 'builder'))
    check(S, 'main session Bash is not touched by this rule',
      runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo x > src/frame.ts' } })).stdout.trim() === '')

    const reason = JSON.parse(bash('echo x > src/frame.ts').stdout).hookSpecificOutput.permissionDecisionReason
    check(S, 'the denial explains that a wrong diff is a BOUNCE, not an edit', /BOUNCE with findings, not an edit/.test(reason))
    check(S, 'and names the scratch path as the allowed exception', /\.claude\/tmp\//.test(reason))
  }

  // garbage input -> never blocks
  {
    const r = runHook('not-json-at-all')
    eq(S, 'garbage input exits 0', r.status, 0)
    eq(S, 'garbage input passes silently', r.stdout.trim(), '')
  }

  // override switch file -> main-session allow while present
  {
    writeFileSync(OVERRIDE, '')
    try {
      const r = runHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/x.ts' } }))
      eq(S, 'override: exits 0', r.status, 0)
      eq(S, 'override: main-session call allowed', r.stdout.trim(), '')
    } finally {
      rmSync(OVERRIDE, { force: true })
    }
    const r2 = runHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/x.ts' } }))
    check(S, 're-armed after override removal', /deny/.test(r2.stdout))
  }
}
