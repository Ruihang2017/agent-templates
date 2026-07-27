import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/kebab.mjs'
import { kebab } from '../src/kebab.mjs'

test('kebab splits a camelCase hump and lowercases the result', () => {
  assert.equal(kebab('helloWorld'), 'hello-world')
})

test('kebab lowercases a space-separated string and joins it with a single -', () => {
  assert.equal(kebab('Hello World'), 'hello-world')
})

test('kebab returns an empty string for empty input', () => {
  assert.equal(kebab(''), '')
})

test('kebab collapses a whitespace run into exactly one -', () => {
  assert.equal(kebab('hello   world'), 'hello-world')
})

test('kebab treats a capital after a digit as an interior capital', () => {
  assert.equal(kebab('foo2Bar'), 'foo2-bar')
})

test('kebab is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.kebab, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['kebab'])
})

test('kebab is deterministic across repeated calls (no module-level state)', () => {
  assert.equal(kebab('helloWorld'), 'hello-world')
  assert.equal(kebab('helloWorld'), 'hello-world')
})
