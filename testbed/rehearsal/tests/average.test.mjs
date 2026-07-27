import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/average.mjs'
import { average } from '../src/average.mjs'

test('average returns the mean of an input with no duplicates', () => {
  assert.equal(average([1, 2, 3]), 2)
})

test('average de-duplicates first, so a repeated element counts once', () => {
  assert.equal(average([2, 2, 4]), 3)
})

test('average returns 0 for an empty input', () => {
  assert.equal(average([]), 0)
})

test('average handles a single-element input', () => {
  assert.equal(average([5]), 5)
})

test('average collapses an all-duplicate input to one distinct value', () => {
  assert.equal(average([2, 2, 2]), 2)
})

test('average returns a non-integer mean unrounded', () => {
  assert.equal(average([1, 2]), 1.5)
})

test('average handles negative numbers', () => {
  assert.equal(average([-1, 1]), 0)
})

test('average is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.average, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['average'])
})

test('average is deterministic across repeated calls (no module-level state)', () => {
  assert.equal(average([2, 2, 4]), 3)
  assert.equal(average([2, 2, 4]), 3)
})
