/** KAN-112 amendment 1: ESM view of lib/pilot/trial-policy.js (the implementation; CJS so the runner and report share it). */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('../../lib/pilot/trial-policy.js');
export const { checkAmendment, TrialClock, classifyTrial, accountSlots, pilotGate } = T;
