// FR-1. Written from the PRD before any implementation exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAmount, parseAmount } from '../src/money.mjs'

test('parseAmount handles the documented forms', () => {
  assert.equal(parseAmount('$1,234.56'), 123456)
  assert.equal(parseAmount('1234.56'), 123456)
  assert.equal(parseAmount('7'), 700)
  assert.equal(parseAmount('$0.05'), 5)
  assert.equal(parseAmount('0'), 0)
})

test('parseAmount rejects the wrong number of decimal places', () => {
  assert.throws(() => parseAmount('1.5'), { name: 'RangeError', message: 'parseAmount: malformed amount' })
  assert.throws(() => parseAmount('1.500'), { name: 'RangeError', message: 'parseAmount: malformed amount' })
  assert.throws(() => parseAmount('abc'), { name: 'RangeError', message: 'parseAmount: malformed amount' })
  assert.throws(() => parseAmount(''), { name: 'RangeError', message: 'parseAmount: malformed amount' })
})

test('parseAmount rejects non-strings with the exact message', () => {
  assert.throws(() => parseAmount(5), { name: 'TypeError', message: 'parseAmount: not a string' })
  assert.throws(() => parseAmount(null), { name: 'TypeError', message: 'parseAmount: not a string' })
})

test('formatAmount matches the documented output', () => {
  assert.equal(formatAmount(123456), '$1,234.56')
  assert.equal(formatAmount(0), '$0.00')
  assert.equal(formatAmount(5), '$0.05')
  assert.equal(formatAmount(-5), '-$0.05')
  assert.equal(formatAmount(100000000), '$1,000,000.00')
})

test('formatAmount rejects non-integers with the exact message', () => {
  assert.throws(() => formatAmount(1.5), { name: 'TypeError', message: 'formatAmount: not an integer' })
  assert.throws(() => formatAmount('7'), { name: 'TypeError', message: 'formatAmount: not an integer' })
})

test('parse and format round-trip', () => {
  for (const n of [0, 5, 99, 100, 12345, 123456, 100000000]) {
    assert.equal(parseAmount(formatAmount(n)), n, `round-trip failed for ${n}`)
  }
})
