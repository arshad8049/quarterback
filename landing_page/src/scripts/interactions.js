(function () {
  'use strict';

  /* ── Motion: honour prefers-reduced-motion at load AND when it changes mid-session ── */
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => motionQuery.matches;
  const orbits = Array.from(document.querySelectorAll('.qb-orbit'));
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
  function applyMotion() {
    const off = reduced();
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
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach((el) => obs.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('qb-visible'));
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
