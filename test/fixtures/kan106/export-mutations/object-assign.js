class S { run () {} }
Object.assign(S, { extra () { return 1 } })
module.exports = S
