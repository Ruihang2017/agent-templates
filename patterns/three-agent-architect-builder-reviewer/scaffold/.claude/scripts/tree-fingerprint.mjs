#!/usr/bin/env node
// tree-fingerprint.mjs — a content hash of the working tree, so "nothing changed between the
// build and the merge" can be VERIFIED instead of attested (catalog issue #233).
//
// Usage:
//   node .claude/scripts/tree-fingerprint.mjs            # print it
//   node .claude/scripts/tree-fingerprint.mjs --expect <sha>   # exit 1 if it differs
//
// Last line of stdout is machine-readable:
//   TREE-FINGERPRINT-JSON: {"sha","head","entries","matched"?}
//
// Exit codes: 0 = printed, or matched; 1 = --expect given and it did not match, or git failed.
//
// WHY
//
// #218 gave the write-forbidden roles a Bash guard that matches command TEXT. #233 showed
// what that buys: two Reviewers, same machine, same guard, same instruction, opposite
// outcomes — one was refused `cp`, the other applied three mutations through `patch`, which
// was simply not in the list. Probing found five more (`ed`, `ex`, `curl -o`, `wget -O`,
// `tar -x`). Those are now closed, and closing them is not the fix: a shell is a
// general-purpose machine and the next tool nobody thought of is always available.
//
// The existing backstop does not reach this. `--expect-head` compares `git rev-parse
// <branch>` — a COMMIT. A Reviewer that patches a tracked file without committing leaves the
// branch head untouched, so that check passes, and the verdict was formed against code the
// Reviewer itself changed. deliver-ticket's clean-tree check does refuse a dirty tree, but
// only at DELIVERY: by then the review has run its tests against the mutated code and
// returned CLEAR, which is #218's actual harm — a verdict describing something that did not
// happen.
//
// So this hashes the tree instead of guessing at commands. Whatever the idiom, whatever the
// tool, a modification changes the fingerprint. That is the property; the blocklist is now
// defence in depth rather than the thing being relied on.
//
// WHAT IS HASHED
//
//   - HEAD, so a commit is a change too
//   - `git status --porcelain -uall`, so adds, deletes and untracked files count
//   - `git diff HEAD`, so an edit that leaves the status line identical still shows up
//
// Excluded, matching deliver-ticket.mjs's clean-tree check exactly — these are the paths the
// pipeline itself writes between the build and the merge, and treating them as tampering
// would refuse every delivery:
//
//   .claude/tmp/         the Reviewer's own record (it has no Write tool; catalog #201)
//   .claude/worktrees/   other lanes' checkouts
//   docs/plans/          the Architect's plan
//   docs/prd/dag.html    regenerated on every scan

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const expectIx = argv.indexOf('--expect')
const EXPECT = expectIx === -1 ? null : (argv[expectIx + 1] || '').trim()

const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }
}

const out = { sha: null, head: null, entries: 0 }
const die = (msg) => {
  console.error(msg)
  console.log('TREE-FINGERPRINT-JSON: ' + JSON.stringify(out))
  process.exit(1)
}

// The same exclusions deliver-ticket.mjs applies. Kept as one expression so the two cannot
// disagree about what the pipeline is allowed to write — a rule in two places is a rule that
// can drift, which is what #230 cost two releases.
const PIPELINE_WRITES = /\.claude\/tmp\/|\.claude\/worktrees\/|docs\/plans\/|docs\/prd\/dag\.html/

const head = git(['rev-parse', 'HEAD'])
if (!head.ok) die('not inside a git repository (or no commits yet): ' + head.out.split('\n')[0])
out.head = head.out.trim()

const status = git(['status', '--porcelain', '-uall'])
if (!status.ok) die('git status failed: ' + status.out.split('\n')[0])

const lines = status.out.split('\n').filter((l) => l.trim() && !PIPELINE_WRITES.test(l))
out.entries = lines.length

// `git diff HEAD` covers content of tracked modifications. Untracked files are not in it, but
// they are in the status list above by name — and a role that may not write has no business
// creating one either, so presence is enough.
const diff = git(['diff', 'HEAD'])
if (!diff.ok) die('git diff failed: ' + diff.out.split('\n')[0])
const diffBody = diff.out
  .split('\n')
  .filter((l) => !PIPELINE_WRITES.test(l))
  .join('\n')

// The parts are joined with a NUL: it cannot occur in any of them, so no rearrangement of
// tree contents can be made to hash the same as a different one. Written as an escape and
// never as a raw byte — a control character in source survives every diff and `node --check`.
const h = createHash('sha256')
h.update(out.head)
h.update('\u0000')
h.update(lines.sort().join('\n'))
h.update('\u0000')
h.update(diffBody)
out.sha = h.digest('hex')

if (EXPECT) {
  out.matched = out.sha === EXPECT
  if (!out.matched) {
    console.error(
      `working tree fingerprint changed: expected ${EXPECT.slice(0, 12)}, got ${out.sha.slice(0, 12)}. ` +
        `Something wrote to the tree after the build. Inspect with: git status --porcelain -uall && git diff HEAD`
    )
    console.log('TREE-FINGERPRINT-JSON: ' + JSON.stringify(out))
    process.exit(1)
  }
  console.log('tree fingerprint matches: ' + out.sha.slice(0, 12))
} else {
  console.log('tree fingerprint: ' + out.sha)
}
console.log('TREE-FINGERPRINT-JSON: ' + JSON.stringify(out))
process.exit(0)
