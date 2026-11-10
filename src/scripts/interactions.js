(function () {
  'use strict';

  /* ── Motion: honour prefers-reduced-motion at load AND when it changes mid-session ── */
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  // Read .matches only at load and inside its change event. Chromium updates a MediaQueryList's cached
  // state whenever .matches is read, so polling it from a pointer or rAF loop can swallow the change
  // event and leave motion on after the user turns it off.
  let motionReduced = motionQuery.matches;
  const reduced = () => motionReduced;
  const orbits = Array.from(document.querySelectorAll('.qb-orbit')).filter((o) => !o.closest('[data-qbh-hero]'));
  let driftOn = false;
  const drift = () => {
    // Slow vertical drift of the hero orbit while scrolling: transform only, one frame per event
    const y = Math.min(window.scrollY, 900) * 0.18;
    orbits.forEach((o) => { o.style.transform = 'translate3d(0,' + y.toFixed(1) + 'px,0)'; });
  };
  let ticking = false;
  const onScrollDrift = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; drift(); });
  };
  function applyMotion(e) {
    motionReduced = e && typeof e.matches === 'boolean' ? e.matches : motionQuery.matches;
    const off = motionReduced;
    document.documentElement.classList.toggle('qb-motion-off', off);
    // SVG SMIL animations ignore CSS: pause and resume them explicitly
    orbits.forEach((o) => { if (o.pauseAnimations) (off ? o.pauseAnimations() : o.unpauseAnimations()); });
    if (off && driftOn) { window.removeEventListener('scroll', onScrollDrift); driftOn = false; orbits.forEach((o) => { o.style.transform = ''; }); }
    if (!off && !driftOn && orbits.length) { window.addEventListener('scroll', onScrollDrift, { passive: true }); driftOn = true; drift(); }
    if (off) document.querySelectorAll('.qb-reveal').forEach((el) => el.classList.add('qb-visible'));
  }
  applyMotion();
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', applyMotion);
  else if (motionQuery.addListener) motionQuery.addListener(applyMotion);

  /* ── Scroll reveal (content is visible without JavaScript: see .qb-js in the CSS) ── */
  document.documentElement.classList.add('qb-js');
  const reveals = document.querySelectorAll('.qb-reveal');
  if ('IntersectionObserver' in window && !reduced()) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('qb-visible'); obs.unobserve(e.target); } });
    }, { threshold: 0, rootMargin: '0px 0px -15% 0px' });
    reveals.forEach((el) => obs.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('qb-visible'));
  }


  /* ── Homepage pointer (revision 4, 2026-11-10). One rAF loop drives two things:
     1. a soft copper light that follows a fine pointer anywhere on the page (owner decision 2026-11-10;
        it replaces the hero-only light). It is drawn under text, never over it: one fixed disc for the
        warm-white page, and one clipped disc inside each dark surface. It fades out when the pointer
        leaves the window.
     2. the hero image wrapper, which follows the pointer over the hero by at most 10px across and 6px
        down, with no rotation; the headline does not move.
     Time-based damping of ~120ms; only transform and opacity are written; passive listeners; layout is
     read before anything is written in a frame. The loop stops when settled. Everything is off on touch
     and coarse pointers, under reduced motion (at load or toggled mid-session) and on hidden tabs. ── */
  const qbhRoot = document.querySelector('.qbh');
  const hero = document.querySelector('[data-qbh-hero]');
  if (qbhRoot) {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const move = hero && hero.querySelector('[data-qbh-art-move]');
    const disc = (cls) => { const d = document.createElement('div'); d.className = 'qbh-glow ' + cls; d.setAttribute('aria-hidden', 'true'); return d; };
    const pageDisc = disc('qbh-glow-light');
    qbhRoot.appendChild(pageDisc);
    // Dark surfaces each get a clipped disc of their own, so the light reads on them without covering text
    const surfaces = Array.from(document.querySelectorAll('.qbh-hero, .qbh-sec-ink, .qbh-panel, .qbh-result-card, .qbh .qbx-form-card')).map((el) => {
      const clip = document.createElement('div');
      clip.className = 'qbh-glow-clip'; clip.setAttribute('aria-hidden', 'true');
      const d = disc('qbh-glow-dark'); clip.appendChild(d); el.appendChild(clip);
      return { el, d, x: 0, y: 0, on: false };
    });
    let heroInView = true, raf = 0, last = 0, placed = false, measure = true;
    const tgt = { gx: 0, gy: 0, op: 0, ax: 0, ay: 0 };
    const cur = { gx: 0, gy: 0, op: 0, ax: 0, ay: 0 };
    const active = () => fine.matches && !reduced() && !document.hidden;
    const frame = (t) => {
      raf = 0;
      const dt = last ? Math.min(t - last, 64) : 16; last = t;
      const k = 1 - Math.exp(-dt / 120);
      let moving = false;
      for (const key in tgt) {
        const d = tgt[key] - cur[key];
        const eps = key === 'gx' || key === 'gy' ? 0.2 : 0.002;
        if (Math.abs(d) > eps) { cur[key] += d * k; moving = true; } else cur[key] = tgt[key];
      }
      // Read: surface positions (only after a scroll, resize or pointer move), then write transforms
      if (measure) {
        measure = false;
        const vh = window.innerHeight;
        surfaces.forEach((s) => { const r = s.el.getBoundingClientRect(); s.on = r.bottom > -320 && r.top < vh + 320 && r.width > 0; s.x = r.left; s.y = r.top; });
      }
      const o = cur.op.toFixed(3);
      pageDisc.style.transform = 'translate3d(' + cur.gx.toFixed(1) + 'px,' + cur.gy.toFixed(1) + 'px,0)';
      pageDisc.style.opacity = o;
      surfaces.forEach((s) => {
        if (!s.on) { if (s.d.style.opacity !== '0') s.d.style.opacity = '0'; return; }
        s.d.style.transform = 'translate3d(' + (cur.gx - s.x).toFixed(1) + 'px,' + (cur.gy - s.y).toFixed(1) + 'px,0)';
        s.d.style.opacity = o;
      });
      if (move) {
        move.style.setProperty('--ax', (cur.ax * 10).toFixed(2) + 'px');
        move.style.setProperty('--ay', (cur.ay * 6).toFixed(2) + 'px');
      }
      if (moving && active()) raf = requestAnimationFrame(frame); else last = 0;
    };
    const kick = () => { if (!raf && active()) raf = requestAnimationFrame(frame); };
    const clear = () => {
      if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; placed = false;
      Object.assign(tgt, { op: 0, ax: 0, ay: 0 }); Object.assign(cur, { op: 0, ax: 0, ay: 0 });
      pageDisc.removeAttribute('style'); surfaces.forEach((s) => s.d.removeAttribute('style'));
      if (move) move.removeAttribute('style');
    };
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || !active()) return;
      tgt.gx = e.clientX; tgt.gy = e.clientY; tgt.op = 1; measure = true;
      // First move after a reset: start the light under the pointer instead of sliding in from a corner
      if (!placed) { cur.gx = tgt.gx; cur.gy = tgt.gy; placed = true; }
      if (move && heroInView) {
        const h = hero.getBoundingClientRect();
        const inHero = e.clientX >= h.left && e.clientX <= h.right && e.clientY >= h.top && e.clientY <= h.bottom;
        tgt.ax = inHero ? clamp(((e.clientX - h.left) / h.width - 0.5) * 2) : 0;
        tgt.ay = inHero ? clamp(((e.clientY - h.top) / h.height - 0.5) * 2) : 0;
      }
      kick();
    }, { passive: true });
    // Content moves under a still pointer while scrolling: re-measure the surfaces in the next frame
    const remeasure = () => { if (cur.op > 0 || tgt.op > 0) { measure = true; kick(); } };
    window.addEventListener('scroll', remeasure, { passive: true });
    window.addEventListener('resize', remeasure, { passive: true });
    // Fade out when the pointer leaves the window or the window loses focus
    const fadeOut = () => { tgt.op = 0; tgt.ax = 0; tgt.ay = 0; kick(); };
    document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) fadeOut(); }, { passive: true });
    window.addEventListener('blur', fadeOut);
    const sync = () => { if (!active()) clear(); };
    if (hero && 'IntersectionObserver' in window) new IntersectionObserver((es) => {
      heroInView = es[0].isIntersecting;
      if (!heroInView) { tgt.ax = 0; tgt.ay = 0; cur.ax = 0; cur.ay = 0; if (move) move.removeAttribute('style'); }
    }).observe(hero);
    document.addEventListener('visibilitychange', sync);
    [motionQuery, fine].forEach((q) => (q.addEventListener ? q.addEventListener('change', sync) : q.addListener && q.addListener(sync)));
    sync();
  }

  /* ── Logo strip (revision 5): a slow right-to-left loop over two identical sets. The second set is
     aria-hidden and inert. A visible Pause button, hover and keyboard focus pause it; it also pauses off
     screen. Under reduced motion (at load or toggled) it stays a static, wrapped row. ── */
  const strip = document.querySelector('[data-qbh-marquee]');
  if (strip) {
    const track = strip.querySelector('.qbh-marquee-track');
    const set = track.querySelector('.qbh-marquee-set');
    const btn = strip.querySelector('[data-qbh-marquee-btn]');
    const copy = set.cloneNode(true);
    copy.setAttribute('aria-hidden', 'true');
    copy.setAttribute('inert', '');
    copy.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    copy.querySelectorAll('[aria-labelledby]').forEach((el) => el.removeAttribute('aria-labelledby'));
    copy.querySelectorAll('img').forEach((img) => { img.alt = ''; });
    track.appendChild(copy);
    let paused = false;
    const syncStrip = () => {
      const on = !reduced();
      strip.classList.toggle('is-animated', on);
      btn.hidden = !on;
    };
    btn.addEventListener('click', () => {
      paused = !paused;
      strip.classList.toggle('is-paused', paused);
      btn.textContent = paused ? 'Play' : 'Pause';
      btn.setAttribute('aria-label', paused ? 'Play the logo strip' : 'Pause the logo strip');
    });
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { strip.classList.toggle('is-offscreen', !es[0].isIntersecting); }).observe(strip);
    if (motionQuery.addEventListener) motionQuery.addEventListener('change', syncStrip);
    else if (motionQuery.addListener) motionQuery.addListener(syncStrip);
    syncStrip();
  }

  /* ── One real run: at 900px and up with motion allowed, the panels move into one sticky stage.
     The active step is the one at the viewport's vertical centre, measured from real positions.
     The stage is used only if it fits the viewport below the header; otherwise, on small screens,
     under reduced motion and without JavaScript, each panel stays under its own step. ── */
  const story = document.querySelector('[data-qbh-story]');
  if (story) {
    const stage = story.querySelector('[data-qbh-stage]');
    const holder = stage.querySelector('[data-qbh-stage-panels]');
    const steps = Array.from(story.querySelectorAll('.qbh-step'));
    const panels = steps.map((st) => st.querySelector('[data-panel]'));
    const buttons = Array.from(stage.querySelectorAll('[data-goto]'));
    const wide = window.matchMedia('(min-width: 900px)');
    const header = document.querySelector('.qbh-header');
    const headerH = () => (header ? header.offsetHeight : 0);
    let staged = false, active = -1, ticking = false;
    const setActive = (i) => {
      if (i === active) return; active = i;
      steps.forEach((st, k) => st.classList.toggle('is-active', k === i));
      panels.forEach((p, k) => p.classList.toggle('is-active', k === i));
      buttons.forEach((b, k) => (k === i ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current')));
    };
    const compute = () => {
      ticking = false;
      if (!staged) return;
      const mid = window.innerHeight / 2;
      let best = 0, bestD = Infinity;
      steps.forEach((st, k) => {
        const r = st.getBoundingClientRect();
        const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
        if (d < bestD) { bestD = d; best = k; }
      });
      setActive(best);
    };
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(compute); } };
    const fits = () => stage.offsetHeight <= window.innerHeight - headerH() - 48;
    const enter = () => {
      staged = true; active = -1;
      panels.forEach((p) => holder.appendChild(p));
      stage.hidden = false; story.classList.add('is-staged');
      window.addEventListener('scroll', onScroll, { passive: true });
      compute();
    };
    const leave = () => {
      staged = false; active = -1;
      window.removeEventListener('scroll', onScroll);
      story.classList.remove('is-staged'); stage.hidden = true;
      panels.forEach((p, k) => { p.classList.remove('is-active'); steps[k].appendChild(p); });
      steps.forEach((st) => st.classList.remove('is-active'));
    };
    const decide = () => {
      const want = wide.matches && !reduced();
      if (want && !staged) enter();
      if (staged && (!want || !fits())) leave();
      if (staged) compute();
    };
    buttons.forEach((b, i) => b.addEventListener('click', () => {
      const r = steps[i].getBoundingClientRect();
      const y = window.scrollY + r.top + r.height / 2 - window.innerHeight / 2;
      window.scrollTo({ top: Math.max(0, y), behavior: reduced() ? 'auto' : 'smooth' });
      setActive(i);
    }));
    let resizeT = 0;
    window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(decide, 120); }, { passive: true });
    [motionQuery, wide].forEach((q) => (q.addEventListener ? q.addEventListener('change', decide) : q.addListener && q.addListener(decide)));
    decide();
    // Recompute once fonts and images have settled, since both change step heights
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(decide);
    window.addEventListener('load', decide);
  }

  /* ── Homepage header: border after scrolling; menu toggle below 900px ── */
  const qhHeader = document.querySelector('.qbh-header');
  if (qhHeader) {
    const onScrollH = () => qhHeader.classList.toggle('is-scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScrollH, { passive: true }); onScrollH();
    const qnav = qhHeader.querySelector('.qbh-nav');
    const qtoggle = qhHeader.querySelector('.qbh-nav-toggle');
    const setOpenH = (open) => {
      qnav.classList.toggle('is-open', open);
      qtoggle.setAttribute('aria-expanded', String(open));
      qtoggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    };
    qtoggle.addEventListener('click', () => setOpenH(!qnav.classList.contains('is-open')));
    qnav.querySelectorAll('.qbh-link').forEach((l) => l.addEventListener('click', () => setOpenH(false)));
    qnav.addEventListener('keydown', (e) => { if (e.key === 'Escape' && qnav.classList.contains('is-open')) { setOpenH(false); qtoggle.focus(); } });
    qnav.addEventListener('focusout', (e) => { if (qnav.classList.contains('is-open') && e.relatedTarget && !qnav.contains(e.relatedTarget)) setOpenH(false); });
  }

  /* ── Sticky nav background after scrolling ── */
  const nav = document.querySelector('.qb-nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('qb-nav--scrolled', window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ── In-page links: move focus to the target so keyboard users continue from there ── */
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const id = link.getAttribute('href').slice(1);
      const target = id && document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
      if (!target.hasAttribute('tabindex') && !target.matches('a[href], button, input, select, textarea')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      history.replaceState(null, '', '#' + id);
    });
  });

  /* ── Hamburger nav toggle ── */
  const navToggle = document.querySelector('.qb-nav-toggle');
  const navEl = document.querySelector('.qb-nav');
  if (navToggle && navEl) {
    const setOpen = (isOpen) => {
      navEl.classList.toggle('qb-nav-open', isOpen);
      navToggle.setAttribute('aria-expanded', String(isOpen));
      navToggle.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
      document.body.style.overflow = isOpen ? 'hidden' : '';
    };
    navToggle.addEventListener('click', () => setOpen(!navEl.classList.contains('qb-nav-open')));
    navEl.querySelectorAll('.qb-nav-link, .qb-cta-btn').forEach((link) => {
      link.addEventListener('click', () => setOpen(false));
    });
    // Keyboard: Escape closes and returns to the button; tabbing out of the menu closes it, so
    // focus never lands on page links hidden behind the open panel
    navEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && navEl.classList.contains('qb-nav-open')) { setOpen(false); navToggle.focus(); }
    });
    navEl.addEventListener('focusout', (e) => {
      if (navEl.classList.contains('qb-nav-open') && e.relatedTarget && !navEl.contains(e.relatedTarget)) setOpen(false);
    });
  }

  /* ── Beta form submission ── */
  const betaForm = document.getElementById('beta-form');
  // Where sign-ups go, by the host serving this page. Unknown hosts fail closed: the form is
  // disabled, never silently pointed at production. The preview (GitHub Pages) uses staging,
  // whose database and email are separate and which never sends real email.
  const SIGNUP_API = {
    'quarterback.velorallc.workers.dev': '',
    'quarterback-staging.velorallc.workers.dev': '',
    'arshad8049.github.io': 'https://quarterback-staging.velorallc.workers.dev',
    'localhost': '',
    '127.0.0.1': '',
  };
  const signupBase = Object.prototype.hasOwnProperty.call(SIGNUP_API, location.hostname) ? SIGNUP_API[location.hostname] : null;
  if (betaForm && signupBase === null) {
    betaForm.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
    const fb = document.getElementById('form-feedback');
    if (fb) fb.innerHTML = 'This copy of the page can’t take sign-ups. Please use the form on <a href="https://quarterback.velorallc.workers.dev/#beta" style="color:#E08A4C;">quarterback.velorallc.workers.dev</a>.';
  }
  if (betaForm && signupBase !== null) {
    betaForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = betaForm.querySelector('button[type="submit"]');
      const emailVal = betaForm.querySelector('[name="email"]').value.trim();
      const agentVal = (betaForm.querySelector('[name="agent"]') || {}).value || '';
      const originalText = btn.textContent;
      btn.textContent = 'Sending…';
      btn.disabled = true;

      // QB-35: the server says what actually happened (registered; welcome email sent or
      // pending retry; invalid input; rate limited) — show exactly that.
      let res = null, data = null;
      try {
        res = await fetch(signupBase + '/api/beta-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: emailVal, agent: agentVal.slice(0, 80) }),
        });
        try { data = await res.json(); } catch (_) {}
      } catch (_) {}

      if (res && res.ok && data && data.registered) {
        const NOTES = {
          sent: 'confirmation email sent',
          simulated: 'saved in the test environment (preview): no email is sent',
          not_sent: 'you are registered; we could not send a confirmation email, and we will contact you directly',
        };
        const note = data.duplicate ? 'you were already on the list'
          : NOTES[data.welcome_email] || 'you are registered; the confirmation email is delayed and will be retried';
        betaForm.innerHTML =
          '<div style="text-align:center;padding:48px 0;font-family:\'IBM Plex Mono\',monospace;font-size:15px;color:#6FBF9F;letter-spacing:0.06em;">✓ request received<br><span style="font-size:13px;color:#8A948F;letter-spacing:0.04em;display:block;margin-top:12px;">' + note + '</span></div>';
        // KAN-67: announce the outcome; #form-status is outside the form, so it survives the replacement
        const status = document.getElementById('form-status');
        if (status) status.textContent = 'Request received: ' + note + '.';
        return;
      }

      btn.textContent = originalText;
      btn.disabled = false;
      const fb = document.getElementById('form-feedback');
      if (fb && res && res.status === 400) { fb.textContent = 'Please check the email address (and keep the agent field under 80 characters).'; return; }
      if (fb && res && res.status === 429) { fb.textContent = 'Too many attempts from this network. Please try again in an hour.'; return; }
      // Fallback: show inline message with direct email link — no OS dialog
      if (fb) {
        fb.innerHTML = 'Something went wrong on our end. Email us directly at <a href="mailto:ashaik8.us@gmail.com?subject=QB%20Beta%20Access&body=Email%3A%20' + encodeURIComponent(emailVal) + '" style="color:#6FBF9F;">ashaik8.us@gmail.com</a> and we\'ll get you in.';
      }
    });
  }

})();
