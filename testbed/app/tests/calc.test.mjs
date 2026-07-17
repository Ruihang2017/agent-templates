import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, multiply } from '../src/calc.mjs'

test('add', () => {
  assert.equal(add(2, 3), 5)
  assert.equal(add(-1, 1), 0)
})

test('multiply', () => {
  assert.equal(multiply(3, 4), 12)
  assert.equal(multiply(-2, 5), -10)
})
