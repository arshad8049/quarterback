'use strict'

function add (a, b) {
  return a + b
}

function percent (part, whole) {
  if (whole === 0) throw new Error('percent: whole must not be zero')
  return Math.round(part / whole * 100)
}

module.exports = { add, percent }
