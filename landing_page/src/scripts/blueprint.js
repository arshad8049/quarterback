/* KAN-67 10824, pass A: places the blueprint and paints ONE progress value (no scroll wiring yet: pass B).
   Connectors start and end at the real node rectangles. Text is never scaled: only the SVG frame changes size. */
(function () {
  'use strict';
  const root = document.querySelector('[data-bp]');
  if (!root) return;
  const $ = (q) => root.querySelector(q);
  const scene = $('[data-bp-scene]'), svg = $('[data-bp-svg]'), frame = $('[data-bp-frame]'), mesh = $('[data-bp-mesh]'), bar = $('[data-bp-bar]'), rec = $('[data-bp-rec]');
  const N = {}; root.querySelectorAll('[data-bp-node]').forEach((e) => { N[e.dataset.bpNode] = e; });
  const L = {}; root.querySelectorAll('[data-bp-link]').forEach((e) => { L[e.dataset.bpLink] = e; });
  const steps = Array.from(root.querySelectorAll('.bp-steps li'));
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const ease = (p, a, b) => { const t = clamp((p - a) / (b - a)); return t * t * (3 - 2 * t); };
  const NS = 'http://www.w3.org/2000/svg';
  let box = {}, R = null;

  function layout() {
    root.classList.add('is-live');
    const o = scene.getBoundingClientRect();
    const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.left - o.left, y: b.top - o.top, w: b.width, h: b.height, cx: b.left - o.left + b.width / 2, cy: b.top - o.top + b.height / 2, r: b.right - o.left, b: b.bottom - o.top }; };
    Object.keys(N).forEach((k) => { box[k] = r(N[k]); });
    R = r(rec);
    const c = box.core, g = 12;
    const H = (x1, y1, x2, y2) => { const m = (x1 + x2) / 2; return Math.abs(y1 - y2) < 2 ? `M${x1} ${y1}H${x2}` : `M${x1} ${y1}H${m}V${y2}H${x2}`; };
    // one height both the node and the workspace share, so the connector runs straight
    const meet = (n) => { const y = inCore(n.cy); return Math.max(n.y + 8, Math.min(n.b - 8, y)); };
    const inCore = (y) => Math.max(c.y + 24, Math.min(c.b - 24, y));
    const ends = {
      rc: [[box.request.x + 1, box.request.b + 2], [box.checklist.x + 1, box.checklist.y - 2]],
      cw: [[box.checklist.r + 4, meet(box.checklist)], [c.x, inCore(meet(box.checklist))]],
      wk: [[c.r, inCore(meet(box.checks))], [box.checks.x - g, meet(box.checks)]],
      kp: [[box.checks.x + 1, box.checks.b + 2], [box.patch.x + 1, box.patch.y - 2]],
    };
    L.rc.setAttribute('d', `M${ends.rc[0]}V${ends.rc[1][1]}`);
    L.cw.setAttribute('d', H(...ends.cw[0], ...ends.cw[1]));
    L.wk.setAttribute('d', H(...ends.wk[0], ...ends.wk[1]));
    L.kp.setAttribute('d', `M${ends.kp[0]}V${ends.kp[1][1]}`);
    L.py.setAttribute('d', `M${box.patch.x + 1} ${box.patch.b + 2}V${box.you.cy}H${box.you.r + 8}`);
    const dots = $('[data-bp-dots]'); dots.textContent = '';
    [[c.x, inCore(meet(box.checklist)), 'cw'], [c.r, inCore(meet(box.checks)), 'wk'], [box.you.r + 8, box.you.cy, "py"]].forEach(([x, y, k]) => { const d = document.createElementNS(NS, 'circle'); d.setAttribute('cx', x); d.setAttribute('cy', y); d.setAttribute('r', 4.5); d.dataset.k = k; dots.appendChild(d); });
    const ticks = $('[data-bp-ticks]'); ticks.textContent = '';
    ['request', 'checklist', 'checks', 'patch'].forEach((k) => { const b = box[k]; [[b.x - 8, b.y - 6, 1, 1], [b.r + 4, b.y - 6, -1, 1], [b.x - 8, b.b + 6, 1, -1], [b.r + 4, b.b + 6, -1, -1]].forEach(([x, y, sx, sy]) => { const t = document.createElementNS(NS, 'path'); t.setAttribute('d', `M${x} ${y + 7 * sy}V${y}H${x + 7 * sx}`); ticks.appendChild(t); }); });
  }
  function paint(p) {
    const set = (e, v) => e.style.setProperty('--v', v.toFixed(3));
    const k = ease(p, 0.2, 0.4), c = box.core, mix = (a, b) => a + (b - a) * k;
    const f = { x: mix(R.x, c.x), y: mix(R.y, c.y), width: mix(R.w, c.w), height: mix(R.h, c.h) };
    [frame, mesh].forEach((e) => Object.keys(f).forEach((a) => e.setAttribute(a, f[a].toFixed(2))));
    const by = f.y + 46; bar.setAttribute('d', `M${f.x.toFixed(2)} ${by.toFixed(2)}H${(f.x + f.width).toFixed(2)}`);   // the poster's caption bar becomes the workspace's title bar
    const dark = 1 - ease(p, 0.24, 0.4);
    bar.style.stroke = dark > 0.5 ? '#2a302e' : '#1f6146';
    frame.style.fill = `color-mix(in srgb, #0c0e0e ${(dark * 100).toFixed(1)}%, #ffffff)`;
    frame.style.strokeOpacity = ease(p, 0.2, 0.34).toFixed(3);
    set(mesh, ease(p, 0.32, 0.42)); set(rec, 1 - ease(p, 0.2, 0.27));
    root.style.setProperty('--grid', ease(p, 0.24, 0.42).toFixed(3));
    svg.querySelector('[data-bp-ticks]').style.opacity = ease(p, 0.34, 0.42).toFixed(3);
    const at = { core: [0.35, 0.43], request: [0.41, 0.5], checklist: [0.5, 0.59], checks: [0.68, 0.75], patch: [0.76, 0.83], you: [0.87, 0.93] };
    Object.keys(at).forEach((n) => set(N[n], ease(p, ...at[n])));
    const ln = { rc: [0.47, 0.54], cw: [0.57, 0.65], wk: [0.65, 0.71], kp: [0.73, 0.79], py: [0.81, 0.9] };
    Object.keys(ln).forEach((n) => set(L[n], ease(p, ...ln[n])));
    svg.querySelectorAll('[data-bp-dots] circle').forEach((d) => { d.style.opacity = ease(p, ln[d.dataset.k][0], ln[d.dataset.k][1]).toFixed(3); });
    const i = p < 0.5 ? 0 : p < 0.62 ? 1 : p < 0.68 ? 2 : p < 0.78 ? 3 : 4;
    steps.forEach((s, n) => { s.classList.toggle('is-done', n < i); if (n === i) s.setAttribute('aria-current', 'step'); else s.removeAttribute('aria-current'); });
  }
  window.qbBlueprint = { layout, paint };
})();
