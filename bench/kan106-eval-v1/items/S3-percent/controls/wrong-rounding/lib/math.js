'use strict'

function add (a, b) {
  return a + b
}

function percent (part, whole) {
  if (whole === 0) throw new Error('percent: whole must not be zero')
  return Math.floor(part / whole * 100)
}

module.exports = { add, percent }
