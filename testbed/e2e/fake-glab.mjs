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

console.error(`fake-glab: unhandled args: ${joined}`)
process.exit(1)
