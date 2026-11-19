'use strict'

function slugify (s) {
  return s.toLowerCase().replace(/ /g, '-')
}

module.exports = { slugify }
