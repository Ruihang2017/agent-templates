#!/usr/bin/env node
// build-site.mjs — generates the catalog's GitHub Pages site from the catalog's own
// data (patterns/*/README.md + package.json). Never hand-edit the output: the page
// must not be able to drift from the pattern metadata.
//
// Usage: node scripts/build-site.mjs [--out <dir>]     (default: site/)
// Output: <out>/index.html (self-contained) + <out>/.nojekyll
//
// Style: clay-morphism per the approved hi-fi mock on catalog issue #19 — layered
// clay shadows (outer drop + inset top highlight + inset bottom ink), Baloo 2 +
// Nunito, five build-time palettes with mint baked as default, pure-CSS clay icons
// (no emoji, no icon fonts). The mock is the source of truth for colors/shadows/
// spacing; the pattern catalog stays the source of truth for all copy.

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

  return { dir, title, status, asOf, summary, roles }
}

const patterns = readdirSync(join(ROOT, 'patterns'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, 'patterns', d.name, 'scaffold')))
  .map((d) => parsePattern(d.name))
  .filter(Boolean)

// ---------------------------------------------------------------------------
// Theme palettes, distilled from the approved mock (issue #19). The mock names
// them cream / mint / lavender / sakura / sky; mint is the approved default.
// Swapping the palette is a build-time constant change — no runtime switcher.
// amb/ins/flt are bare R,G,B triplets consumed via rgba(var(--amb), a).
// ---------------------------------------------------------------------------
const THEMES = {
  cream:    { page: '#ffeecb', heroA: '#fbd2b0', heroB: '#f5b98f', heroInk: 'rgba(190,110,60,0.18)', heroAmb: 'rgba(199,141,109,0.32)', heroTitle: '#5a3520', heroBody: '#8a5a3d', card: '#fdf4e6', pill: '#fff7e9', ink: '#4a3020', sub: '#7b5a42', mut: '#a3805f', code: '#7b4a2a', amb: '199,141,109', ins: '214,160,120', flt: '150,90,60' },
  mint:     { page: '#e0f3e0', heroA: '#c3e6bd', heroB: '#a3d49a', heroInk: 'rgba(40,110,50,0.18)', heroAmb: 'rgba(110,160,120,0.35)', heroTitle: '#2f5a30', heroBody: '#4f7a52', card: '#f0f9ec', pill: '#f8fdf5', ink: '#2f4a28', sub: '#567a50', mut: '#7fa077', code: '#4f6b3a', amb: '110,150,115', ins: '160,195,155', flt: '80,120,85' },
  lavender: { page: '#f0e7fa', heroA: '#ddcbf3', heroB: '#c4abe8', heroInk: 'rgba(90,50,140,0.16)', heroAmb: 'rgba(140,110,180,0.35)', heroTitle: '#46306b', heroBody: '#6b5490', card: '#f6f1fc', pill: '#fbf9fe', ink: '#3f2f5c', sub: '#6b5a86', mut: '#9284ab', code: '#5f4a8a', amb: '130,110,165', ins: '185,165,215', flt: '100,80,135' },
  sakura:   { page: '#fde7ee', heroA: '#f9c9d7', heroB: '#f3abc2', heroInk: 'rgba(180,60,100,0.15)', heroAmb: 'rgba(190,120,140,0.35)', heroTitle: '#6b2f45', heroBody: '#96556b', card: '#fcf1f5', pill: '#fef8fa', ink: '#5c2f40', sub: '#86566a', mut: '#ab8494', code: '#8a4a62', amb: '180,120,140', ins: '215,165,185', flt: '150,80,105' },
  sky:      { page: '#e3eefa', heroA: '#c8ddf4', heroB: '#a8c7ec', heroInk: 'rgba(50,90,150,0.15)', heroAmb: 'rgba(110,140,180,0.35)', heroTitle: '#2c4a6b', heroBody: '#4f6f96', card: '#eff5fc', pill: '#f7fafe', ink: '#2b3f5c', sub: '#52698a', mut: '#8095ad', code: '#3f5a80', amb: '100,130,170', ins: '155,180,215', flt: '70,100,140' },
}
const THEME = THEMES.mint

