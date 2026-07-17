// E2E for scripts/build-site.mjs: generates the catalog page into a temp dir and
// asserts the data-driven contract — the page carries the patterns, the links, the
// status, and the quickstart, all parsed from the repo's own files.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'site'
const SCRIPT = fileURLToPath(new URL('../../scripts/build-site.mjs', import.meta.url))

export async function run() {
  const out = mkdtempSync(join(tmpdir(), 'e2e-site-'))
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--out', out], { encoding: 'utf8' })
    eq(S, 'build exits 0', r.status, 0)
    check(S, '.nojekyll emitted', existsSync(join(out, '.nojekyll')))
    const htmlPath = join(out, 'index.html')
    check(S, 'index.html emitted', existsSync(htmlPath))
    if (!existsSync(htmlPath)) return
    const html = readFileSync(htmlPath, 'utf8')

    check(S, 'has <title>', /<title>agent-templates/.test(html))
    check(S, 'links GitHub repo', html.includes('https://github.com/Ruihang2017/agent-templates'))
    check(S, 'links npm package', html.includes('https://www.npmjs.com/package/agent-templates'))
    check(S, 'carries the quickstart command', html.includes('npx agent-templates@latest adopt three-agent-architect-builder-reviewer'))
    check(S, 'shows the seed pattern title', html.includes('Three-Agent Architect'))
    check(S, 'shows the pattern status pill', /(trialed|adopted|proposed)/.test(html))
    check(S, 'shows pinned models from README §3', html.includes('Claude Sonnet 5') && html.includes('Claude Opus 4.8') && html.includes('Claude Fable 5'))
    check(S, 'live-version fallback from package.json', /data-npm-version>v\d+\.\d+\.\d+/.test(html))
    check(S, 'registry live-fetch present', html.includes('registry.npmjs.org/agent-templates'))
    check(S, 'no unescaped template failure', !html.includes('undefined') && !html.includes('[object Object]'))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
