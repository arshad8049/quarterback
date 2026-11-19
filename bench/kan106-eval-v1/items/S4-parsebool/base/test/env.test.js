'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseBool } = require('../lib/env')

test('empty is false', () => {
  assert.equal(parseBool(''), false)
})
