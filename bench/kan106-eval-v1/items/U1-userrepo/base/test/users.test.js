'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const UserRepo = require('../lib/users')

test('finds a known user', () => {
  const repo = new UserRepo(new Map([[1, { id: 1 }]]))
  assert.deepEqual(repo.find(1), { id: 1 })
})
