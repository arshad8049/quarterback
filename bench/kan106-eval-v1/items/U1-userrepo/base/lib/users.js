'use strict'

module.exports = class UserRepo {
  constructor (db) {
    this.db = db
  }

  find (id) {
    const row = this.db.get(id)
    if (!row) throw new Error(`no user ${id}`)
    return row
  }
}
