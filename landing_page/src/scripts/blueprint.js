/* KAN-67 10826: "See what happened in a run". One progress value from native page scroll paints everything, so scrolling back
   retraces the same states. Nothing intercepts the wheel, nothing loops. Connectors start and end at the real node rectangles.
   Text is never scaled: the SVG frame changes size, and text fades or moves at its final size.
   Without this file: a poster and a connected list. Reduced motion: the finished diagram, not pinned. Too small to fit: the list. */
(function () {
  'use strict';
  const root = document.querySelector('[data-bp]');
  if (!root) return;
  const $ = (q) => root.querySelector(q);
  const track = $('[data-bp-track]'), pin = $('.bp-pin'), scene = $('[data-bp-scene]'), svg = $('[data-bp-svg]'), frame = $('[data-bp-frame]'), mesh = $('[data-bp-mesh]'), bar = $('[data-bp-bar]'), rec = $('[data-bp-rec]'), darkR = $('[data-bp-dark]'), wipe = $('[data-bp-wipe]'), edge = $('[data-bp-edge]'), log = $('[data-bp-log]'), tracer = $('[data-bp-tracer]');
  const N = {}; root.querySelectorAll('[data-bp-node]').forEach((e) => { N[e.dataset.bpNode] = e; });
  const L = {}; root.querySelectorAll('[data-bp-link]').forEach((e) => { L[e.dataset.bpLink] = e; });
  const steps = Array.from(root.querySelectorAll('.bp-steps li'));
  const header = document.querySelector('.qbh-header');
  const headerH = () => (header ? header.offsetHeight : 0);
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const ease = (p, a, b) => { const t = clamp((p - a) / (b - a)); return t * t * (3 - 2 * t); };
  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, at, parent) => { const e = document.createElementNS(NS, n); Object.keys(at).forEach((k) => e.setAttribute(k, at[k])); parent.appendChild(e); return e; };
  // node reveals, then the connector that follows its arrival. Everything rests from 0.86 to 1.
  const AT = { core: [0.28, 0.42], request: [0.4, 0.47], checklist: [0.47, 0.55], checks: [0.61, 0.69], patch: [0.71, 0.78], you: [0.79, 0.84] };
  const LN = { rc: [0.53, 0.57], cw: [0.56, 0.61], wk: [0.675, 0.72], kp: [0.765, 0.8], py: [0.82, 0.86] };
  const ORDER = ['rc', 'cw', 'wk', 'kp', 'py'];
  let box = {}, R = null, DX = {}, ends = {}, parts = { dots: [], arrows: {}, ticks: {} }, len = {};

  function layout() {
    root.classList.add('is-live', 'bp-measure');
    rec.style.transform = rec.style.clipPath = '';   // measure the poster where CSS puts it, not where the last paint moved it
    const o = scene.getBoundingClientRect();
    const r = (e) => { const b = e.getBoundingClientRect(); const x = b.left - o.left, y = b.top - o.top; return { x, y, w: b.width, h: b.height, cx: x + b.width / 2, cy: y + b.height / 2, r: x + b.width, b: y + b.height }; };
    Object.keys(N).forEach((k) => { box[k] = r(N[k]); });
    R = r(rec);
    root.classList.remove('bp-measure');
    const c = box.core;
    const inCore = (y) => Math.max(c.y + 24, Math.min(c.b - 24, y));
    const meet = (n) => Math.max(n.y + 8, Math.min(n.b - 8, inCore(n.cy)));   // one height the node and the workspace share
    const H = (x1, y1, x2, y2) => { const m = (x1 + x2) / 2; return Math.abs(y1 - y2) < 2 ? `M${x1} ${y1}H${x2}` : `M${x1} ${y1}H${m}V${y2}H${x2}`; };
    const cy = meet(box.checklist), ky = meet(box.checks), you = box.you;
    ends = { rc: [box.checklist.x + 1, box.checklist.y - 3, 0, 1], cw: [c.x - 5, inCore(cy), 1, 0], wk: [box.checks.x - 9, ky, 1, 0], kp: [box.patch.x + 1, box.patch.y - 3, 0, 1], py: [you.r + 4, you.cy, -1, 0] };
    L.rc.setAttribute('d', `M${box.request.x + 1} ${box.request.b + 2}V${ends.rc[1]}`);
    L.cw.setAttribute('d', H(box.checklist.r + 4, cy, ends.cw[0], ends.cw[1]));
    L.wk.setAttribute('d', H(c.r + 5, inCore(ky), ends.wk[0], ky));
    L.kp.setAttribute('d', `M${box.checks.x + 1} ${box.checks.b + 2}V${ends.kp[1]}`);
    L.py.setAttribute('d', `M${box.patch.x + 1} ${box.patch.b + 2}V${you.cy}H${ends.py[0]}`);
    Object.keys(L).forEach((k) => { len[k] = L[k].getTotalLength(); });
    // where each node starts: against the workspace edge, pulled towards its middle
    Object.keys(N).forEach((k) => {
      if (k === 'core') return;
      const b = box[k], left = b.cx < c.x, dx = k === 'you' ? 0 : left ? 150 : -150, dy = k === 'you' ? c.b - b.y - 8 : (c.cy - b.cy) * 0.4;
      DX[k] = dx;
      N[k].style.setProperty('--dx', dx.toFixed(1) + 'px'); N[k].style.setProperty('--dy', dy.toFixed(1) + 'px');
    });
    const dots = $('[data-bp-dots]'), arrows = $('[data-bp-arrows]'), ticks = $('[data-bp-ticks]');
    [dots, arrows, ticks].forEach((g) => { g.textContent = ''; });
    parts = { dots: [], arrows: {}, ticks: {} };
    [[c.x, inCore(cy), 'cw'], [c.r, inCore(ky), 'wk']].forEach(([x, y, k]) => parts.dots.push([el('circle', { cx: x, cy: y, r: 4.5 }, dots), k]));
    ORDER.forEach((k) => { const [x, y, ux, uy] = ends[k]; if (k === 'cw') return; parts.arrows[k] = el('path', { d: ux ? `M${x - 7 * ux} ${y - 5}L${x} ${y}L${x - 7 * ux} ${y + 5}` : `M${x - 5} ${y - 7 * uy}L${x} ${y}L${x + 5} ${y - 7 * uy}` }, arrows); });
    parts.arrows.cw = el('path', { d: `M${c.x - 14} ${inCore(cy) - 5}L${c.x - 7} ${inCore(cy)}L${c.x - 14} ${inCore(cy) + 5}` }, arrows);
    ['request', 'checklist', 'checks', 'patch'].forEach((k) => { const b = box[k], g = el('g', {}, ticks); parts.ticks[k] = g; [[b.x - 8, b.y - 6, 1, 1], [b.r + 4, b.y - 6, -1, 1], [b.x - 8, b.b + 6, 1, -1], [b.r + 4, b.b + 6, -1, -1]].forEach(([x, y, sx, sy]) => el('path', { d: `M${x} ${y + 7 * sy}V${y}H${x + 7 * sx}` }, g)); });
  }

  let shown = -1;
  function paint(p) {
    const set = (e, v) => e.style.setProperty('--v', v.toFixed(3));
    const c = box.core, k = ease(p, 0.16, 0.34), mix = (a, b) => a + (b - a) * k;
    const f = { x: mix(R.x, c.x), y: mix(R.y, c.y), width: mix(R.w, c.w), height: mix(R.h, c.h) };
    const w = ease(p, 0.28, 0.42), ex = f.x + f.width * w, X = f.x + f.width, Y = f.y + f.height;   // the wipe: left of ex is the workspace, right of it the recording
    [frame, mesh, darkR].forEach((e) => Object.keys(f).forEach((a) => e.setAttribute(a, f[a].toFixed(2))));
    [['x', ex], ['y', f.y - 2], ['width', Math.max(0, X - ex + 2)], ['height', f.height + 4]].forEach(([a, v]) => wipe.setAttribute(a, v.toFixed(2)));
    const by = (f.y + 46).toFixed(2);
    bar.setAttribute('d', `M${f.x.toFixed(2)} ${by}H${ex.toFixed(2)}`);   // the poster's caption bar becomes the workspace's title bar
    bar.style.stroke = '#1f6146';
    edge.setAttribute('d', `M${ex.toFixed(2)} ${f.y.toFixed(2)}V${Y.toFixed(2)}`); edge.style.opacity = w > 0.001 && w < 0.999 ? '1' : '0';
    frame.style.strokeOpacity = ease(p, 0.16, 0.3).toFixed(3);
    mesh.style.opacity = w > 0 ? '1' : '0';
    // the terminal text keeps its size and its place in the frame; the frame's edges and the wipe crop it
    rec.style.transform = `translate(calc(-50% + ${(f.x - R.x).toFixed(2)}px), calc(-50% + ${(f.y - R.y).toFixed(2)}px))`;
    rec.style.clipPath = `inset(0 ${Math.max(0, R.w - f.width).toFixed(2)}px ${Math.max(0, R.h - f.height).toFixed(2)}px ${(f.width * w).toFixed(2)}px round 14px)`;
    rec.style.visibility = w >= 0.999 ? 'hidden' : '';
    root.style.setProperty('--grid', ease(p, 0.24, 0.42).toFixed(3));
    Object.keys(AT).forEach((n) => {
      const v = ease(p, AT[n][0], AT[n][1]), e = N[n];
      set(e, v); e.toggleAttribute('data-off', v < 0.5);
      if (parts.ticks[n]) parts.ticks[n].style.opacity = v.toFixed(3);
      if (n === 'core') { e.style.setProperty('--o', '1'); e.style.clipPath = `inset(0 ${Math.max(0, c.r - ex).toFixed(2)}px 0 0)`; return; }
      e.style.setProperty('--o', clamp(v * 1.6).toFixed(3));
      if (n === 'you') return;
      // only the part outside the workspace edge is drawn: the node slides out from behind it
      const b = box[n], at = DX[n] * (1 - v), hide = b.cx < c.x ? b.r + at - (c.x - 4) : c.r + 4 - (b.x + at);
      e.style.clipPath = hide > 0 ? (b.cx < c.x ? `inset(-8px ${hide.toFixed(1)}px -8px -8px)` : `inset(-8px -8px -8px ${hide.toFixed(1)}px)`) : 'none';
    });
    let head = null;
    ORDER.forEach((n) => { const v = ease(p, LN[n][0], LN[n][1]); set(L[n], v); parts.arrows[n].style.opacity = ease(v, 0.85, 1).toFixed(3); if (v > 0.001 && v < 0.999) head = [n, v]; });
    parts.dots.forEach(([d, n]) => { d.style.opacity = n === 'wk' ? ease(p, LN[n][0] - 0.02, LN[n][0] + 0.01).toFixed(3) : ease(p, LN[n][1] - 0.01, LN[n][1] + 0.01).toFixed(3); });
    if (head) { const q = L[head[0]].getPointAtLength(len[head[0]] * head[1]); tracer.setAttribute('cx', q.x); tracer.setAttribute('cy', q.y); }
    tracer.style.opacity = head ? '1' : '0';
    const i = p < 0.5 ? 0 : p < 0.58 ? 1 : p < 0.65 ? 2 : p < 0.75 ? 3 : 4;
    if (i !== shown) { shown = i; steps.forEach((s, n) => { s.classList.toggle('is-done', n < i); if (n === i) s.setAttribute('aria-current', 'step'); else s.removeAttribute('aria-current'); }); }
  }

  /* ── Scroll, fit and preference ── */
  const motionQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  const wide = window.matchMedia('(min-width: 1000px)');
  let mode = 'list', raf = 0, near = true;
  const progress = () => clamp((headerH() - track.getBoundingClientRect().top) / Math.max(1, track.offsetHeight - pin.offsetHeight));
  const frameNow = () => { raf = 0; if (mode === 'scroll') paint(progress()); };
  const mark = () => { if (mode === 'scroll' && near && !raf) raf = requestAnimationFrame(frameNow); };
  function fits() {
    const b = Object.keys(box).map((k) => [k, box[k], N[k]]);
    for (let i = 0; i < b.length; i++) {
      if (b[i][2].scrollHeight > b[i][2].clientHeight + 2 || b[i][2].scrollWidth > b[i][2].clientWidth + 2) return false;
      for (let j = i + 1; j < b.length; j++) { const x = b[i][1], y = b[j][1]; if (x.x < y.r && x.r > y.x && x.y < y.b && x.b > y.y) return false; }
      if (b[i][1].y < -14 || b[i][1].b > scene.clientHeight + 8) return false;
    }
    const cb = N.core.getBoundingClientRect();
    if (Array.from(N.core.querySelectorAll('h3, p, .bp-file')).some((e) => { const r = e.getBoundingClientRect(); return r.bottom > cb.bottom - 6 || r.top < cb.top - 1 || r.right > cb.right + 1; })) return false;
    return log.scrollHeight <= log.clientHeight + 2 && pin.scrollHeight <= pin.clientHeight + 2 && pin.offsetHeight <= window.innerHeight - headerH() + 2;
  }
  function decide() {
    root.classList.remove('is-live', 'is-scroll'); mode = 'list'; shown = -1;
    if (wide.matches) {
      layout();
      const ok = fits();
      if (ok && !motionQ.matches) { mode = 'scroll'; root.classList.add('is-scroll'); }
      else if (motionQ.matches && ok) mode = 'diagram';
    }
    if (mode === 'list') {
      root.classList.remove('is-live');
      [rec, frame, mesh, bar, ...Object.values(N), ...Object.values(L)].forEach((e) => { e.removeAttribute('style'); e.removeAttribute('data-off'); });
      steps.forEach((s) => { s.classList.remove('is-done'); s.removeAttribute('aria-current'); });
      log.tabIndex = 0;
    } else { log.removeAttribute('tabindex'); paint(mode === 'diagram' ? 1 : progress()); }
  }
  window.addEventListener('scroll', mark, { passive: true });
  if ('IntersectionObserver' in window) new IntersectionObserver((es) => { near = es[0].isIntersecting; mark(); }, { rootMargin: '25% 0px' }).observe(root);
  // every resize step, so nothing is left at an old size while the window is being dragged
  let rr = 0;
  window.addEventListener('resize', () => { if (!rr) rr = requestAnimationFrame(() => { rr = 0; decide(); }); }, { passive: true });
  [motionQ, wide].forEach((q) => (q.addEventListener ? q.addEventListener('change', decide) : q.addListener(decide)));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) mark(); });

  /* ── Details links open the drawer and move focus to the part they name ── */
  const details = $('#bp-details');
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-bp-open]');
    if (!a) return;
    const to = document.getElementById(a.hash.slice(1));
    if (!to) return;
    e.preventDefault(); e.stopPropagation();
    details.open = true;
    to.scrollIntoView({ block: 'center', behavior: 'instant' });
    to.focus({ preventScroll: true });
  }, true);

  decide();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(decide);
  window.addEventListener('load', decide);
  window.qbBlueprint = { layout, paint, decide, mode: () => mode, progress };
})();
