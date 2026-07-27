import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/chunk.mjs'
import { chunk } from '../src/chunk.mjs'

test('chunk splits an array into consecutive chunks, leaving the tail short', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

test('chunk returns an empty array for an empty input', () => {
  assert.deepEqual(chunk([], 3), [])
})

test('chunk throws a RangeError when size is zero', () => {
  assert.throws(() => chunk([1], 0), RangeError)
})

test('chunk throws a RangeError when size is negative', () => {
  assert.throws(() => chunk([1, 2], -1), RangeError)
})

test('chunk throws a RangeError on an unusable size even for an empty input', () => {
  assert.throws(() => chunk([], 0), RangeError)
})

test('chunk accepts a size of 1, the smallest legal size', () => {
  assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]])
})

test('chunk returns a single chunk when size exceeds the input length', () => {
  assert.deepEqual(chunk([1, 2, 3], 99), [[1, 2, 3]])
})

test('chunk does not mutate the input array', () => {
  const input = [1, 2, 3, 4, 5]
  chunk(input, 2)
  assert.deepEqual(input, [1, 2, 3, 4, 5])
})

test('chunk is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.chunk, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['chunk'])
})

test('chunk is deterministic across repeated calls (no module-level state)', () => {
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]])
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]])
})
