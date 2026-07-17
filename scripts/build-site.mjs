#!/usr/bin/env node
// build-site.mjs — generates the catalog's GitHub Pages site from the catalog's own
// data (patterns/*/README.md + package.json). Never hand-edit the output: the page
// must not be able to drift from the pattern metadata.
//
// Usage: node scripts/build-site.mjs [--out <dir>]     (default: site/)
// Output: <out>/index.html (self-contained) + <out>/.nojekyll
//
// Style: claymorphism per catalog issue #17 — cream background, pastel clay palette,
// puffy cards, soft extruded shadows, rounded chunky type, emoji as clay icons.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const outIx = argv.indexOf('--out')
const OUT = outIx !== -1 && argv[outIx + 1] ? argv[outIx + 1] : join(ROOT, 'site')

const GITHUB = 'https://github.com/Ruihang2017/agent-templates'
const NPM = 'https://www.npmjs.com/package/agent-templates'
const QUICKSTART = 'npx agent-templates@latest adopt three-agent-architect-builder-reviewer .'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const strip = (s) => String(s).replace(/\*\*/g, '').replace(/`/g, '').trim()

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

function parsePattern(dir) {
  const path = join(ROOT, 'patterns', dir, 'README.md')
  if (!existsSync(path)) return null
  const md = readFileSync(path, 'utf8')
  const pick = (re) => (md.match(re) || [])[1] || ''

  const title = strip(pick(/^# Pattern: (.+)$/m)) || dir
  const statusRaw = strip(pick(/\|\s*\*\*Status\*\*\s*\|\s*([^|]+)\|/))
  const status = (statusRaw.match(/[a-z]+/) || ['proposed'])[0]
  const asOf = strip(pick(/\|\s*\*\*As-of date\*\*\s*\|\s*([^|]+)\|/))

  // the one-line topology summary: first plain paragraph after the metadata table
  let summary = ''
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l || l.startsWith('#') || l.startsWith('|') || l.startsWith('<!--')) continue
    summary = strip(l)
    break
  }

  // model/effort rows from §3
  const roles = []
  const sec3 = md.split(/^## 3\. Model \+ effort[^\n]*$/m)[1]
  if (sec3) {
    for (const row of sec3.split(/^## /m)[0].split('\n')) {
      const m = row.match(/^\|\s*([A-Z][^|]*?)\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|/)
      if (m && !/^Role/.test(m[1])) roles.push({ role: strip(m[1]), model: strip(m[2]), effort: m[3] })
    }
  }

  // first three "Use when" bullets from §1
  const useWhen = []
  const sec1 = md.split(/\*\*Use when:\*\*/)[1]
  if (sec1) {
    for (const l of sec1.split(/\*\*Do not use when:\*\*/)[0].split('\n')) {
      const m = l.match(/^- (.+)$/)
      if (m && useWhen.length < 3) useWhen.push(strip(m[1]))
    }
  }

  return { dir, title, status, asOf, summary, roles, useWhen }
}

const patterns = readdirSync(join(ROOT, 'patterns'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, 'patterns', d.name, 'scaffold')))
  .map((d) => parsePattern(d.name))
  .filter(Boolean)

const STATUS_STYLE = {
  proposed: ['var(--blue)', 'var(--blue-d)', '🧪'],
  trialed: ['var(--butter)', 'var(--butter-d)', '🌱'],
  adopted: ['var(--sage)', 'var(--sage-d)', '✅'],
  deprecated: ['var(--pink)', 'var(--pink-d)', '🗄️'],
}
const ROLE_EMOJI = { Architect: '📐', Builder: '🔨', Reviewer: '🔍' }
const roleEmoji = (r) => ROLE_EMOJI[Object.keys(ROLE_EMOJI).find((k) => r.startsWith(k))] || '🌙'

const patternCards = patterns
  .map((p) => {
    const [bg, fg, ico] = STATUS_STYLE[p.status] || STATUS_STYLE.proposed
    return `
      <article class="card pattern">
        <div class="pattern-head">
          <h3>${esc(p.title)}</h3>
          <span class="pill status" style="background:${bg};color:${fg}">${ico} ${esc(p.status)} · as of ${esc(p.asOf)}</span>
        </div>
        <p class="summary">${esc(p.summary)}</p>
        <div class="roles">
          ${p.roles.map((r) => `<span class="pill role">${roleEmoji(r.role)} <b>${esc(r.role)}</b>&nbsp;· ${esc(r.model)} <code>@${esc(r.effort)}</code></span>`).join('\n          ')}
        </div>
        ${p.useWhen.length ? `<ul class="usewhen">${p.useWhen.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}
        <div class="links">
          <a class="btn small sage" href="${GITHUB}/tree/main/patterns/${esc(p.dir)}">📖 Pattern write-up</a>
          <a class="btn small lav" href="${GITHUB}/tree/main/patterns/${esc(p.dir)}/scaffold">🧰 Scaffold</a>
        </div>
      </article>`
  })
  .join('\n')

