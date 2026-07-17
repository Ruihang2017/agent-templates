#!/usr/bin/env node
// Level-0 E2E entry point: exercises the pattern's deterministic chain end to end
// with zero tokens and zero network. Usage: node testbed/e2e/run-e2e.mjs
// Exit 0 = green. Repo rule: this must be green before merging scaffold changes.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { check, summarize } from './lib.mjs'

const suites = ['suite-integrity.mjs', 'suite-guard.mjs', 'suite-publish.mjs', 'suite-runner.mjs']

console.log('three-agent pattern — Level-0 E2E\n')

for (const name of suites) {
  console.log(`suite: ${name}`)
  try {
    const mod = await import(new URL('./' + name, import.meta.url))
    await mod.run()
  } catch (e) {
    check(name, 'suite crashed', false, e && e.stack ? e.stack.split('\n')[0] : String(e))
  }
  console.log('')
}

// the testbed app's own suite must be green too (it is the Level-1 target)
{
  const appDir = fileURLToPath(new URL('../app/', import.meta.url))
  const r = spawnSync(process.execPath, ['--test'], { cwd: appDir, encoding: 'utf8' })
  check('app', 'testbed app `node --test` green', r.status === 0, (r.stdout || '').split('\n').find((l) => /fail/.test(l)) || '')
}

process.exit(summarize() ? 0 : 1)
