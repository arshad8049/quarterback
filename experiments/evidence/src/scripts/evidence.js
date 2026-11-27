/* KAN-67 visual experiment (preview only): "Open the run" and "Inspect the evidence". No dependencies.
   One requestAnimationFrame loop for both; it stops when neither section needs a frame, off screen and on hidden tabs.
   Without this file both sections are complete, static and readable. */
(function () {
  'use strict';
  const run = document.querySelector('.qbo');
  const insp = document.querySelector('[data-qbi]');
  if (!run && !insp) return;

  const motionQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  // As in interactions.js: read .matches at load and in the change event only, never from a loop
  let reduced = motionQ.matches;
  const wide = window.matchMedia('(min-width: 900px)');
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  const on = (q, f) => (q.addEventListener ? q.addEventListener('change', f) : q.addListener(f));
  const header = document.querySelector('.qbh-header');
  const headerH = () => (header ? header.offsetHeight : 0);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const ease = (p, a, b) => { const t = clamp01((p - a) / (b - a)); return t * t * (3 - 2 * t); };

  /* ── One frame loop ── */
  let raf = 0, last = 0;
  const parts = [];
  const tick = (t) => {
    raf = 0;
    const dt = last ? Math.min(64, t - last) : 16; last = t;
    let more = false;
    parts.forEach((f) => { more = f(dt) || more; });
    if (more && !document.hidden) raf = requestAnimationFrame(tick); else last = 0;
  };
  const kick = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(tick); };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; } else { dirty = true; kick(); }
  });
  let dirty = true;

  /* ── Open the run: page scroll drives one progress value. Nothing intercepts the wheel. ── */
  if (run) {
    const track = run.querySelector('[data-qbo]');
    const panel = (n) => run.querySelector('[data-qbo-panel="' + n + '"]');
    const P = { frame: panel('frame'), checklist: panel('checklist'), run: panel('run'), checks: panel('checks'), patch: panel('patch') };
    const links = {}; run.querySelectorAll('[data-qbo-link]').forEach((l) => { links[l.dataset.qboLink] = l; });
    const rail = Array.from(run.querySelectorAll('[data-qbo-rail] a'));
    const names = ['frame', 'checklist', 'run', 'checks', 'patch'];
    const STOPS = [0, 0.45, 0.6, 0.75, 1];          // where a step is fully shown
    const STARTS = [0, 0.2, 0.49, 0.62, 0.83];      // where it becomes the current step
    let live = false, near = true, shown = -1;

    const travel = () => Math.max(1, track.offsetHeight - (window.innerHeight - headerH()));
    const show = (el, v) => {
      el.style.setProperty('--v', v.toFixed(3));
      if (v < 0.02) el.setAttribute('data-off', ''); else el.removeAttribute('data-off');
    };
    const paint = () => {
      const p = clamp01((headerH() - track.getBoundingClientRect().top) / travel());
      const out = 1 - ease(p, 0.76, 0.86);
      P.frame.style.setProperty('--r', ease(p, 0.2, 0.45).toFixed(3));
      const c = ease(p, 0.3, 0.45) * out, r = ease(p, 0.45, 0.58), k = ease(p, 0.56, 0.72) * out;
      show(P.checklist, c); show(P.run, r); show(P.checks, k); show(P.patch, ease(p, 0.84, 0.95));
      P.patch.style.setProperty('--f', ease(p, 0.9, 0.99).toFixed(3));
      links.a.style.setProperty('--v', c.toFixed(3));
      links.b.style.setProperty('--v', (ease(p, 0.62, 0.75) * Math.max(out, ease(p, 0.84, 0.95))).toFixed(3));
      links.c.style.setProperty('--v', (ease(p, 0.62, 0.75) * out).toFixed(3));
      let i = 0; STARTS.forEach((s, n) => { if (p >= s) i = n; });
      if (i !== shown) { shown = i; rail.forEach((a, n) => (n === i ? a.setAttribute('aria-current', 'step') : a.removeAttribute('aria-current'))); }
    };
    const goTo = (i, smooth) => {
      const y = window.scrollY + track.getBoundingClientRect().top - headerH() + travel() * STOPS[i];
      window.scrollTo({ top: Math.max(0, y), behavior: smooth && !reduced ? 'smooth' : 'instant' });
    };
    const clear = () => {
      live = false; shown = -1; run.classList.remove('is-live');
      names.forEach((n) => { P[n].removeAttribute('style'); P[n].removeAttribute('data-off'); });
      Object.keys(links).forEach((k) => links[k].removeAttribute('style'));
      rail.forEach((a) => a.removeAttribute('aria-current'));
    };
    const fits = () => names.every((n) => P[n].scrollHeight <= P[n].clientHeight + 1 && Array.from(P[n].querySelectorAll('.qbo-term, .qbo-rows')).every((e) => e.scrollHeight <= e.clientHeight + 1 && e.scrollWidth <= e.clientWidth + 1))
      && run.querySelector('.qbo-side').offsetHeight <= window.innerHeight - headerH() - 40;
    const decide = () => {
      clear();
      if (!wide.matches || reduced) return;
      live = true; run.classList.add('is-live');
      if (!fits()) { clear(); return; }
      dirty = true; kick();
    };
    // Scroll links: while pinned, go to the step; otherwise they are ordinary in-page links
    run.querySelector('[data-qbo-rail]').addEventListener('click', (e) => {
      const i = rail.indexOf(e.target.closest('a'));
      if (!live || i < 0) return;
      e.preventDefault(); e.stopPropagation();
      goTo(i, true);
    }, true);
    // A panel that is hidden now is out of the tab order, so the next stop would be skipped: make each
    // panel reachable by bringing its step into view when focus arrives on the step before it and Tab is pressed
    run.addEventListener('keydown', (e) => {
      if (!live || e.key !== 'Tab') return;
      const f = Array.from(run.querySelectorAll('.qbo-canvas a, .qbo-canvas pre'));
      const order = f.indexOf(document.activeElement);
      const from = order >= 0 ? order : (document.activeElement === rail[rail.length - 1] && !e.shiftKey ? -1 : null);
      if (from === null) return;
      const next = f[from + (e.shiftKey ? -1 : 1)];
      if (!next) return;
      goTo(names.indexOf(next.closest('[data-qbo-panel]').dataset.qboPanel), false);
      paint();
      next.focus({ preventScroll: true });
      if (document.activeElement === next) e.preventDefault();   // never trap Tab if the panel could not take focus
    });
    parts.push(() => { if (live && near && dirty) paint(); dirty = false; return false; });
    const mark = () => { if (live && near) { dirty = true; kick(); } };
    window.addEventListener('scroll', mark, { passive: true });
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { near = es[0].isIntersecting; mark(); }, { rootMargin: '25% 0px' }).observe(run);
    let rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(decide, 120); }, { passive: true });
    on(wide, decide);
    on(motionQ, (e) => { reduced = e.matches; decide(); });
    decide();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(decide);
    window.addEventListener('load', decide);

    /* Optional recording: loaded only near the viewport, muted, with a Pause button. The text poster stays underneath,
       so a missing file, a decode error or blocked playback leaves the explanation as it was. */
    const src = P.frame.dataset.qboVideo;
    if (src && !reduced && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => {
        if (!es[0].isIntersecting) return;
        io.disconnect();
        const v = document.createElement('video');
        const b = document.createElement('button');
        v.className = 'qbo-video'; v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.loop = true; v.setAttribute('aria-hidden', 'true'); v.style.opacity = '0';
        b.type = 'button'; b.className = 'qbh-marquee-btn qbo-video-btn'; b.textContent = 'Pause'; b.setAttribute('aria-label', 'Pause the recording'); b.hidden = true;
        let userPaused = false;
        const drop = () => { v.remove(); b.remove(); };
        v.addEventListener('error', drop);
        v.addEventListener('playing', () => { v.style.opacity = '1'; b.hidden = false; });
        b.addEventListener('click', () => {
          userPaused = !userPaused;
          if (userPaused) v.pause(); else v.play().catch(drop);
          b.textContent = userPaused ? 'Play' : 'Pause'; b.setAttribute('aria-label', (userPaused ? 'Play' : 'Pause') + ' the recording');
        });
        P.frame.append(v, b);
        new IntersectionObserver((x) => { if (!x[0].isIntersecting) v.pause(); else if (!userPaused && v.isConnected) v.play().catch(drop); }).observe(P.frame);
        on(motionQ, (e) => { if (e.matches) drop(); });
        v.src = src;
      }, { rootMargin: '50% 0px' });
      io.observe(P.frame);
    }
  }

  /* ── Inspect the evidence ── */
  if (insp) {
    const list = insp.querySelector('[data-qbi-cards]');
    const cards = Array.from(list.children);
    const live = insp.querySelector('.qbi-live');
    const stage = insp.querySelector('.qbi-stage');
    const head = insp.querySelector('.qbi-h');
    const words = Array.from(insp.querySelectorAll('[data-w]'));
    const ctl = insp.querySelector('[data-qbi-controls]');
    const [prev, next, play] = ['prev', 'next', 'play'].map((n) => ctl.querySelector('[data-qbi-' + n + ']'));
    const TURN = 58000, STOP_MS = 250;               // one revolution; ease to rest and back
    let mode = '', phase = 0, speed = 1, hover = -1, focus = -1, userPaused = false, visible = false, rx = 0, ry = 0, word = -1;

    // Details open in one modal dialog: focus moves in, Escape or Close returns it to the card
    const dlg = document.createElement('dialog');
    dlg.className = 'qbi-dialog'; dlg.setAttribute('aria-labelledby', 'qbi-dialog-h');
    const body = document.createElement('div');
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'qbh-btn qbh-btn-dark'; close.textContent = 'Close';
    dlg.append(body, close);
    insp.appendChild(dlg);
    let opener = null;
    close.addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => { if (opener) opener.focus({ preventScroll: true }); kick(); });
    const buttons = cards.map((c) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'qbi-open'; b.setAttribute('aria-haspopup', 'dialog');
      const s = document.createElement('span'); s.textContent = 'Open details: ' + c.querySelector('h3').textContent; b.appendChild(s);
      b.addEventListener('click', () => {
        opener = b; body.textContent = '';
        ['h3', '.qbi-crop', '.qbi-detail'].forEach((q) => body.appendChild(c.querySelector(q).cloneNode(true)));
        body.querySelector('h3').id = 'qbi-dialog-h';
        dlg.showModal();
      });
      return b;
    });

    const setWord = (i) => { if (i === word) return; word = i; words.forEach((w, n) => w.classList.toggle('is-on', n === i)); };
    const place = () => {
      let front = 0, best = -2;
      cards.forEach((c, i) => {
        const a = phase + (i / cards.length) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
        if (Math.sin(a) > best) { best = Math.sin(a); front = i; }
        c.style.transform = 'translate(-50%, -50%) translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0) scale(' + (0.96 + 0.04 * Math.sin(a)).toFixed(4) + ')';
      });
      setWord(hover >= 0 ? hover : focus >= 0 ? focus : front);
    };
    const size = () => {
      const tile = cards[0];
      rx = Math.max(0, (stage.clientWidth - tile.offsetWidth) / 2 - 4);
      ry = Math.max(0, (stage.clientHeight - tile.offsetHeight) / 2 - 4);
    };
    const held = () => userPaused || hover >= 0 || focus >= 0 || dlg.open;
    // One continuous phase: pausing only eases the speed to 0, resuming eases it back, so a card never jumps
    parts.push((dt) => {
      if (mode !== 'orbit' || !visible) return false;
      const goal = held() ? 0 : 1, step = dt / STOP_MS;
      speed = goal > speed ? Math.min(goal, speed + step) : Math.max(goal, speed - step);
      phase = (phase + (dt / TURN) * Math.PI * 2 * speed) % (Math.PI * 2);
      place();
      return speed > 0 || goal > 0;
    });
    cards.forEach((c, i) => {
      c.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hover = i; kick(); } });
      c.addEventListener('pointerleave', () => { if (hover === i) { hover = -1; kick(); } });
      c.addEventListener('focusin', () => { focus = i; kick(); });
      c.addEventListener('focusout', () => { if (focus === i) { focus = -1; kick(); } });
    });
    play.addEventListener('click', () => {
      userPaused = !userPaused;
      play.textContent = userPaused ? 'Play' : 'Pause';
      play.setAttribute('aria-label', userPaused ? 'Play the orbit' : 'Pause the orbit');
      kick();
    });
    play.setAttribute('aria-label', 'Pause the orbit');

    const ends = () => {
      if (mode !== 'row') return;
      prev.disabled = list.scrollLeft <= 4;
      next.disabled = list.scrollLeft >= list.scrollWidth - list.clientWidth - 4;
    };
    const move = (d) => list.scrollBy({ left: d * (cards[1].offsetLeft - cards[0].offsetLeft), behavior: reduced ? 'instant' : 'smooth' });
    prev.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    let et = 0;
    list.addEventListener('scroll', () => { clearTimeout(et); et = setTimeout(ends, 80); }, { passive: true });

    const decide = () => {
      const want = reduced ? 'grid' : wide.matches && fine.matches ? 'orbit' : 'row';
      if (want !== mode) {
        mode = want;
        insp.classList.toggle('is-orbit', mode === 'orbit');
        insp.classList.toggle('is-row', mode === 'row');
        cards.forEach((c, i) => { c.removeAttribute('style'); if (mode === 'grid') buttons[i].remove(); else c.appendChild(buttons[i]); });
        if (mode === 'grid' && dlg.open) dlg.close();
        (mode === 'orbit' ? stage : head).appendChild(live);   // the changing word sits in the middle of the orbit
        ctl.hidden = mode === 'grid'; prev.hidden = next.hidden = mode !== 'row'; play.hidden = mode !== 'orbit';
        list.tabIndex = mode === 'row' ? 0 : -1;
        if (mode === 'row') { list.setAttribute('role', 'list'); list.setAttribute('aria-label', 'Evidence files'); }
        hover = focus = -1;
      }
      if (mode === 'orbit') { size(); place(); kick(); }
      ends();
    };
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; kick(); }).observe(stage);
    else visible = true;
    let rt2 = 0;
    window.addEventListener('resize', () => { clearTimeout(rt2); rt2 = setTimeout(decide, 120); }, { passive: true });
    [wide, fine].forEach((q) => on(q, decide));
    on(motionQ, (e) => { reduced = e.matches; decide(); });
    decide();
  }
})();
