import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/paginate.mjs'
import { paginate } from '../src/paginate.mjs'

test('paginate chunks by a size already inside the range, leaving the tail short', () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 2, 4), [[1, 2], [3, 4], [5]])
})

test('paginate clamps a size above maxSize down to maxSize', () => {
  assert.deepEqual(paginate([1, 2, 3], 99, 2), [[1, 2], [3]])
})

test('paginate clamps a size below 1 up to 1', () => {
  assert.deepEqual(paginate([1, 2, 3], 0, 4), [[1], [2], [3]])
})

test('paginate returns an empty array for an empty input', () => {
  assert.deepEqual(paginate([], 2, 4), [])
})

test('paginate handles a maxSize of 1, where the clamp range degenerates to [1, 1]', () => {
  assert.deepEqual(paginate([1, 2, 3], 5, 1), [[1], [2], [3]])
})

test('paginate is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.paginate, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['paginate'])
})

test('paginate is deterministic across repeated calls (no module-level state)', () => {
  assert.deepEqual(paginate([1, 2, 3], 2, 4), [[1, 2], [3]])
  assert.deepEqual(paginate([1, 2, 3], 2, 4), [[1, 2], [3]])
})
