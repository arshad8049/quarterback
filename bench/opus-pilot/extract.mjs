// KAN-113: build the model / usage / billing parts of an audit record from Claude Code's own stream-json output.
// One source of truth: the CommonJS reader in lib/sandbox/stream-json.js (also used by QB's pilot verification).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const { fromStreamJson } = require('../../lib/sandbox/stream-json.js');
