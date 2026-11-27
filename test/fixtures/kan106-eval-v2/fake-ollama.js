/**
 * KAN-106 10838: an INSTRUMENTED FAKE model server (no model, no inference). It answers the Ollama listing
 * endpoints and records, for every model call (/api/chat and /api/generate), its start and end time and the
 * number of calls in flight, so a test can measure serialization instead of trusting a setting.
 */
'use strict';
const http = require('http');

async function startFakeOllama({ model = 'fake-model:1b', digest = 'f'.repeat(64), delayMs = 60, reply = () => '{}' } = {}) {
  const stats = { inFlight: 0, maxInFlight: 0, calls: [], listing: 0 };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (req.url === '/api/tags') { stats.listing++; return json({ models: [{ name: model, model, digest, size: 1 }] }); }
      if (req.url === '/api/ps') { stats.listing++; return json({ models: [] }); }
      if (req.url === '/api/version') { stats.listing++; return json({ version: '0.0.0-fake' }); }
      if (req.url === '/api/chat' || req.url === '/api/generate') {
        const call = { url: req.url, start: process.hrtime.bigint(), end: null, inFlightAtStart: ++stats.inFlight };
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        stats.calls.push(call);
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* keep {} */ }
        setTimeout(() => {
          stats.inFlight--; call.end = process.hrtime.bigint();
          if (req.url === '/api/generate') return json({ model: parsed.model, done: true });
          return json({ model: parsed.model, message: { role: 'assistant', content: reply(parsed) }, load_duration: 0 });
        }, delayMs);
        return undefined;
      }
      res.statusCode = 404; return res.end('{}');
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, stats,
    /** true when no two model calls overlapped in time */
    noOverlap: () => {
      const c = [...stats.calls].sort((a, b) => (a.start < b.start ? -1 : 1));
      return c.every((x, i) => i === 0 || c[i - 1].end !== null && c[i - 1].end <= x.start);
    },
    close: async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); },
  };
}
module.exports = { startFakeOllama };
