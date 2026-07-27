import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/clamp.mjs'
import { clamp } from '../src/clamp.mjs'

test('clamp returns n unchanged when it is inside the range', () => {
  assert.equal(clamp(5, 1, 10), 5)
})

test('clamp raises n up to lo when it is below the range', () => {
  assert.equal(clamp(-2, 1, 10), 1)
})

test('clamp lowers n down to hi when it is above the range', () => {
  assert.equal(clamp(99, 1, 10), 10)
})

test('clamp throws a RangeError when lo is greater than hi', () => {
  assert.throws(() => clamp(1, 10, 1), RangeError)
})

test('clamp treats both bounds as inclusive', () => {
  assert.equal(clamp(1, 1, 10), 1)
  assert.equal(clamp(10, 1, 10), 10)
})

test('clamp accepts the degenerate range where lo equals hi', () => {
  assert.equal(clamp(5, 3, 3), 3)
})

test('clamp is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.clamp, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['clamp'])
})

test('clamp is deterministic across repeated calls (no module-level state)', () => {
  assert.equal(clamp(99, 1, 10), 10)
  assert.equal(clamp(99, 1, 10), 10)
})
