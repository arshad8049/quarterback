'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { formatCents } = require('../lib/money')

test('one dollar', () => {
  assert.equal(formatCents(100), '$1.00')
})
