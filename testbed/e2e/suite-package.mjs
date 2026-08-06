// E2E for the DISTRIBUTED ARTIFACT (catalog issue #143).
//
// Everything else in this suite runs `adopt` from the checkout, where every catalog file
// obviously exists. Nothing ever exercised what npm actually ships — and that is exactly
// how #143 shipped: `integrations/` was missing from the `files` whitelist, so the tarball
// carried none of the Asana integration, `adopt` exited 0 having installed nothing of it,
// and then printed "Optional — mirror … /connect-asana" pointing at a README that was not
// in the package. Exit 0, nothing installed, instructions to use it.
//
// The required-path list is DERIVED FROM DISK, never hardcoded. A new integration, a new
// template directory, or a new top-level asset is therefore covered the moment it exists,
// without anyone remembering to update this file — which is the only version of this check
// that survives contact with a growing catalog.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'package'
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name)
    if (e.isDirectory()) yield* walk(f)
    else yield f
  }
}
const rel = (p) => relative(ROOT, p).replaceAll('\\', '/')

// Every path adopt.mjs reads out of the catalog. Mirrors the reads in adopt.mjs; if that
// grows a new source directory, add it here — the DIRECTORY is listed, never its contents.
function requiredPaths() {
  const out = []
  const patterns = join(ROOT, 'patterns')
  if (existsSync(patterns)) {
    for (const d of readdirSync(patterns, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      const sc = join(patterns, d.name, 'scaffold')
      if (existsSync(sc)) for (const f of walk(sc)) out.push(rel(f))
    }
  }
  const tmpl = join(ROOT, 'templates')
  if (existsSync(tmpl)) for (const f of walk(tmpl)) out.push(rel(f))
  const ints = join(ROOT, 'integrations')
  if (existsSync(ints)) {
    for (const d of readdirSync(ints, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      for (const f of walk(join(ints, d.name))) out.push(rel(f))
    }
  }
  for (const f of ['ADOPTING.md', 'CLAUDE.md', 'scripts/adopt.mjs', 'scripts/cli.mjs']) {
    if (existsSync(join(ROOT, f))) out.push(f)
  }
  return out
}

export async function run() {
  let packed = null
  try {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    packed = JSON.parse(out)[0].files.map((f) => f.path.replaceAll('\\', '/'))
  } catch (e) {
    check(S, 'npm pack --dry-run --json succeeded', false, String((e && e.message) || e).split('\n')[0])
    return
  }

  const required = requiredPaths()
  // Guard the guard in BOTH directions: an empty required list, or an empty manifest,
  // would make every assertion below pass while proving nothing.
  check(S, 'the required-path list is non-empty (derived from disk)', required.length > 20, `found ${required.length}`)
  check(S, 'the pack manifest is non-empty', packed.length > 20, `found ${packed.length}`)

  const inPack = new Set(packed)
  const missing = required.filter((p) => !inPack.has(p))
  check(S, 'every file adopt reads from the catalog is in the published tarball',
    missing.length === 0,
    missing.length ? `${missing.length} missing, e.g. ${missing.slice(0, 5).join(', ')}` : '')

  // Name the #143 case explicitly as well: the aggregate check above is right, but a
  // failure listing "37 missing" is easier to act on with the specific cause called out.
  const ints = join(ROOT, 'integrations')
  if (existsSync(ints)) {
    for (const d of readdirSync(ints, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      check(S, `integration ships in the tarball: ${d.name}`,
        packed.some((p) => p.startsWith(`integrations/${d.name}/`)),
        'add "integrations/" to package.json files')
    }
  }

  // The bin entry has to be there or `npx agent-templates` is dead on arrival.
  const pkg = JSON.parse(execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], { cwd: ROOT, encoding: 'utf8' }))
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {})
  check(S, 'package.json declares a bin', bins.length > 0)
  for (const b of bins) {
    check(S, `bin target ships in the tarball: ${b}`, inPack.has(b.replace(/^\.\//, '')))
  }
  eq(S, 'package is publishable (not private)', pkg.private === true, false)
}
