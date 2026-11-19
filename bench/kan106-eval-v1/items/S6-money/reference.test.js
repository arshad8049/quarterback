'use strict'
// HAND-WRITTEN reference (frozen with the item). It validates the CONTROLS offline; it is never a compiler input.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { formatCents } = require('../lib/money')
test('change', () => assert.equal(formatCents(123456), '$1,234.56'))
test('keep-5', () => assert.equal(formatCents(5), '$0.05'))
test('keep-99900', () => assert.equal(formatCents(99900), '$999.00'))
