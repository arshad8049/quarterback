'use strict'

function add (a, b) {
  return a + b
}

function percent (part, whole) {
  return Math.round(part / whole * 100)
}

module.exports = { add, percent }
