import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/sum.mjs'
import { sum } from '../src/sum.mjs'

test('sum adds up the elements of an array', () => {
  assert.equal(sum([1, 2, 3]), 6)
})

test('sum returns 0 for an empty input', () => {
  assert.equal(sum([]), 0)
})

test('sum throws a TypeError when an element is NaN', () => {
  assert.throws(() => sum([1, NaN]), TypeError)
})

test('sum throws a TypeError when an element is Infinity or -Infinity', () => {
  assert.throws(() => sum([1, Infinity]), TypeError)
  assert.throws(() => sum([1, -Infinity]), TypeError)
})

test('sum throws a TypeError when an element is a boolean', () => {
  assert.throws(() => sum([true, 1]), TypeError)
})

test('sum throws a TypeError when an element is null', () => {
  assert.throws(() => sum([1, null]), TypeError)
})

test('sum throws a TypeError when an element is a numeric string', () => {
  assert.throws(() => sum([1, '2']), TypeError)
})

test('sum handles negative numbers and a single-element input', () => {
  assert.equal(sum([-1, 1]), 0)
  assert.equal(sum([-5]), -5)
})

test('sum does not mutate the input array', () => {
  const input = [3, 1, 2]
  sum(input)
  assert.deepEqual(input, [3, 1, 2])
})

test('sum is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.sum, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['sum'])
})

test('sum is deterministic across repeated calls (no module-level state)', () => {
  assert.equal(sum([1, 2, 3]), 6)
  assert.equal(sum([1, 2, 3]), 6)
})
