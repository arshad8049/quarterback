/**
 * Compatibility Worker for the old host quaterback.velorallc.workers.dev (owner decision,
 * 2026-11-07: "page redirect only").
 *
 * - Browser page visits (GET/HEAD outside /api/) get a 301 to the same path and query on
 *   https://quarterback.velorallc.workers.dev.
 * - Every /api/ request, and every other method, gets 410 Gone with the new address. It is
 *   never redirected: a cross-host redirect drops the Authorization header, and redirecting
 *   a POST can change its method. Inventory on 2026-11-07: 0 telemetry tokens, 0 verification
 *   links and 0 metrics had ever been issued, so no client depends on the old API.
 * - Nothing is logged: no console output, so no path, query, code or token reaches the logs.
 */
const NEW = 'https://quarterback.velorallc.workers.dev';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (!isApi && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(null, { status: 301, headers: { Location: NEW + url.pathname + url.search, 'Cache-Control': 'public, max-age=86400' } });
    }
    return new Response(JSON.stringify({ error: 'Gone: Quarterback moved to ' + NEW + ' (use the same path there).', moved_to: NEW }), {
      status: 410,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
