import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/identifier.mjs'
import { identifier } from '../src/identifier.mjs'

test('identifier kebab-cases the input, then camel-cases that result', () => {
  assert.equal(identifier('Hello World'), 'helloWorld')
})

test('identifier camel-cases input that is already kebab-case', () => {
  assert.equal(identifier('already-kebab'), 'alreadyKebab')
})

test('identifier returns an empty string for empty input', () => {
  assert.equal(identifier(''), '')
})

test('identifier handles every separator, not just the first', () => {
  assert.equal(identifier('Hello Big World'), 'helloBigWorld')
})

test('identifier is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.identifier, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['identifier'])
})

test('identifier is deterministic across repeated calls (no module-level state)', () => {
  assert.equal(identifier('a-b-c'), 'aBC')
  assert.equal(identifier('a-b-c'), 'aBC')
})
