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
// the hub board is re-derived with the pattern's own scheduler, so the page cannot show
// an order the driver would not produce
import { parseBrief, readyBriefs } from '../../patterns/hub-and-spoke-orchestrator-executors/scaffold/.claude/scripts/brief.mjs'

const S = 'site'
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(REPO, 'scripts', 'build-site.mjs')

// Mirror build-site's own escaping, so a value containing & < > " is compared in the form
// it actually reaches the page rather than false-failing.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

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
  // Universal integration commands are installed into every adopted repo alongside the
  // pattern's own, so they are part of the same user-facing surface and must clear the
  // same gate. Enumerating only patterns/ would have let /connect-asana ship undocumented
  // — issue #35's hole, reopened through a different directory (issue #124).
  const integrationsDir = join(REPO, 'integrations')
  const commandDirs = [
    ...readdirSync(patternsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(patternsDir, d.name, 'scaffold', '.claude', 'commands')),
    ...(existsSync(integrationsDir)
      ? readdirSync(integrationsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => join(integrationsDir, d.name, '.claude', 'commands'))
      : []),
  ]
  for (const cdir of commandDirs) {
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
      // an author display rule beats the UA [hidden] rule; without this the boards stack.
      // Tolerant of a selector LIST (the phase demo shares the rule) but still requires
      // .lane-board[hidden] itself to be the thing set to display:none.
      check(S, 'lane demo restates [hidden] so only one board shows', /\.lane-board\[hidden\][^{]*\{display:none\}/.test(html))
      check(S, 'lane demo defaults to a single visible board',
        (html.match(/data-board="\d+" hidden/g) || []).length === 3)

      // Terminate the last chunk at its section: without this the final board absorbs
      // everything below it on the page, so a second demo further down silently
      // inflates its wave count (issue #115 tripped exactly that).
      const waveCounts = html.split(/data-board="/).slice(1)
        .map((chunk) => (chunk.split('</section>')[0].match(/class="lw"/g) || []).length)
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
      // Module identity must not rest on hue alone — every card carries its module name.
      // Page-wide on purpose, across every demo: a delivered card (`lt done`) is still a
      // ticket and still needs its chip; only `lt idle` placeholders are not tickets.
      const cards = (html.match(/class="lt"/g) || []).length + (html.match(/class="lt done"/g) || []).length
      const chips = (html.match(/class="lt-m"/g) || []).length
      eq(S, 'every ticket card on the page carries its module chip', chips, cards)
    }

    // Phase demo (issue #115): #112 shipped phased PRDs and the page explained none of
    // it — a whole capability went live invisible while every check stayed green,
    // because nothing gated CONTENT coverage. These assertions are that gate.
    {
      check(S, 'shows the phased-PRD section', /The project doesn't end at Gate 2/.test(html))
      check(S, 'states the document-splits-tree-does-not rule',
        /The PRD document splits by phase\. The ticket tree never does\./.test(html))
      check(S, 'carries the literal three-command sequence',
        html.includes('/breakdown-prd docs/PRD-02-billing.md') && html.includes('/start-all autonomous 2'))
      check(S, 'covers the freeze rule', /Delivered work is frozen/.test(html) && /added to/.test(html))
      check(S, 'covers drift — the skip is never silent', /Nothing is skipped silently/.test(html) && /drift/.test(html))
      check(S, 'Gate 2 is stated as per-phase, not once per project',
        /once per phase/.test(html) && /human gates per phase/.test(html))

      const phBoards = [...html.matchAll(/class="ph-board" data-phase="(\d)"/g)].map((m) => m[1])
      eq(S, 'phase demo renders one board per phase view', phBoards.join(','), '1,2')
      eq(S, 'exactly one phase board is visible by default',
        (html.match(/class="ph-board" data-phase="\d" hidden/g) || []).length, 1)

      // The cross-phase edge is the ONE fact this section exists to convey: a new
      // ticket blocked_by a delivered one. It only resolves because both phases live
      // in a single graph — split the tree and it becomes a dangling reference.
      check(S, 'phase demo renders the cross-phase dependency', /class="lt-x">&larr; 0201 &middot; phase 1</.test(html))
      check(S, 'phase demo marks phase-1 tickets delivered and skipped',
        /class="lt done"/.test(html) && /delivered &middot; skipped/.test(html))

      // Same contract as the lane demo: the waves must be the pipeline's own schedule,
      // recomputed here rather than trusted from the page.
      const deps = { '0103': ['0101', '0102'], '0201': ['0103'], '0202': ['0103'],
        'BIL-1': ['0201'], 'BIL-2': ['BIL-1'], 'BIL-3': ['BIL-1'], 'BIL-4': ['BIL-2', 'BIL-3'] }
      const expected = [['0101', '0102', '0103', '0201', '0202'], ['BIL-1', 'BIL-2', 'BIL-3', 'BIL-4']]
        .map((ids) => simulate(ids, (id) => deps[id] || [], 2).length)
      // `class="lw ph-done"` (the delivered strip) is deliberately not matched by the
      // exact `class="lw"` literal, so this counts waves only
      const phWaveCounts = html.split(/class="ph-board" data-phase="/).slice(1)
        .map((chunk) => (chunk.split('</section>')[0].match(/class="lw"/g) || []).length)
      eq(S, 'phase demo wave counts match the pipeline scheduler', phWaveCounts.join(','), expected.join(','))
      check(S, 'phase 2 schedules strictly fewer tickets than phase 1 delivered',
        (html.match(/class="lt done"/g) || []).length === 5)

      // guard the guard: a phase that does not exist must be absent, so the includes()
      // checks above are shown to discriminate rather than pass on any page
      check(S, 'phase coverage is non-vacuous (sentinel absent)',
        !html.includes('PRD-99-definitely-not-a-phase') && !html.includes('data-phase="7"'))
    }

    // Pattern tabs (issue #163). The catalog ships patterns that are NOT variants of each
    // other — one has an independent reviewer, one deliberately does not — so the page must
    // never present both flows on one scroll. These assertions are that guarantee.
    {
      const patternDirs = readdirSync(join(REPO, 'patterns'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(REPO, 'patterns', d.name, 'scaffold')))
        .map((d) => d.name)
      check(S, 'tab coverage gate saw the patterns', patternDirs.length >= 2)
      for (const dir of patternDirs) {
        check(S, `pattern ${dir} has a tab`, html.includes(`data-tab="${dir}"`))
        check(S, `pattern ${dir} has a pane`, html.includes(`data-pane="${dir}"`))
      }
      const panes = (html.match(/class="pane"/g) || []).length
      eq(S, 'one pane per pattern', panes, patternDirs.length)
      // exactly one visible: every pane but the default carries [hidden]
      eq(S, 'exactly one pane is visible by default',
        (html.match(/class="pane"[^>]*hidden/g) || []).length, patternDirs.length - 1)
      // an author rule must beat the UA [hidden] rule or every pane renders at once
      check(S, 'the [hidden] rule is restated for panes', /\.pane\[hidden\]\{display:none\}/.test(html))

      // Order is by status, not alphabetical: `proposed` must not be the landing tab,
      // because placement reads as a recommendation. hub-and-spoke sorts FIRST
      // alphabetically, so this assertion fails the moment the ordering is dropped.
      check(S, 'the signed-off pattern is the default tab, not the alphabetical first',
        html.indexOf('pane-three-agent-architect-builder-reviewer') < html.indexOf('pane-hub-and-spoke-orchestrator-executors'))
      // exactly one tab is pre-selected, and it is the one whose pane is visible
      eq(S, 'exactly one tab is pre-selected', (html.match(/aria-selected="true"/g) || []).length, 1)
      const selectedTab = (html.match(/<button class="tab"[^>]*aria-selected="true"[^>]*data-tab="([^"]+)"/) || [])[1]
      const visiblePane = (html.match(/<div class="pane"[^>]*data-pane="([^"]+)">/) || [])[1]
      eq(S, 'the pre-selected tab matches the visible pane', selectedTab, visiblePane)
      eq(S, 'the default tab is the signed-off pattern', selectedTab, 'three-agent-architect-builder-reviewer')

      // The adopt command must follow the tab. A quickstart pinned to one pattern while a
      // different pane is open is how somebody copies the wrong command and installs the
      // wrong guarantees.
      for (const dir of patternDirs) {
        check(S, `the tab script carries the adopt command for ${dir}`,
          html.includes(`adopt ${dir} .`))
      }
      check(S, 'switching a tab rewrites the quickstart', /qs\.textContent=QS\[dir\]/.test(html))

      // Content separation: each pattern's own commands appear, and the page states that
      // they do not carry across.
      check(S, 'the page says the patterns are not versions of each other',
        /not versions of each other/i.test(html))
      check(S, 'the page carries the old-to-new command mapping',
        /Coming from the three-agent pattern/.test(html) && html.includes('/hub-brief') && html.includes('/breakdown-prd'))
      check(S, 'the mapping names the commands with no equivalent',
        (html.match(/no equivalent/g) || []).length >= 3)
      check(S, 'the hub pane states the non-independent review',
        /not independent/i.test(html))
      // guard the guard: a pattern that does not exist must have no tab, proving the
      // includes() checks above discriminate rather than passing on any page
      check(S, 'tab coverage is non-vacuous (sentinel absent)',
        !html.includes('data-tab="definitely-not-a-pattern"') && !html.includes('data-pane="definitely-not-a-pattern"'))
    }

    // The hub pane must SHOW its artifact, not just name its commands (issue #165). The
    // three-agent pane renders a real dag.html miniature; without an equivalent the hub
    // pane described a flow whose central artifact — the brief — a reader never saw, and
    // "what granularity?" had no answer on the page.
    {
      check(S, 'the hub pane explains what a brief is', /What a brief is, and how big/.test(html))
      check(S, 'the granularity rule is stated, not implied',
        /One brief = one disjoint write-set/.test(html))
      // every frontmatter field a reader must fill is named
      for (const field of ['id', 'blocked_by', 'file_scope', 'test_cmd']) {
        check(S, `brief anatomy names the ${field} field`, html.includes(`>${field}<`))
      }
      // and every required body section, since an empty one is rejected by the validator
      for (const sec of ['## Contract', '## Deliverables', '## Done when', '## Out of scope']) {
        check(S, `brief anatomy names ${sec}`, html.includes(esc(sec)))
      }
      // The scoped-test_cmd finding from the 4-brief rehearsal must reach the page: it is
      // the mistake most likely to be made, and it fails every brief but the last.
      check(S, 'the page warns that test_cmd is per-brief, not whole-suite',
        /never the whole suite/i.test(html))

      // The wave board is recomputed here from the SAME committed briefs with the pattern's
      // own scheduler, so the page cannot advertise an order the driver would not produce.
      const briefsDir = join(REPO, 'testbed', 'hub-rehearsal', 'docs', 'briefs')
      check(S, 'the rehearsal briefs the page renders exist', existsSync(briefsDir))
      if (existsSync(briefsDir)) {
        const briefs = readdirSync(briefsDir).filter((f) => f.endsWith('.md')).sort()
          .map((f) => parseBrief(readFileSync(join(briefsDir, f), 'utf8'), f))
        const waves = []
        const done = []
        for (let g = 0; g < 10; g++) {
          const w = readyBriefs(briefs, done)
          if (!w.length) break
          waves.push(w)
          for (const b of w) done.push(b.data.id)
        }
        const chunk = (html.split('data-hub-board')[1] || '').split('</section>')[0]
        eq(S, 'hub board renders one row per wave', (chunk.match(/class="lw"/g) || []).length, waves.length)
        eq(S, 'hub board schedules every brief', (chunk.match(/class="lt"/g) || []).length, briefs.length)
        check(S, 'hub board has more than one wave — it must show a real dependency',
          waves.length >= 2)
        for (const b of briefs) {
          check(S, `hub board shows brief ${b.data.id}`, chunk.includes(esc(b.data.id)))
          check(S, `hub board shows the write-set for ${b.data.id}`, chunk.includes(esc(b.data.file_scope[0])))
        }
        // wave 1 must contain exactly the briefs with no dependencies — if this ever
        // matched everything, the board would be a flat list pretending to be a schedule
        const firstRow = chunk.split('class="lw"')[1] || ''
        for (const b of waves[0]) check(S, `wave 1 contains ${b.data.id}`, firstRow.includes(esc(b.data.id)))
        for (const b of (waves[1] || [])) check(S, `wave 1 does NOT contain the blocked ${b.data.id}`, !firstRow.includes(esc(b.data.id)))
      }
      // the hub board must not disturb the lane demo's arithmetic, which splits the page
      // on data-board= and counts waves per chunk
      check(S, 'the hub board does not register as a lane-demo board',
        !/data-board="hub/.test(html))
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
