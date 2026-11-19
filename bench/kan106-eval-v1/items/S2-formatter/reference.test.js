'use strict'
// HAND-WRITTEN reference (frozen with the item). It validates the CONTROLS offline; it is never a compiler input.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Formatter = require('../lib/formatter')
test('change', () => assert.equal(new Formatter().join([]), ''))
test('keep', () => assert.equal(new Formatter().join(['a', 'b']), 'a,b'))