// Status chips: trialed/adopted/proposed use the mock's yellow/green("stable")/
// pink("experimental") recipes; deprecated (catalog-only status) is a neutral clay.
const STATUS_CHIP = {
  trialed:    { chip: 'background:linear-gradient(180deg,#f9d66e,#f0c14a);color:#6b4a15;box-shadow:inset 0 2px 2px rgba(255,255,255,0.6),inset 0 -3px 4px rgba(180,120,20,0.3),0 5px 10px rgba(180,130,60,0.3)', dot: 'inset -1px -1px 2px rgba(180,120,20,0.4)' },
  proposed:   { chip: 'background:linear-gradient(180deg,#f792ab,#ef6f92);color:#fff;text-shadow:0 1px 2px rgba(170,30,80,0.35);box-shadow:inset 0 2px 2px rgba(255,255,255,0.5),inset 0 -3px 4px rgba(170,30,80,0.3),0 5px 10px rgba(199,100,110,0.3)', dot: 'inset -1px -1px 2px rgba(170,30,80,0.35)' },
  adopted:    { chip: 'background:linear-gradient(180deg,#b3dcab,#98cb8e);color:#fff;text-shadow:0 1px 2px rgba(30,90,40,0.35);box-shadow:inset 0 2px 2px rgba(255,255,255,0.5),inset 0 -3px 4px rgba(30,100,40,0.28),0 5px 10px rgba(120,150,100,0.3)', dot: 'inset -1px -1px 2px rgba(30,90,40,0.35)' },
  deprecated: { chip: 'background:linear-gradient(180deg,#cfc4b4,#b8aa96);color:#fff;text-shadow:0 1px 2px rgba(110,90,60,0.35);box-shadow:inset 0 2px 2px rgba(255,255,255,0.5),inset 0 -3px 4px rgba(110,90,60,0.3),0 5px 10px rgba(150,130,100,0.3)', dot: 'inset -1px -1px 2px rgba(110,90,60,0.35)' },
}

const ROLE_DOT = {
  Architect: ['#a98fd6', 'rgba(80,40,140,0.3)'],
  Builder: ['#f28ba3', 'rgba(170,30,80,0.3)'],
  Reviewer: ['#8fb4e6', 'rgba(40,80,150,0.3)'],
}
const roleDot = (r) => ROLE_DOT[Object.keys(ROLE_DOT).find((k) => r.startsWith(k))] || ['#f2c44e', 'rgba(180,120,20,0.35)']

