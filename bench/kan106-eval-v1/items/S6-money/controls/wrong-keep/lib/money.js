'use strict'

function formatCents (cents) {
  const dollars = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const rest = String(cents % 100)
  return `$${dollars}.${rest}`
}

module.exports = { formatCents }
