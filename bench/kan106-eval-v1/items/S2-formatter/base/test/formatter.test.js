'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Formatter = require('../lib/formatter')

test('custom separator', () => {
  assert.equal(new Formatter({ separator: ';' }).join(['x', 'y']), 'x;y')
})
