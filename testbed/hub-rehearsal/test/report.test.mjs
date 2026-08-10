// FR-3. Written from the PRD before any implementation exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarize } from '../src/report.mjs'

const sample = [
  { merchant: 'United Airlines', amount: '$1,200.00' },
  { merchant: 'Blue Bottle Coffee', amount: '4.50' },
  { merchant: 'GitHub', amount: '$21.00' },
  { merchant: 'Airport Cafe', amount: '12.75' },
]

test('summarize totals in cents and counts rows', () => {
  const s = summarize(sample)
  assert.equal(s.total, 120000 + 450 + 2100 + 1275)
  assert.equal(s.count, 4)
})

test('byCategory holds only categories that occurred, keys sorted', () => {
  const s = summarize(sample)
  assert.deepEqual(Object.keys(s.byCategory), ['food', 'software', 'travel'])
  assert.equal(s.byCategory.travel, 120000 + 1275) // Airport Cafe is travel, not food
  assert.equal(s.byCategory.food, 450)
  assert.equal(s.byCategory.software, 2100)
})

test('an empty report is well formed', () => {
  assert.deepEqual(summarize([]), { total: 0, byCategory: {}, count: 0 })
})

test('summarize rejects non-arrays with the exact message', () => {
  assert.throws(() => summarize(null), { name: 'TypeError', message: 'summarize: not an array' })
})

test('a malformed amount propagates the RangeError unchanged', () => {
  assert.throws(() => summarize([{ merchant: 'x', amount: '1.5' }]),
    { name: 'RangeError', message: 'parseAmount: malformed amount' })
})
