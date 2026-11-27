// TEST ONLY (KAN-96): an observer thread that dies when asked to arm.
const { parentPort } = require('worker_threads');
parentPort.on('message', (m) => { if (m.hello) parentPort.postMessage({ type: 'ready' }); if (m.arm) process.exit(3); });
