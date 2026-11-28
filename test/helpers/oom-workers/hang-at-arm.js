// TEST ONLY (KAN-96): an observer thread that never answers arm (nor anything after it).
const { parentPort } = require('worker_threads');
parentPort.on('message', (m) => { if (m.hello) parentPort.postMessage({ type: 'ready' }); });
setInterval(() => {}, 1000);
