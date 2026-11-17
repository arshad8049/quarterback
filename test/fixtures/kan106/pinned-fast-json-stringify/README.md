# Pinned fast-json-stringify source (KAN-106, senior 10690)

`serializer-07d7196.js` is `lib/serializer.js` from the owner's pinned test repository
(fast-json-stringify 7.2.1, MIT licence, © the fast-json-stringify contributors), commit 07d7196,
copied byte for byte (no dependencies). It is the FIXED version: `asNumber` rejects blank strings.
The tests derive a BASE by removing exactly the blank-string guard (asserted to match). That base is a
SYNTHETIC mutation, not necessarily the owner's original repository base (senior 10694): before any
owner smoke, record the target repository's actual HEAD and confirm its API and support match.

Facts the honest fixture (`../pinned-api-honest.json`) is built on, checked by the tests:
- `module.exports = class Serializer` (the check runner sees it as the `default` export);
  calling it without `new` throws "Class constructor Serializer cannot be invoked without 'new'";
- `asNumber` is an instance method and returns STRINGS: 0 -> "0", "0" -> "0", "12.5" -> "12.5".
