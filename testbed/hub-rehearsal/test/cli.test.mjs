// FR-4. Written from the PRD before any implementation exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../src/cli.mjs'

test('defaults when nothing is passed', () => {
  assert.deepEqual(parseArgs([]), { file: null, category: null, min: null, json: false })
})

test('every documented flag parses', () => {
  assert.deepEqual(parseArgs(['--file', 'a.csv', '--category', 'food', '--min', '10', '--json']),
    { file: 'a.csv', category: 'food', min: 1000, json: true })
})

test('--min goes through parseAmount', () => {
  assert.equal(parseArgs(['--min', '$1,234.56']).min, 123456)
  assert.throws(() => parseArgs(['--min', '1.5']),
    { name: 'RangeError', message: 'parseAmount: malformed amount' })
})

test('an unknown flag throws with the exact message', () => {
  assert.throws(() => parseArgs(['--nope']),
    { name: 'RangeError', message: 'parseArgs: unknown flag --nope' })
})

test('a value-taking flag with no value throws with the exact message', () => {
  assert.throws(() => parseArgs(['--file']),
    { name: 'RangeError', message: 'parseArgs: --file needs a value' })
})
