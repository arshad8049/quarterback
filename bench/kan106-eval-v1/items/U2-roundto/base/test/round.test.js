'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { roundTo } = require('../lib/round')

test('two places', () => {
  assert.equal(roundTo(1.234, 2), 1.23)
})
