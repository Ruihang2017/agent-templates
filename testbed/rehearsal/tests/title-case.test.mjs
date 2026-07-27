import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/title-case.mjs'
import { titleCase } from '../src/title-case.mjs'

test('titleCase uppercases the first letter of every whitespace-separated word', () => {
  assert.equal(titleCase('hello world'), 'Hello World')
})

test('titleCase uppercases a single-character word', () => {
  assert.equal(titleCase('a'), 'A')
})

test('titleCase returns an empty string for empty input', () => {
  assert.equal(titleCase(''), '')
})

test('titleCase leaves the rest of each word untouched', () => {
  assert.equal(titleCase('HELLO wORLD'), 'HELLO WORLD')
})

test('titleCase is exported as a named export, with no default export', () => {
  assert.equal(typeof mod.titleCase, 'function')
  assert.equal(mod.default, undefined)
  assert.deepEqual(Object.keys(mod), ['titleCase'])
})

test('titleCase is deterministic across repeated calls (no module-level state)', () => {
  assert.equal(titleCase('hello world'), 'Hello World')
  assert.equal(titleCase('hello world'), 'Hello World')
})
