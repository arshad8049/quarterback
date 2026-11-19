'use strict'

function formatClock (seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = String(seconds % 60).padStart(2, '0')
  return `${h}:${String(m).padStart(2, '0')}:${s}`
}

module.exports = { formatClock }
