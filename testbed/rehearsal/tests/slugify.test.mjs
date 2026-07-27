import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/slugify.mjs'
import { slugify } from '../src/slugify.mjs'

test('slugify lowercases and joins words with a single -', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
})

test('slugify collapses separator runs and trims the edges', () => {
  assert.equal(slugify('  A -- B  '), 'a-b')
})

test('slugify returns an empty string for empty input', () => {
  assert.equal(slugify(''), '')
})

test('slugify collapses any run of non-alphanumerics, including underscores', () => {
  assert.equal(slugify('Foo   Bar'), 'foo-bar')
  assert.equal(slugify('a_b'), 'a-b')
  assert.equal(slugify('---'), '')
})

test('slugify is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.slugify, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['slugify'])
})

test('slugify is deterministic across repeated calls (no module-level state)', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('Hello, World!'), 'hello-world')
})
