'use strict'
// HAND-WRITTEN reference (frozen with the item). It validates the CONTROLS offline; it is never a compiler input.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const m = require('../lib/math')
test('exported', () => assert.equal(typeof m.percent, 'function'))
test('example-1', () => assert.equal(m.percent(1, 3), 33))
test('example-2', () => assert.equal(m.percent(2, 3), 67))
test('throws', () => assert.throws(() => m.percent(1, 0), /whole must not be zero/))
test('keep', () => assert.equal(m.add(2, 3), 5))
