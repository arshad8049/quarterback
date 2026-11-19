'use strict'

function formatCents (cents) {
  const dollars = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const rest = String(cents % 100).padStart(2, '0')
  return `$${dollars}.${rest}`
}

module.exports = { formatCents }