// --- pure-CSS clay icons, markup lifted from the approved mock -------------
const LOGO_ICON = `<span class="gx" style="width:26px;height:26px;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="position:absolute;left:1px;top:2px;width:15px;height:20px;border-radius:5px;background:#b7a0e2;transform:rotate(-9deg);box-shadow:inset 0 2px 2px rgba(255,255,255,0.5)"></span><span style="position:absolute;left:9px;top:3px;width:15px;height:20px;border-radius:5px;background:var(--pill);transform:rotate(7deg);box-shadow:inset 0 -2px 3px rgba(var(--ins),0.35);display:flex;flex-direction:column;gap:3px;padding:4px 3px;box-sizing:border-box"><span style="height:2.5px;border-radius:2px;background:#f4a0b5"></span><span style="height:2.5px;border-radius:2px;background:#d9c8f0"></span><span style="height:2.5px;border-radius:2px;background:#d9c8f0;width:70%"></span></span></span>`
const STAR_ICON = `<span style="width:14px;height:14px;background:#f9d66e;clip-path:polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%);display:inline-block"></span>`
const NPM_ICON = `<span class="gx" style="width:14px;height:14px"><span style="position:absolute;inset:0;border-radius:4px;background:#fff3df;box-shadow:inset 0 -2px 3px rgba(190,110,60,0.4)"></span><span style="position:absolute;left:0;right:0;top:5.5px;height:3px;background:#e8b48c"></span></span>`
const PATTERNS_ICON = `<span style="display:inline-grid;grid-template-columns:9px 9px;gap:2.5px;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="width:9px;height:9px;border-radius:3px;background:#9ed095"></span><span style="width:9px;height:9px;border-radius:3px;background:#f6a5bb"></span><span style="width:9px;height:9px;border-radius:3px;background:#f4cd6d"></span><span style="width:9px;height:9px;border-radius:3px;background:#c3abe9"></span></span>`
const PIPELINE_ICON = `<span class="gx" style="width:22px;height:18px;border-radius:5px;background:#a9c6ec;overflow:hidden;filter:drop-shadow(0 2px 3px rgba(var(--flt),0.3))"><span style="position:absolute;left:3px;top:3px;width:6px;height:6px;border-radius:50%;background:#f9d66e"></span><span style="position:absolute;left:-5px;bottom:-9px;width:17px;height:17px;border-radius:50%;background:#9ed095"></span><span style="position:absolute;right:-4px;bottom:-8px;width:15px;height:15px;border-radius:50%;background:#8fc98b"></span></span>`

// hero side facts: [icon-tile style, glyph markup, copy]
const FACTS = [
  ['background:#d9c8f0;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(90,50,140,0.18)',
    `<span class="gx" style="width:15px;height:18px"><span style="position:absolute;inset:0;border-radius:3px;background:#fffaf2;box-shadow:0 2px 4px rgba(90,50,140,0.25)"></span><span style="position:absolute;left:3px;right:3px;top:4px;height:2px;border-radius:2px;background:#c3abe9"></span><span style="position:absolute;left:3px;right:3px;top:8px;height:2px;border-radius:2px;background:#c3abe9"></span><span style="position:absolute;left:3px;right:6px;top:12px;height:2px;border-radius:2px;background:#c3abe9"></span></span>`,
    'Every model/effort claim carries a source label and an expiry date'],
  ['background:#b3cdf0;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(40,80,150,0.2)',
    `<span style="width:16px;height:18px;background:#fffaf2;border-radius:5px 5px 50% 50% / 5px 5px 75% 75%;box-shadow:inset 0 -3px 4px rgba(40,80,150,0.25),0 2px 4px rgba(40,80,150,0.3);display:inline-block"></span>`,
    'Role boundaries enforced by hooks, not prose'],
  ['background:#f9d66e;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.6),inset -3px -4px 6px rgba(180,120,20,0.25)',
    `<span class="gx" style="width:17px;height:17px"><span style="position:absolute;inset:0;border-radius:50%;background:#fffaf2;box-shadow:0 2px 4px rgba(160,100,20,0.3)"></span><span style="position:absolute;left:6px;top:-2px;width:14px;height:14px;border-radius:50%;background:#f9d66e"></span></span>`,
    'Nightly sweep triages and fixes issues while you sleep'],
]

