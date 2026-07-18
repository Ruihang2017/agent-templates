#!/usr/bin/env node
// Canned `gh` CLI for E2E (invoked via GH_BIN="node .../fake-gh.mjs").
// Behavior is driven by env:
//   FAKE_GH_LIST        JSON array returned by `issue list --json number,title`
//   FAKE_GH_STATE       path to a counter file for created-issue numbers (start 101)
//   FAKE_GH_FAIL_LABELS "1" -> `issue create` fails when any --label is present
//   FAKE_GH_FAIL_CREATE "1" -> every `issue create` fails

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const joined = args.join(' ')

if (joined.startsWith('auth status')) process.exit(0)

if (joined.startsWith('issue list')) {
  process.stdout.write(process.env.FAKE_GH_LIST || '[]')
  process.exit(0)
}

if (joined.startsWith('issue create')) {
  if (args.includes('--body-file')) readFileSync(0, 'utf8') // consume stdin like real gh
  if (process.env.FAKE_GH_FAIL_CREATE === '1') {
    console.error('GraphQL: boom (createIssue)')
    process.exit(1)
  }
  if (process.env.FAKE_GH_FAIL_LABELS === '1' && args.includes('--label')) {
    console.error("could not add label: 'module:00-x' not found")
    process.exit(1)
  }
  let n = 101
  const state = process.env.FAKE_GH_STATE
  if (state && existsSync(state)) n = Number(readFileSync(state, 'utf8')) || 101
  if (state) writeFileSync(state, String(n + 1))
  console.log(`https://github.com/acme/repo/issues/${n}`)
  process.exit(0)
}

// deliver-ticket.mjs surface: close records the number; view reports state.
//   FAKE_GH_CLOSED_STATE  path to a file accumulating closed issue numbers
//   FAKE_GH_FAIL_CLOSE    "1" -> `issue close` fails
if (joined.startsWith('issue close')) {
  if (process.env.FAKE_GH_FAIL_CLOSE === '1') {
    console.error('failed to close issue')
    process.exit(1)
  }
  const st = process.env.FAKE_GH_CLOSED_STATE
  if (st) writeFileSync(st, (existsSync(st) ? readFileSync(st, 'utf8') : '') + args[2] + '\n')
  console.log(`Closed issue #${args[2]}`)
  process.exit(0)
}

if (joined.startsWith('issue view')) {
  const st = process.env.FAKE_GH_CLOSED_STATE
  const closed = st && existsSync(st) && readFileSync(st, 'utf8').split('\n').includes(args[2])
  if (args.includes('--json')) {
    console.log(JSON.stringify({ state: closed ? 'CLOSED' : 'OPEN' }))
  } else {
    console.log(closed ? 'state:\tclosed' : 'state:\topen')
  }
  process.exit(0)
}

console.error(`fake-gh: unhandled args: ${joined}`)
process.exit(1)