const STEPS = [
  ['📦', 'Adopt', `<code>${esc(QUICKSTART)}</code> — scaffold, templates, docs skeleton, CLAUDE.md, in one idempotent command.`],
  ['🗺️', 'Break down', '<code>/breakdown-prd</code> — the Architect turns your PRD into sub-PRDs and cold-startable tickets, then stops.'],
  ['🚦', 'Gate 1 — you decide', 'Review the breakdown, then <code>/start-milestone</code>: tickets become tracker issues and the pipeline starts.'],
  ['🤖', 'Autonomous middle', 'Plan → build → fresh-context review (bounce-capped in code) → merge on CLEAR → issue closed → delivery verified.'],
  ['🔎', 'Gate 2 — smoke test', 'Agents own unit/integration/E2E all along; you test once, when the PRD is done. A nightly sweep fixes issues while you sleep.'],
]

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-templates — multi-agent patterns, ready to drop in</title>
<meta name="description" content="A catalog of multi-agent development architecture patterns: design write-ups plus drop-in scaffolding, E2E-tested, published on npm.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Nunito:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#f7f0e6; --card:#fdf8f2; --ink:#5b4a3f; --muted:#96826f;
    --sage:#cfe3d0; --sage-d:#5f9c6c; --peach:#f9d3b5; --peach-d:#d97f45;
    --pink:#f7c6d0; --pink-d:#cf6d87; --butter:#f7e0a8; --butter-d:#a97e1c;
    --blue:#c5d7ee; --blue-d:#5c82b6; --lav:#d9cdf0; --lav-d:#8266bd;
    --clay:0 10px 24px rgba(91,74,63,.13), inset 0 3px 8px rgba(255,255,255,.95), inset 0 -4px 8px rgba(91,74,63,.07);
    --clay-sm:0 6px 14px rgba(91,74,63,.12), inset 0 2px 5px rgba(255,255,255,.9), inset 0 -2px 5px rgba(91,74,63,.06);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 "Nunito",system-ui,sans-serif;
    background-image:radial-gradient(600px 300px at 85% -50px, rgba(247,198,208,.35), transparent 70%),
                     radial-gradient(500px 260px at -60px 30%, rgba(207,227,208,.4), transparent 70%),
                     radial-gradient(520px 300px at 110% 75%, rgba(217,205,240,.32), transparent 70%);}
  h1,h2,h3{font-family:"Baloo 2","Nunito",sans-serif;line-height:1.15;margin:0}
  a{color:inherit;text-decoration:none}
  .wrap{max-width:1060px;margin:0 auto;padding:28px 20px 60px}
  header.nav{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:26px}
  .logo{font-family:"Baloo 2",sans-serif;font-weight:800;font-size:1.35rem;background:var(--card);
    padding:10px 20px;border-radius:999px;box-shadow:var(--clay-sm);border:1.5px solid #fff}
  .nav .spacer{flex:1}
  .btn{display:inline-flex;align-items:center;gap:8px;font-weight:700;padding:10px 20px;border-radius:999px;
    box-shadow:var(--clay-sm);border:1.5px solid #fff;transition:transform .15s ease, box-shadow .15s ease;cursor:pointer}
  .btn:hover{transform:translateY(-2px)}
  .btn.small{padding:8px 14px;font-size:.9rem}
  .btn.sage{background:var(--sage);color:var(--sage-d)} .btn.peach{background:var(--peach);color:var(--peach-d)}
  .btn.blue{background:var(--blue);color:var(--blue-d)}  .btn.lav{background:var(--lav);color:var(--lav-d)}
  .card{background:var(--card);border-radius:28px;box-shadow:var(--clay);border:1.5px solid #fff;padding:26px 28px}
  .hero{display:grid;grid-template-columns:1.5fr 1fr;gap:22px;align-items:stretch;margin-bottom:22px}
  .hero .main{background:linear-gradient(145deg,#fbe3cd, #f9d3b5);}
  .hero h1{font-size:clamp(1.9rem,4.5vw,2.9rem);color:#7a4b28;margin-bottom:10px}
  .hero p.lede{color:#8a5a35;font-size:1.06rem;max-width:34em;margin:0 0 18px}
  .cta{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
  .quick{background:rgba(255,255,255,.75);border-radius:18px;box-shadow:var(--clay-sm);border:1.5px solid #fff;
    padding:12px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .quick code{font:600 .85rem/1.4 ui-monospace,Consolas,monospace;color:#7a4b28;word-break:break-all}
  .hero .side{display:flex;flex-direction:column;gap:14px;justify-content:center}
  .side .fact{display:flex;gap:12px;align-items:center;background:var(--card);border-radius:20px;
    box-shadow:var(--clay-sm);border:1.5px solid #fff;padding:12px 16px;font-weight:600}
  .side .fact .ico{font-size:1.5rem}
  .chips{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin:22px 0}
  .chip{border-radius:24px;padding:18px 20px;box-shadow:var(--clay);border:1.5px solid #fff}
  .chip .big{font-family:"Baloo 2",sans-serif;font-weight:800;font-size:1.7rem;display:block}
  .chip small{font-weight:700;opacity:.75}
  .chip.c1{background:var(--sage);color:var(--sage-d)} .chip.c2{background:var(--peach);color:var(--peach-d)}
  .chip.c3{background:var(--butter);color:var(--butter-d)} .chip.c4{background:var(--blue);color:var(--blue-d)}
  section{margin-top:34px}
  section > h2{font-size:1.6rem;margin-bottom:14px}
  .pattern{margin-bottom:18px}
  .pattern-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
  .pattern h3{font-size:1.3rem}
  .pill{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;font-weight:700;
    font-size:.85rem;box-shadow:var(--clay-sm);border:1.5px solid #fff}
  .summary{color:var(--muted);margin:6px 0 14px;font-weight:600}
  .roles{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
  .pill.role{background:#f3ece1;color:var(--ink)} .pill.role code{color:var(--lav-d)}
  .usewhen{margin:0 0 14px;padding-left:22px;color:var(--muted)} .usewhen li{margin:4px 0}
  .links{display:flex;gap:10px;flex-wrap:wrap}
  .steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px}
  .step{border-radius:24px;padding:20px;box-shadow:var(--clay);border:1.5px solid #fff;background:var(--card)}
  .step .n{display:inline-flex;width:44px;height:44px;align-items:center;justify-content:center;font-size:1.4rem;
    border-radius:16px;box-shadow:var(--clay-sm);border:1.5px solid #fff;margin-bottom:10px}
  .step:nth-child(1) .n{background:var(--sage)} .step:nth-child(2) .n{background:var(--butter)}
  .step:nth-child(3) .n{background:var(--peach)} .step:nth-child(4) .n{background:var(--lav)}
  .step:nth-child(5) .n{background:var(--pink)}
  .step h3{font-size:1.05rem;margin-bottom:6px} .step p{margin:0;font-size:.9rem;color:var(--muted)}
  .step code{font-size:.8rem;color:var(--lav-d);word-break:break-all}
  footer{margin-top:44px;text-align:center;color:var(--muted);font-weight:600;font-size:.9rem}
  footer a{color:var(--lav-d)}
  @media (max-width:760px){.hero{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header class="nav">
    <span class="logo">🏗️ agent-templates</span>
    <span class="spacer"></span>
    <a class="btn sage" href="${GITHUB}">⭐ GitHub</a>
    <a class="btn peach" href="${NPM}">📦 npm <span data-npm-version>v${esc(pkg.version)}</span></a>
  </header>

  <div class="hero">
    <div class="card main">
      <h1>Multi-agent patterns,<br>ready to drop in.</h1>
      <p class="lede">Field-proven architectures for AI-agent development — each one a design write-up <b>plus</b> working scaffolding. Humans decide at two gates; the agents do the rest.</p>
      <div class="cta">
        <a class="btn blue" href="${GITHUB}/blob/main/ADOPTING.md">🚀 Adoption guide</a>
        <a class="btn lav" href="${GITHUB}/blob/main/CLAUDE.md">📜 Operating manual</a>
      </div>
      <div class="quick"><code id="qs">${esc(QUICKSTART)}</code><button class="btn small butter" style="background:var(--butter);color:var(--butter-d)" onclick="navigator.clipboard.writeText(document.getElementById('qs').textContent).then(()=>{this.textContent='Copied ✓'})">Copy</button></div>
    </div>
    <div class="side">
      <div class="fact"><span class="ico">🧾</span> Every model/effort claim carries a source label and an expiry date</div>
      <div class="fact"><span class="ico">🛡️</span> Role boundaries enforced by hooks, not prose</div>
      <div class="fact"><span class="ico">🌙</span> Nightly sweep triages and fixes issues while you sleep</div>
    </div>
  </div>

  <div class="chips">
    <div class="chip c1"><span class="big">${patterns.length}</span><small>pattern${patterns.length === 1 ? '' : 's'} in the catalog</small></div>
    <div class="chip c2"><span class="big" data-npm-version>v${esc(pkg.version)}</span><small>on npm · MIT</small></div>
    <div class="chip c3"><span class="big">E2E</span><small>gated merges — deterministic, zero-token tests</small></div>
    <div class="chip c4"><span class="big">2</span><small>human gates: sign-off &amp; smoke test</small></div>
  </div>

  <section>
    <h2>🧩 Patterns</h2>
    ${patternCards}
  </section>

  <section>
    <h2>🛤️ From a bare PRD.md to shipped</h2>
    <div class="steps">
      ${STEPS.map(([ico, t, d], i) => `<div class="step"><span class="n">${ico}</span><h3>${i + 1}. ${t}</h3><p>${d}</p></div>`).join('\n      ')}
    </div>
  </section>

  <footer>
    Generated from the pattern catalog by <a href="${GITHUB}/blob/main/scripts/build-site.mjs">scripts/build-site.mjs</a>
    · ${new Date().toISOString().slice(0, 10)} · <a href="${GITHUB}/blob/main/LICENSE">MIT</a>
    · <a href="${GITHUB}/issues/new/choose">Feedback → issues</a>
  </footer>
</div>
<script>
fetch('https://registry.npmjs.org/agent-templates').then(r=>r.json()).then(d=>{
  var v=d['dist-tags']&&d['dist-tags'].latest;
  if(v){document.querySelectorAll('[data-npm-version]').forEach(function(e){e.textContent='v'+v})}
}).catch(function(){})
</script>
</body>
</html>
`

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'index.html'), html)
writeFileSync(join(OUT, '.nojekyll'), '')
console.log(`site: ${join(OUT, 'index.html')} (${patterns.length} pattern(s), pkg v${pkg.version})`)
