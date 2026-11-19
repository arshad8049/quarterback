'use strict'

function roundTo (n, places) {
  const f = 10 ** places
  return Math.round(n * f) / f
}

module.exports = { roundTo }
