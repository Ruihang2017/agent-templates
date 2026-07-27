import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/camel.mjs'
import { camel } from '../src/camel.mjs'

test('camel drops the hyphen and uppercases the letter that follows', () => {
  assert.equal(camel('hello-world'), 'helloWorld')
})

test('camel handles every hyphen, and the first letter stays lowercase', () => {
  assert.equal(camel('a-b-c'), 'aBC')
})

test('camel returns an empty string for empty input', () => {
  assert.equal(camel(''), '')
})

test('camel leaves the rest of each segment untouched', () => {
  assert.equal(camel('hello-world-again'), 'helloWorldAgain')
})

test('camel is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.camel, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['camel'])
})

test('camel is deterministic across repeated calls (no module-level state)', () => {
  assert.equal(camel('a-b-c'), 'aBC')
  assert.equal(camel('a-b-c'), 'aBC')
})
