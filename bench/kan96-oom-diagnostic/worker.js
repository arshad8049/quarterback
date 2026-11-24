'use strict';
// A dedicated thread: the blocking sampler must not slow the thread that drives docker.
const { parentPort } = require('worker_threads');
const { sample } = require('./sampler');
parentPort.on('message', ({ id, stop }) => { let r; try { r = sample(id, { stop: new Int32Array(stop) }); } catch (e) { r = { container: id, ended: `sampler error: ${e.message}` }; } parentPort.postMessage(r); });
parentPort.postMessage('ready');
