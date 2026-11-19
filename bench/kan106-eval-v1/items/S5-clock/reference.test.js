'use strict'
// HAND-WRITTEN reference (frozen with the item). It validates the CONTROLS offline; it is never a compiler input.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { formatClock } = require('../lib/clock')
test('change', () => assert.equal(formatClock(3661), '1:01:01'))
test('keep-59', () => assert.equal(formatClock(59), '0:59'))
test('keep-60', () => assert.equal(formatClock(60), '1:00'))
test('keep-3599', () => assert.equal(formatClock(3599), '59:59'))
