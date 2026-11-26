function f () { return 1 }
f = Object.assign(function g () { return 2 }, { extra: 1 })
module.exports = f