// pipeline steps: [icon-tile style, glyph markup, title, description]
const STEPS = [
  ['background:#9ed095;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(30,90,40,0.2),0 6px 10px rgba(var(--amb),0.22)',
    `<span class="gx" style="width:20px;height:16px"><span style="position:absolute;inset:0;border-radius:4px;background:#fffaf2;box-shadow:inset 0 -2px 3px rgba(30,90,40,0.2),0 3px 5px rgba(30,90,40,0.3)"></span><span style="position:absolute;left:8.5px;top:0;width:3px;height:16px;background:#f4cd6d"></span></span>`,
    'Adopt', `<code>${esc(QUICKSTART)}</code> — scaffold, templates, docs skeleton, CLAUDE.md, in one idempotent command.`],
  ['background:#f4cd6d;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.6),inset -3px -4px 6px rgba(180,120,20,0.25),0 6px 10px rgba(var(--amb),0.22)',
    `<span class="gx" style="width:22px;height:16px"><span style="position:absolute;inset:0;border-radius:3px;background:#fffaf2;box-shadow:0 3px 5px rgba(160,100,20,0.3)"></span><span style="position:absolute;left:6.5px;top:0;width:1.5px;height:16px;background:rgba(var(--flt),0.25)"></span><span style="position:absolute;left:14px;top:0;width:1.5px;height:16px;background:rgba(var(--flt),0.25)"></span><span style="position:absolute;left:9px;top:5px;width:4px;height:4px;border-radius:50%;background:#f2789a"></span></span>`,
    'Break down', '<code>/breakdown-prd</code> — the Architect turns your PRD into sub-PRDs and cold-startable tickets, then stops.'],
  ['background:#f3e6d0;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.7),inset -3px -4px 6px rgba(170,120,70,0.2),0 6px 10px rgba(var(--amb),0.22)',
    `<span style="width:13px;height:28px;border-radius:6.5px;background:#7a6a58;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;box-shadow:inset 0 2px 2px rgba(255,255,255,0.25),0 3px 5px rgba(90,60,30,0.35)"><span style="width:6px;height:6px;border-radius:50%;background:#f28b8b"></span><span style="width:6px;height:6px;border-radius:50%;background:#f9d66e"></span><span style="width:6px;height:6px;border-radius:50%;background:#8fc98b"></span></span>`,
    'Gate 1 — you decide', 'Review the breakdown, then <code>/start-milestone</code>: tickets become tracker issues and the pipeline starts.'],
  ['background:#c3abe9;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(90,50,140,0.22),0 6px 10px rgba(var(--amb),0.22)',
    `<span class="gx" style="width:24px;height:24px"><span style="position:absolute;left:11px;top:0;width:2px;height:4px;background:#fffaf2"></span><span style="position:absolute;left:9.5px;top:-3px;width:5px;height:5px;border-radius:50%;background:#f2789a"></span><span style="position:absolute;left:0;top:5px;width:24px;height:18px;border-radius:7px;background:#fffaf2;box-shadow:inset 0 -3px 4px rgba(90,50,140,0.2),0 3px 5px rgba(70,30,120,0.3)"></span><span style="position:absolute;left:5px;top:11px;width:5px;height:5px;border-radius:50%;background:#8f74c4"></span><span style="position:absolute;left:14px;top:11px;width:5px;height:5px;border-radius:50%;background:#8f74c4"></span></span>`,
    'Autonomous middle', 'Plan → build → fresh-context review (bounce-capped in code) → merge on <code>CLEAR</code> → issue closed → delivery verified.'],
  ['background:#f6a5bb;box-shadow:inset 2px 3px 4px rgba(255,255,255,0.55),inset -3px -4px 6px rgba(170,30,80,0.2),0 6px 10px rgba(var(--amb),0.22)',
    `<span class="gx" style="width:22px;height:22px"><span style="position:absolute;left:0;top:0;width:13px;height:13px;border-radius:50%;border:4px solid #fffaf2;box-shadow:0 3px 5px rgba(150,60,90,0.3)"></span><span style="position:absolute;left:16px;top:15px;width:4.5px;height:9px;border-radius:2.5px;background:#fffaf2;transform:rotate(-45deg)"></span></span>`,
    'Gate 2 — smoke test', 'Agents own unit/integration/E2E all along; you test once, when the PRD is done. A nightly sweep fixes issues while you sleep.'],
]

