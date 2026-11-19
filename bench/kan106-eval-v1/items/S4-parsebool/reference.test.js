'use strict'
// HAND-WRITTEN reference (frozen with the item). It validates the CONTROLS offline; it is never a compiler input.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseBool } = require('../lib/env')
test('change-yes', () => assert.equal(parseBool('yes'), true))
test('change-1', () => assert.equal(parseBool('1'), true))
test('keep-true', () => assert.equal(parseBool('true'), true))
test('keep-false', () => assert.equal(parseBool('false'), false))
