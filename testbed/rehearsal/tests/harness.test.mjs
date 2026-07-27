import { test } from 'node:test'
import assert from 'node:assert/strict'

// Seed test so `node --test testbed/rehearsal/tests/` has a target before any rehearsal
// ticket has landed. Delivered tickets add their own files alongside this one.
test('rehearsal harness is wired', () => {
  assert.equal(1 + 1, 2)
})
