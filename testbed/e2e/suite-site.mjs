// E2E for scripts/build-site.mjs: generates the catalog page into a temp dir and
// asserts the data-driven contract — the page carries the patterns, the links, the
// status, and the quickstart, all parsed from the repo's own files.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq } from './lib.mjs'
// same scheduler model the site and the runner use, so the demo cannot drift
import { simulate } from '../../patterns/three-agent-architect-builder-reviewer/scaffold/.claude/scripts/dag-core.mjs'

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
  // match the site's own escaping so a description with & < > " does not false-fail
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
      // delimited matches so a future /start-all-fast can't substring-satisfy /start-all
      check(S, `command ${name} surfaces on the generated site`, html.includes('>' + esc(name) + '<'))
      check(S, `command ${name} surfaces in README.md`, readme.includes('`' + name + '`'))
      check(S, `command ${name} description surfaces on the site`, !desc || html.includes(esc(desc.slice(0, 40))))
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
    check(S, 'shows pinned models from README §3', html.includes('Claude Sonnet 5') && html.includes('Claude Opus 5'))
    // issue #111: the Reviewer left Fable 5. build-site renders only §3's role/model/effort
    // columns (never the rationale prose, which still cites Fable 5 as history), so a
    // "Fable" on the page can only mean the page was built from a stale §3 — the exact
    // drift that shipped a pre-Opus-5 model table to the live site for eight PRs (#109).
    check(S, 'no retired model pin reaches the page', !html.includes('Fable'))
    check(S, 'live-version fallback from package.json', /data-npm-version>v\d+\.\d+\.\d+/.test(html))
    check(S, 'registry live-fetch present', html.includes('registry.npmjs.org/agent-templates'))
    // issue #62: the parallel-lanes feature is surfaced on the site
    check(S, 'shows the parallel-delivery section', /Parallel delivery/i.test(html) && html.includes('concurrency') && html.includes('/start-all autonomous 4'))
    check(S, 'no unescaped template failure', !html.includes('undefined') && !html.includes('[object Object]'))

    // Lane demo (issue #73): a miniature of docs/prd/dag.html on the marketing page.
    // The point of these checks is that the site cannot advertise a schedule the runner
    // would not produce — the wave counts are recomputed here from dag-core, the same
    // model build-site.mjs and the pipeline use, and compared against the rendered page.
    {
      check(S, 'shows the lane-demo section', /See the plan before you run it/.test(html))
      check(S, 'lane demo explains where the real page lives', /docs\/prd\/dag\.html/.test(html))
      check(S, 'lane demo says it needs no server', /no server/i.test(html))
      check(S, 'lane demo says how to regenerate it', /dag-report\.mjs docs\/prd/.test(html))
      check(S, 'lane demo covers mid-run progress', /reloads the DAG every few finished tickets/i.test(html))

      const boards = [...html.matchAll(/data-board="(\d+)"/g)].map((m) => m[1])
      eq(S, 'lane demo renders one board per lane count', boards.join(','), '1,2,4,6')
      // an author display rule beats the UA [hidden] rule; without this the boards stack
      check(S, 'lane demo restates [hidden] so only one board shows', /\.lane-board\[hidden\]\{display:none\}/.test(html))
      check(S, 'lane demo defaults to a single visible board',
        (html.match(/data-board="\d+" hidden/g) || []).length === 3)

      const waveCounts = html.split(/data-board="/).slice(1)
        .map((chunk) => (chunk.match(/class="lw"/g) || []).length)
      const ids = ['0101', '0102', '0103', '0104', '0105', '0201', '0202', '0203', '0204', '0205', '0301', '0302', '0303', '0401', '0402']
      const deps = { '0103': ['0101'], '0104': ['0102'], '0105': ['0103', '0104'],
        '0201': ['0105'], '0202': ['0105'], '0203': ['0105'], '0204': ['0105'], '0205': ['0201'],
        '0302': ['0301'], '0303': ['0302'] }
      const expected = [1, 2, 4, 6].map((c) => simulate(ids, (id) => deps[id] || [], c).length)
      eq(S, 'lane demo wave counts match the pipeline scheduler', waveCounts.join(','), expected.join(','))
      check(S, 'more lanes are never slower on the demo graph',
        expected.every((v, i) => i === 0 || v <= expected[i - 1]))
      check(S, 'the demo graph actually demonstrates a saturation point',
        expected[expected.length - 1] === expected[expected.length - 2])
      // module identity must not rest on hue alone — every card carries its module name
      const cards = (html.match(/class="lt"/g) || []).length
      const chips = (html.match(/class="lt-m"/g) || []).length
      eq(S, 'every demo ticket card carries its module chip', chips, cards)
    }

    // clay restyle contract (issue #19)
    check(S, 'loads Baloo 2 + Nunito from Google Fonts', html.includes('fonts.googleapis.com/css2') && html.includes('Baloo+2') && html.includes('Nunito'))
    check(S, 'Baloo 2 on headings, Nunito on body', /h1\{[^}]*Baloo 2/.test(html.replace(/\n/g, '')) && /body\{[^}]*Nunito/.test(html.replace(/\n/g, '')))
    check(S, 'mint page background is the default', html.includes('--page:#e0f3e0') && /body\{[^}]*background:var\(--page\)/.test(html.replace(/\n/g, '')))
    check(S, 'no emoji codepoints (icons are CSS-drawn)', !/[\u{1F000}-\u{1FBFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(html))
    check(S, 'copy button copies the quickstart and flips to Copied!', html.includes("writeText(q.textContent)") && html.includes("'Copied!'") && html.includes('id="qs"'))
    check(S, 'hover lift + active press on buttons', html.includes('.btn:hover{transform:translateY(-2px)') && html.includes('.btn:active{transform:translateY(1px)'))

    // doc/site command coverage gate (issue #35)
    check(S, 'site renders a Commands section', html.includes('class="cmds"') && html.includes('>Commands<'))
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
    commandCoverage(html, readme)

    // update-command coverage (issue #44): the "update an existing install" command must
    // surface in BOTH the README and the site so it can't silently drop.
    const UPDATE = 'npx agent-templates@latest adopt three-agent-architect-builder-reviewer . --force'
    check(S, 'README documents the --force update command', readme.includes(UPDATE))
    check(S, 'ADOPTING documents the --force update command', readFileSync(join(REPO, 'ADOPTING.md'), 'utf8').includes(UPDATE))
    check(S, 'site surfaces the --force update command', html.includes(UPDATE))
    check(S, 'site renders the update note', html.includes('class="update-note"'))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
