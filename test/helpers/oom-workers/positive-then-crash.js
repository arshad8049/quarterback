// TEST ONLY (KAN-96): an observer thread that reports a positive read, then dies when asked to finish.
const { parentPort } = require('worker_threads');
parentPort.on('message', (m) => {
  if (m.hello) parentPort.postMessage({ type: 'ready' });
  if (m.arm) {
    parentPort.postMessage({ type: 'armed', armed: true, why: null, arm_ms: 0.1 });
    parentPort.postMessage({ type: 'positive', record: { container: m.arm.container, baseline: 0, last: 1, final: false, unavailable: null, reads: 2, steps: [] } });
  }
  if (m.finish) process.exit(4);
});
