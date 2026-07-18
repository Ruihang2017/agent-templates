#!/usr/bin/env node
// Canned `glab` CLI for E2E (invoked via GLAB_BIN="node .../fake-glab.mjs").
// Simulates an OLDER glab: `issue list --output json` exits 1, forcing the
// publish script's per-line text fallback. Env:
//   FAKE_GLAB_LIST   text listing returned by `issue list --all` (one "#N  title" per line)

const args = process.argv.slice(2)
const joined = args.join(' ')

if (joined.startsWith('auth status')) process.exit(0)

if (joined.startsWith('issue list')) {
  if (args.includes('--output')) {
    console.error('unknown flag: --output') // old glab
    process.exit(1)
  }
  process.stdout.write(process.env.FAKE_GLAB_LIST || '')
  process.exit(0)
}

if (joined.startsWith('issue create')) {
  console.log('https://gitlab.example.com/acme/repo/-/issues/77')
  process.exit(0)
}

// deliver-ticket.mjs surface: close records the number; view reports state.
//   FAKE_GLAB_CLOSED_STATE  path to a file accumulating closed issue numbers
if (joined.startsWith('issue close')) {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
  const st = process.env.FAKE_GLAB_CLOSED_STATE
  if (st) writeFileSync(st, (existsSync(st) ? readFileSync(st, 'utf8') : '') + args[2] + '\n')
  console.log(`Closed issue #${args[2]}`)
  process.exit(0)
}

if (joined.startsWith('issue view')) {
  const { readFileSync, existsSync } = await import('node:fs')
  const st = process.env.FAKE_GLAB_CLOSED_STATE
  const closed = st && existsSync(st) && readFileSync(st, 'utf8').split('\n').includes(args[2])
  console.log(closed ? `#${args[2]}: closed` : `#${args[2]}: open`)
  process.exit(0)
}

console.error(`fake-glab: unhandled args: ${joined}`)
process.exit(1)
