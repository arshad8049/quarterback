'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { formatClock } = require('../lib/clock')

test('ninety seconds', () => {
  assert.equal(formatClock(90), '1:30')
})
