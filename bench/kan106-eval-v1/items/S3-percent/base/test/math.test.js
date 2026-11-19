'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { add } = require('../lib/math')

test('adds', () => {
  assert.equal(add(1, 1), 2)
})
