import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/unique.mjs'
import { unique } from '../src/unique.mjs'

test('unique removes duplicates', () => {
  assert.deepEqual(unique([1, 2, 2, 3, 1]), [1, 2, 3])
})

test('unique returns an empty array for an empty input', () => {
  assert.deepEqual(unique([]), [])
})

test('unique preserves first-seen order rather than sorting', () => {
  assert.deepEqual(unique([3, 1, 3, 2, 1]), [3, 1, 2])
})

test('unique returns an input without duplicates unchanged in content', () => {
  assert.deepEqual(unique([1, 2, 3]), [1, 2, 3])
})

test('unique deduplicates non-numeric elements too', () => {
  assert.deepEqual(unique(['a', 'b', 'a']), ['a', 'b'])
})

test('unique returns a new array, not the input array', () => {
  const input = [1, 2, 3]
  assert.notEqual(unique(input), input)
})

test('unique returns a new array even for an empty input', () => {
  const empty = []
  assert.notEqual(unique(empty), empty)
})

test('unique does not mutate the input array', () => {
  const input = [1, 2, 2, 3, 1]
  unique(input)
  assert.deepEqual(input, [1, 2, 2, 3, 1])
})

test('unique is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.unique, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['unique'])
})

test('unique is deterministic across repeated calls (no module-level state)', () => {
  assert.deepEqual(unique([1, 2, 2, 3, 1]), [1, 2, 3])
  assert.deepEqual(unique([1, 2, 2, 3, 1]), [1, 2, 3])
})