// Use-when bullets are still parsed upstream of the mock era but intentionally not
// rendered: the approved mock's pattern card is title + status chip + summary +
// role chips + links only.
const patternCards = patterns
  .map((p) => {
    const c = STATUS_CHIP[p.status] || STATUS_CHIP.proposed
    const summary = esc(p.summary).replace(/→/g, '<span class="arr">→</span>')
    return `
      <article class="panel pattern">
        <div class="pattern-head">
          <h3>${esc(p.title)}</h3>
          <span class="chip" style="${c.chip}"><span class="chip-dot" style="box-shadow:${c.dot}"></span>${esc(p.status)} · as of ${esc(p.asOf)}</span>
        </div>
        <p class="summary">${summary}</p>
        <div class="roles">
          ${p.roles.map((r) => { const [dot, dotInk] = roleDot(r.role); return `<span class="role"><span class="dot" style="background:${dot};box-shadow:inset 1px 1.5px 1.5px rgba(255,255,255,0.6),inset -1px -1.5px 2px ${dotInk}"></span><b>${esc(r.role)}</b><span class="sep">·</span><code>${esc(r.model)} <span class="eff">@${esc(r.effort)}</span></code></span>` }).join('\n          ')}
        </div>
        <div class="links">
          <a class="btn btn-green" href="${GITHUB}/tree/main/patterns/${esc(p.dir)}">Pattern write-up</a>
          <a class="btn btn-purple" href="${GITHUB}/tree/main/patterns/${esc(p.dir)}/scaffold">Scaffold</a>
        </div>
      </article>`
  })
  .join('\n')

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-templates — multi-agent patterns, ready to drop in</title>
<meta name="description" content="A catalog of multi-agent development architecture patterns: design write-ups plus drop-in scaffolding, E2E-tested, published on npm.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Nunito:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root{
    --page:${THEME.page}; --hero-a:${THEME.heroA}; --hero-b:${THEME.heroB};
    --hero-ink:${THEME.heroInk}; --hero-amb:${THEME.heroAmb};
    --hero-title:${THEME.heroTitle}; --hero-body:${THEME.heroBody};
    --card:${THEME.card}; --pill:${THEME.pill};
    --ink:${THEME.ink}; --sub:${THEME.sub}; --mut:${THEME.mut}; --code:${THEME.code};
    --amb:${THEME.amb}; --ins:${THEME.ins}; --flt:${THEME.flt};
    --mono:ui-monospace,'Cascadia Code',Consolas,Menlo,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--page);font-family:'Nunito',sans-serif}
  a{color:#e7548c;text-decoration:none}
  a:hover{color:#c13a63}
  .wrap{max-width:880px;margin:0 auto;padding:22px 0 34px}
  .gx{position:relative;display:inline-block}
  .arr{color:#e7548c}

  .nav{display:flex;align-items:center;margin-bottom:22px}
  .logo{display:flex;align-items:center;gap:10px;padding:8px 18px 8px 13px;border-radius:19px;background:var(--pill);
    box-shadow:inset 0 2px 2px #fff,inset 0 -3px 5px rgba(var(--ins),0.2),0 8px 16px rgba(var(--amb),0.25)}
  .logo b{font-family:'Baloo 2',cursive;font-weight:800;font-size:19px;color:var(--ink)}
  .nav-links{margin-left:auto;display:flex;gap:10px}

  .btn{display:inline-flex;align-items:center;gap:8px;padding:9px 18px;border-radius:18px;color:#fff;
    font-size:12.5px;font-weight:900;transition:transform .15s ease;cursor:pointer}
  .btn:hover{transform:translateY(-2px);color:#fff}
  .btn:active{transform:translateY(1px)}
  .btn-lg{padding:10px 20px;font-size:13px}
  .btn-green{background:linear-gradient(180deg,#b3dcab,#98cb8e);text-shadow:0 1px 2px rgba(30,90,40,0.35);
    box-shadow:inset 0 2px 3px rgba(255,255,255,0.5),inset 0 -3px 5px rgba(30,100,40,0.25),0 8px 14px rgba(120,150,100,0.35)}
  .btn-orange{background:linear-gradient(180deg,#f6c9a2,#efb185);text-shadow:0 1px 2px rgba(160,80,30,0.35);
    box-shadow:inset 0 2px 3px rgba(255,255,255,0.5),inset 0 -3px 5px rgba(170,90,30,0.25),0 8px 14px rgba(190,130,90,0.35)}
  .btn-blue{background:linear-gradient(180deg,#b3cdf0,#96b8e5);text-shadow:0 1px 2px rgba(40,80,150,0.4);
    box-shadow:inset 0 2px 3px rgba(255,255,255,0.55),inset 0 -3px 5px rgba(40,80,150,0.28),0 8px 14px rgba(var(--amb),0.3)}
  .btn-purple{background:linear-gradient(180deg,#c3abe9,#a78cd8);text-shadow:0 1px 2px rgba(90,50,130,0.4);
    box-shadow:inset 0 2px 3px rgba(255,255,255,0.55),inset 0 -4px 6px rgba(94,58,140,0.28),0 8px 14px rgba(var(--amb),0.3)}

  .hero{display:grid;grid-template-columns:1fr 300px;gap:16px;align-items:stretch}
  .hero-main{border-radius:30px;padding:30px 34px 26px;background:linear-gradient(170deg,var(--hero-a),var(--hero-b));
    box-shadow:inset 0 3px 4px rgba(255,255,255,0.6),inset 0 -6px 10px var(--hero-ink),0 16px 30px var(--hero-amb)}
  .hero-main h1{margin:0;font-family:'Baloo 2',cursive;font-weight:800;font-size:38px;line-height:1.1;
    color:var(--hero-title);text-shadow:0 2px 0 rgba(255,255,255,0.4)}
  .lede{margin:14px 0 0;max-width:410px;font-size:13.5px;line-height:1.6;font-weight:700;color:var(--hero-body)}
  .cta{display:flex;gap:12px;margin-top:20px}
  .quick{margin-top:20px;border-radius:16px;background:var(--pill);padding:14px 16px 12px;
    box-shadow:inset 0 3px 6px rgba(var(--flt),0.2),inset 0 -2px 2px rgba(255,255,255,0.8)}
  .quick code{display:block;font-family:var(--mono);font-size:12px;font-weight:700;color:var(--code);line-height:1.55;word-break:break-all}
  .copy{display:inline-flex;margin-top:10px;padding:6px 16px;border-radius:13px;border:0;
    background:linear-gradient(180deg,#f9d66e,#f0c14a);cursor:pointer;font-family:'Nunito',sans-serif;
    font-size:12px;font-weight:900;color:#6b4a15;transition:transform .15s ease;
    box-shadow:inset 0 2px 2px rgba(255,255,255,0.6),inset 0 -3px 4px rgba(180,120,20,0.3),0 5px 10px rgba(180,130,60,0.3)}
  .copy:hover{transform:translateY(-1.5px)}
  .copy:active{transform:translateY(1px)}
  .hero-side{display:flex;flex-direction:column;gap:14px;justify-content:center}
  .fact{display:flex;align-items:center;gap:12px;padding:13px 16px;border-radius:20px;background:var(--card);
    box-shadow:inset 0 2px 2px #fff,inset 0 -3px 6px rgba(var(--ins),0.16),0 10px 20px rgba(var(--amb),0.22)}
  .fact-ico{flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center}
  .fact p{margin:0;font-size:12.5px;font-weight:800;color:var(--sub);line-height:1.5}

  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin-top:18px}
  .stat{border-radius:22px;padding:16px 18px 18px}
  .stat .big{font-family:'Baloo 2',cursive;font-weight:800;font-size:23px}
  .stat p{margin:3px 0 0;font-size:11.5px;font-weight:800;line-height:1.5}
  .stat-green{background:linear-gradient(180deg,#b9dfb1,#9bce92);
    box-shadow:inset 0 3px 4px rgba(255,255,255,0.55),inset 0 -5px 8px rgba(30,90,40,0.2),0 10px 20px rgba(var(--amb),0.25)}
  .stat-green .big{color:#2f6b35} .stat-green p{color:#3f7a45}
  .stat-orange{background:linear-gradient(180deg,#f9cba6,#f1af85);
    box-shadow:inset 0 3px 4px rgba(255,255,255,0.55),inset 0 -5px 8px rgba(170,90,30,0.2),0 10px 20px rgba(var(--amb),0.25)}
  .stat-orange .big{color:#94481c} .stat-orange p{color:#9c5426}
  .stat-yellow{background:linear-gradient(180deg,#fae09c,#f3cb6a);
    box-shadow:inset 0 3px 4px rgba(255,255,255,0.6),inset 0 -5px 8px rgba(180,120,20,0.22),0 10px 20px rgba(var(--amb),0.25)}
  .stat-yellow .big{color:#7e5a12} .stat-yellow p{color:#8a6218}
  .stat-blue{background:linear-gradient(180deg,#b7d2f4,#9abfe9);
    box-shadow:inset 0 3px 4px rgba(255,255,255,0.55),inset 0 -5px 8px rgba(40,80,150,0.22),0 10px 20px rgba(var(--amb),0.25)}
  .stat-blue .big{color:#2c548c} .stat-blue p{color:#315e9c}

  .sec-head{display:flex;align-items:center;gap:11px;margin:32px 0 14px}
  .sec-head h2{margin:0;font-family:'Baloo 2',cursive;font-weight:800;font-size:25px;color:var(--ink)}

  .panel{border-radius:24px;background:var(--card);padding:20px 24px 22px;
    box-shadow:inset 0 2px 2px #fff,inset 0 -4px 8px rgba(var(--ins),0.15),0 14px 26px rgba(var(--amb),0.25)}
  .pattern + .pattern{margin-top:16px}
  .pattern-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .pattern-head h3{margin:0;font-family:'Baloo 2',cursive;font-weight:700;font-size:20px;color:var(--ink);flex:1}
  .chip{display:inline-flex;align-items:center;gap:7px;padding:7px 15px;border-radius:15px;font-size:11.5px;font-weight:900}
  .chip-dot{width:8px;height:8px;border-radius:50%;background:#fffaf2}
  .summary{margin:12px 0 0;font-size:13px;line-height:1.6;font-weight:700;color:var(--sub);max-width:760px}
  .roles{display:flex;flex-wrap:wrap;gap:10px;margin-top:15px}
  .role{display:inline-flex;align-items:center;gap:8px;padding:8px 15px;border-radius:16px;background:var(--pill);
    box-shadow:inset 0 2px 2px #fff,inset 0 -3px 5px rgba(var(--ins),0.25),0 5px 10px rgba(var(--amb),0.2)}
  .role .dot{width:9px;height:9px;border-radius:50%}
  .role b{font-size:12px;font-weight:900;color:var(--ink)}
  .role .sep{font-size:11px;font-weight:700;color:var(--mut)}
  .role code{font-family:var(--mono);font-size:11px;font-weight:700;color:#8a5fd0}
  .role .eff{color:#e7548c}
  .links{display:flex;gap:12px;margin-top:17px}

  .steps{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}
  .step{border-radius:20px;background:var(--card);padding:15px 14px 17px;
    box-shadow:inset 0 2px 2px #fff,inset 0 -3px 6px rgba(var(--ins),0.15),0 10px 20px rgba(var(--amb),0.22)}
  .step-ico{width:42px;height:42px;border-radius:13px;display:grid;place-items:center}
  .step h3{margin:11px 0 0;font-size:13px;font-weight:900;color:var(--ink);font-family:'Nunito',sans-serif}
  .step p{margin:6px 0 0;font-size:11.5px;font-weight:700;color:var(--sub);line-height:1.55}
  .step code{font-family:var(--mono);font-size:10px;background:rgba(var(--flt),0.12);border-radius:5px;padding:1px 4px;color:var(--code);word-break:break-all}

  footer{margin-top:30px;text-align:center;font-size:12.5px;font-weight:700;color:var(--mut)}
  footer code{font-family:var(--mono);font-size:11.5px;color:#8a5fd0}

  @media (max-width:912px){.wrap{padding-left:16px;padding-right:16px}}
  @media (max-width:860px){.hero{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.steps{grid-template-columns:repeat(2,1fr)}}
  @media (max-width:540px){.stats,.steps{grid-template-columns:1fr}.pattern-head h3{flex-basis:100%}}
</style>
</head>
<body>
<div class="wrap">
  <header class="nav">
    <span class="logo">${LOGO_ICON}<b>agent-templates</b></span>
    <span class="nav-links">
      <a class="btn btn-green" href="${GITHUB}">${STAR_ICON} GitHub</a>
      <a class="btn btn-orange" href="${NPM}">${NPM_ICON} npm&nbsp;&nbsp;<span data-npm-version>v${esc(pkg.version)}</span></a>
    </span>
  </header>

  <div class="hero">
    <div class="hero-main">
      <h1>Multi-agent patterns,<br>ready to drop in.</h1>
      <p class="lede">Field-proven architectures for AI-agent development — each one a design write-up <em>plus</em> working scaffolding. Humans decide at two gates; the agents do the rest.</p>
      <div class="cta">
        <a class="btn btn-lg btn-blue" href="${GITHUB}/blob/main/ADOPTING.md">Adoption guide</a>
        <a class="btn btn-lg btn-purple" href="${GITHUB}/blob/main/CLAUDE.md">Operating manual</a>
      </div>
      <div class="quick">
        <code id="qs">${esc(QUICKSTART)}</code>
        <button class="copy" id="copy-btn" type="button">Copy</button>
      </div>
    </div>
    <div class="hero-side">
      ${FACTS.map(([tile, glyph, copy]) => `<div class="fact"><span class="fact-ico" style="${tile}">${glyph}</span><p>${copy}</p></div>`).join('\n      ')}
    </div>
  </div>

  <div class="stats">
    <div class="stat stat-green"><span class="big">${patterns.length}</span><p>pattern${patterns.length === 1 ? '' : 's'} in the catalog</p></div>
    <div class="stat stat-orange"><span class="big" data-npm-version>v${esc(pkg.version)}</span><p>on npm · MIT</p></div>
    <div class="stat stat-yellow"><span class="big">E2E</span><p>gated merges — deterministic, zero-token tests</p></div>
    <div class="stat stat-blue"><span class="big">2</span><p>human gates: sign-off &amp; smoke test</p></div>
  </div>

  <section>
    <div class="sec-head">${PATTERNS_ICON}<h2>Patterns</h2></div>
    ${patternCards}
  </section>

  <section>
    <div class="sec-head">${PIPELINE_ICON}<h2>From a bare PRD.md to shipped</h2></div>
    <div class="steps">
      ${STEPS.map(([tile, glyph, t, d], i) => `<div class="step"><span class="step-ico" style="${tile}">${glyph}</span><h3>${i + 1}. ${t}</h3><p>${d}</p></div>`).join('\n      ')}
    </div>
  </section>

  <footer>
    Generated from the pattern catalog by <a href="${GITHUB}/blob/main/scripts/build-site.mjs"><code>scripts/build-site.mjs</code></a>
    · ${new Date().toISOString().slice(0, 10)} · <a href="${GITHUB}/blob/main/LICENSE">MIT</a>
    · <a href="${GITHUB}/issues/new/choose">Feedback → issues</a>
  </footer>
</div>
<script>
(function(){
  var b=document.getElementById('copy-btn'),q=document.getElementById('qs'),t
  if(!b||!q)return
  b.addEventListener('click',function(){
    try{navigator.clipboard.writeText(q.textContent)}catch(e){}
    b.textContent='Copied!'
    clearTimeout(t)
    t=setTimeout(function(){b.textContent='Copy'},1400)
  })
})()
fetch('https://registry.npmjs.org/agent-templates').then(function(r){return r.json()}).then(function(d){
  var v=d['dist-tags']&&d['dist-tags'].latest
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
