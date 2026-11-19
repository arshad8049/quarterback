'use strict'
// HAND-WRITTEN reference (frozen with the item). It validates the CONTROLS offline; it is never a compiler input.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { slugify } = require('../lib/slug')
test('change', () => assert.equal(slugify('a  b'), 'a-b'))
test('keep', () => assert.equal(slugify('Hello World'), 'hello-world'))
