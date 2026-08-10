// FR-2. Written from the PRD before any implementation exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { categorize } from '../src/categorize.mjs'

test('each rule matches, case-insensitively and by substring', () => {
  assert.equal(categorize('United Airlines'), 'travel')
  assert.equal(categorize('GRAND HOTEL'), 'travel')
  assert.equal(categorize('railway co'), 'travel')
  assert.equal(categorize('Blue Bottle Coffee'), 'food')
  assert.equal(categorize('the CAFE'), 'food')
  assert.equal(categorize('Sushi Restaurant'), 'food')
  assert.equal(categorize('Some SaaS Inc'), 'software')
  assert.equal(categorize('Hosting Ltd'), 'software')
  assert.equal(categorize('GitHub'), 'software')
  assert.equal(categorize('Corner Shop'), 'other')
})

test('rule ORDER is part of the contract', () => {
  // contains both "air" and "cafe"; travel is checked first
  assert.equal(categorize('Airport Cafe'), 'travel')
  // contains both "cafe" and "hosting"; food is checked before software
  assert.equal(categorize('Cafe Hosting'), 'food')
})

test('categorize rejects non-strings with the exact message', () => {
  assert.throws(() => categorize(7), { name: 'TypeError', message: 'categorize: not a string' })
})
