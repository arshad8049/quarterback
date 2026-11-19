'use strict'

module.exports = class Formatter {
  constructor (options) {
    this.separator = (options && options.separator) || ','
  }

  join (list) {
    if (list.length === 0) return undefined
    return list.join(this.separator)
  }
}
