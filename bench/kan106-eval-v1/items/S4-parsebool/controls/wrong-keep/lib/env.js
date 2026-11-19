'use strict'

function parseBool (value) {
  return value === '1' || value === 'yes'
}

module.exports = { parseBool }
