'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { slugify } = require('../lib/slug')

test('lowercases', () => {
  assert.equal(slugify('ABC'), 'abc')
})
