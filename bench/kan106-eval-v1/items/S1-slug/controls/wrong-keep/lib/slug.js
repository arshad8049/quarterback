'use strict'

function slugify (s) {
  return s.replace(/ +/g, '-')
}

module.exports = { slugify }
