// E2E for scripts/build-site.mjs: generates the catalog page into a temp dir and
// asserts the data-driven contract — the page carries the patterns, the links, the
// status, and the quickstart, all parsed from the repo's own files.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'

const S = 'site'
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(REPO, 'scripts', 'build-site.mjs')

// Every shipped slash command must surface in BOTH the generated site and the npm
// README — otherwise a command ships undiscoverable, the way /start-all once did
// (catalog issue #35). The command frontmatter is the single source of truth; this
// gate reads it directly so adding a command without documenting it fails the build.
function commandCoverage(html, readme) {
  const patternsDir = join(REPO, 'patterns')
  const fmField = (fm, name) => ((fm.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'm')) || [])[1] || '').trim()
  let commandCount = 0
  for (const pat of readdirSync(patternsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const cdir = join(patternsDir, pat.name, 'scaffold', '.claude', 'commands')
    if (!existsSync(cdir)) continue
    for (const f of readdirSync(cdir).filter((n) => n.endsWith('.md'))) {
      const name = '/' + f.replace(/\.md$/, '')
      const fm = (readFileSync(join(cdir, f), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
      const desc = fmField(fm, 'description')
      commandCount++
      check(S, `command ${name} has a non-empty description`, desc.length > 0)
      check(S, `command ${name} surfaces on the generated site`, html.includes(name))
      check(S, `command ${name} surfaces in README.md`, readme.includes(name))
      check(S, `command ${name} description surfaces on the site`, !desc || html.includes(desc.slice(0, 40)))
    }
  }
  check(S, 'coverage gate saw at least one command', commandCount > 0)
  // guard the guard: a name that is NOT a command must be absent — proves the
  // includes() checks discriminate rather than passing vacuously.
  check(S, 'coverage gate is non-vacuous (sentinel absent)', !html.includes('/definitely-not-a-real-command') && !readme.includes('/definitely-not-a-real-command'))
}

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

    // clay restyle contract (issue #19)
    check(S, 'loads Baloo 2 + Nunito from Google Fonts', html.includes('fonts.googleapis.com/css2') && html.includes('Baloo+2') && html.includes('Nunito'))
    check(S, 'Baloo 2 on headings, Nunito on body', /h1\{[^}]*Baloo 2/.test(html.replace(/\n/g, '')) && /body\{[^}]*Nunito/.test(html.replace(/\n/g, '')))
    check(S, 'mint page background is the default', html.includes('--page:#e0f3e0') && /body\{[^}]*background:var\(--page\)/.test(html.replace(/\n/g, '')))
    check(S, 'no emoji codepoints (icons are CSS-drawn)', !/[\u{1F000}-\u{1FBFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(html))
    check(S, 'copy button copies the quickstart and flips to Copied!', html.includes("writeText(q.textContent)") && html.includes("'Copied!'") && html.includes('id="qs"'))
    check(S, 'hover lift + active press on buttons', html.includes('.btn:hover{transform:translateY(-2px)') && html.includes('.btn:active{transform:translateY(1px)'))

    // doc/site command coverage gate (issue #35)
    check(S, 'site renders a Commands section', html.includes('class="cmds"') && html.includes('>Commands<'))
    commandCoverage(html, readFileSync(join(REPO, 'README.md'), 'utf8'))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
