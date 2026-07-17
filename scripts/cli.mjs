#!/usr/bin/env node
// agent-templates CLI — the npx entry point (package.json "bin").
// Dispatches to the catalog tooling; carries no logic of its own.
//
//   agent-templates list                                      show available patterns
//   agent-templates adopt <pattern> <target-dir> [options]    install a pattern (see adopt.mjs)
//
// Without cloning the catalog:
//   npx github:Ruihang2017/agent-templates list
//   npx github:Ruihang2017/agent-templates adopt three-agent-architect-builder-reviewer .

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'adopt') {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'adopt.mjs'), ...rest], { stdio: 'inherit' })
  process.exit(r.status === null ? 1 : r.status)
}

if (cmd === 'list') {
  const dir = join(ROOT, 'patterns')
  const patterns = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'scaffold')))
        .map((d) => d.name)
    : []
  console.log(patterns.length ? patterns.join('\n') : '(no patterns found)')
  process.exit(0)
}

const usage = `agent-templates — multi-agent pattern catalog

usage:
  agent-templates list
  agent-templates adopt <pattern> <target-dir> [--platform gh|glab] [--force]

without cloning:
  npx github:Ruihang2017/agent-templates list
  npx github:Ruihang2017/agent-templates adopt three-agent-architect-builder-reviewer .

docs: ADOPTING.md in the catalog root`
if (!cmd) {
  console.log(usage)
  process.exit(0)
}
console.error(`unknown command: ${cmd}\n\n${usage}`)
process.exit(1)
