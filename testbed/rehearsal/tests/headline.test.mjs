import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/headline.mjs'
import { headline } from '../src/headline.mjs'

test('headline slugifies, de-hyphenates and title-cases the input', () => {
  assert.equal(headline('hello, world!'), 'Hello World')
})

test('headline collapses separator runs and trims the edges', () => {
  assert.equal(headline('  A -- B  '), 'A B')
})

test('headline turns every `-` back into a space, not just the first', () => {
  assert.equal(headline('one two three'), 'One Two Three')
})

test('headline returns an empty string for empty input', () => {
  assert.equal(headline(''), '')
})

test('headline returns an empty string when slugify strips the whole input', () => {
  assert.equal(headline('!!!'), '')
})

test('headline is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.headline, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['headline'])
})

test('headline is deterministic across repeated calls (no module-level state)', () => {
  assert.equal(headline('hello, world!'), 'Hello World')
  assert.equal(headline('hello, world!'), 'Hello World')
})
