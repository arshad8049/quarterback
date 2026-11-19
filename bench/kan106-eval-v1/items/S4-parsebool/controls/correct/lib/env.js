'use strict'

function parseBool (value) {
  return value === 'true' || value === '1' || value === 'yes'
}

module.exports = { parseBool }
