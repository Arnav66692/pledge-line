'use strict';

// The chrome both pages share, after unseen.co: the letter roll on the nav, the side menu, the cursor ring, and on the
// donor page the hero, the move into the call workspace, the background sound and the landing of new proof chips.
// It never touches app.js's elements beyond reading them, so the call works the same with or without this file.
(() => {
  const root = document.documentElement;
  const doc = document;
  const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => reduceMq.matches;
  const EXPO = 'cubic-bezier(0.87, 0, 0.13, 1)';
  const EXPO_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const scene = () => window.PledgeScene;
  const isDonor = doc.body.classList.contains('donor');

  const animate = (el, frames, opts) => {
    if (!el || reduced() || typeof el.animate !== 'function') return null;
    return el.animate(frames, { fill: 'both', ...opts });
  };
  const settle = (anims) => Promise.all(anims.filter(Boolean).map((a) => a.finished.catch(() => {})));

  // ---- Letter roll on the nav, and unfolding letters in the menu ----
  function letters(text) {
    const wrap = doc.createDocumentFragment();
    [...text].forEach((c, i) => {
      const span = doc.createElement('span');
      span.textContent = c === ' ' ? ' ' : c;
      span.style.setProperty('--i', String(i));
      wrap.append(span);
    });
    return wrap;
  }
  for (const link of doc.querySelectorAll('.nav-item')) {
    const text = link.textContent.trim();
    const a = doc.createElement('span');
    a.className = 'nav-item__a';
    a.setAttribute('aria-hidden', 'true');
    a.append(letters(text));
    const b = doc.createElement('span');
    b.className = 'nav-item__b';
    b.setAttribute('aria-hidden', 'true');
    b.append(letters(text));
    const label = doc.createElement('span');
    label.className = 'visually-hidden';
    label.textContent = text;
    link.replaceChildren(a, b, label);
  }
  for (const label of doc.querySelectorAll('.menu__label')) {
    const text = label.textContent.trim();
    label.setAttribute('aria-hidden', 'true');
    label.replaceChildren(letters(text));
    const sr = doc.createElement('span');
    sr.className = 'visually-hidden';
    sr.textContent = text;
    label.after(sr);
  }

  // ---- Menu: a mask wipe from the right, items slide in, letters unfold. Esc closes, focus stays inside ----
  const toggle = doc.querySelector('[data-menu-toggle]');
  const menu = doc.getElementById('menu');
  let menuOpen = false;
  let lastFocus = null;
  let menuAnims = [];

  function setCurrent() {
    const page = isDonor ? (root.dataset.mode === 'hero' ? '' : 'line') : root.dataset.page;
    for (const a of doc.querySelectorAll('[data-page-link]')) {
      const on = a.dataset.pageLink === page;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  function openMenu() {
    if (!menu || menuOpen) return;
    menuOpen = true;
    lastFocus = doc.activeElement;
    setCurrent();
    menu.hidden = false;
    root.classList.add('menu-open');
    toggle.setAttribute('aria-expanded', 'true');
    menuAnims.forEach((a) => a.cancel());
    const panel = menu.querySelector('.menu__panel');
    const inner = menu.querySelector('.menu__inner');
    const items = [...menu.querySelectorAll('.menu__item')];
    menuAnims = [
      animate(panel, [{ transform: 'translateX(100%)' }, { transform: 'none' }], { duration: 1000, easing: EXPO }),
      animate(inner, [{ transform: 'translateX(-100%)' }, { transform: 'none' }], { duration: 1000, easing: EXPO }),
      ...items.map((it, i) => animate(it, [{ transform: 'translateX(8.66rem)' }, { transform: 'none' }], { duration: 1000, delay: 50 + i * 40, easing: EXPO })),
      ...items.flatMap((it, i) => [...it.querySelectorAll('.menu__label > span')].map((c, j) => animate(c,
        [{ transform: 'scaleX(0)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: 700, delay: 300 + i * 60 + j * 25, easing: EXPO_OUT }))),
      ...[...menu.querySelectorAll('.menu__foot p > *, .menu__social li')].map((el, i) => animate(el,
        [{ transform: 'translateY(12px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 600, delay: 220 + i * 60, easing: EXPO_OUT })),
    ].filter(Boolean);
    const first = items.find((i) => !i.classList.contains('is-current')) ?? items[0];
    requestAnimationFrame(() => first?.focus({ preventScroll: true }));
  }

  function closeMenu({ restore = true } = {}) {
    if (!menuOpen) return;
    menuOpen = false;
    toggle.setAttribute('aria-expanded', 'false');
    root.classList.remove('menu-open');
    if (restore && lastFocus && doc.contains(lastFocus) && lastFocus !== doc.body) lastFocus.focus({ preventScroll: true });
    else if (restore) toggle.focus({ preventScroll: true });
    menuAnims.forEach((a) => a.cancel());
    const panel = menu.querySelector('.menu__panel');
    const inner = menu.querySelector('.menu__inner');
    const chars = [...menu.querySelectorAll('.menu__label > span')];
    menuAnims = [
      ...chars.map((c, i) => animate(c, [{ transform: 'none', opacity: 1 }, { transform: 'scaleX(0)', opacity: 0 }], { duration: 450, delay: i * 8, easing: 'cubic-bezier(0.7, 0, 0.84, 0)' })),
      animate(panel, [{ transform: 'none' }, { transform: 'translateX(100%)' }], { duration: 1000, delay: 350, easing: EXPO }),
      animate(inner, [{ transform: 'none' }, { transform: 'translateX(-100%)' }], { duration: 1000, delay: 350, easing: EXPO }),
    ].filter(Boolean);
    const done = menuAnims;
    settle(done).then(() => {
      if (menuOpen) return;
      menu.hidden = true;
      done.forEach((a) => a.cancel());
    });
  }

  if (toggle && menu) {
    toggle.addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()));
    menu.querySelector('[data-menu-close]')?.addEventListener('click', () => closeMenu());
    menu.addEventListener('click', (e) => {
      if (e.target.closest('.menu__item')) closeMenu({ restore: false });
    });
    doc.addEventListener('keydown', (e) => {
      if (!menuOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        return;
      }
      if (e.key === 'Tab') {
        const focusables = [toggle, ...menu.querySelectorAll('a[href]')];
        const i = focusables.indexOf(doc.activeElement);
        const n = e.shiftKey ? i - 1 : i + 1;
        if (i === -1 || n < 0 || n >= focusables.length) {
          e.preventDefault();
          focusables[(n + focusables.length) % focusables.length].focus();
        }
      }
    }, true);
  }

  // ---- Cursor: a ring that keeps up with the pointer, squashes along its travel, wraps nav links as a pill and
  // hides over buttons and discs. Fine pointers only, and never under reduced motion. ----
  const fine = window.matchMedia('(pointer: fine)').matches && !reduced();
  const cursor = doc.querySelector('.cursor');
  const ring = cursor?.querySelector('.cursor__ring');
  const c = { x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0, mode: '', calm: 0, live: false };
  let snap = null;
  function setCursorMode(mode, el) {
    if (mode === c.mode && mode !== 'pill') return;
    const leavingPill = c.mode === 'pill' && mode !== 'pill';
    c.mode = mode;
    snap = mode === 'pill' ? el : null;
    cursor.classList.toggle('is-pill', mode === 'pill');
    cursor.classList.toggle('is-hidden', mode === 'hide');
    if (mode === 'pill') {
      const r = el.getBoundingClientRect();
      ring.style.width = `${r.width}px`;
      ring.style.height = `${Math.max(r.height + 6, 30)}px`;
    } else {
      ring.style.width = '';
      ring.style.height = '';
    }
    if (leavingPill) {
      c.vx = 0;
      c.vy = 0;
      c.calm = 0.18;
    }
  }
  if (fine && cursor) {
    root.classList.add('has-cursor');
    window.addEventListener('pointermove', (e) => {
      c.tx = e.clientX;
      c.ty = e.clientY;
      if (!c.live) {
        c.live = true;
        c.x = c.tx;
        c.y = c.ty;
        cursor.classList.add('is-live');
      }
    }, { passive: true });
    doc.addEventListener('pointerover', (e) => {
      const nav = e.target.closest('.nav-item');
      const hide = e.target.closest('button, .btn, .pill, .disc, .orbit, .key, select, input, summary, label, .menu__item');
      if (nav) setCursorMode('pill', nav);
      else if (hide) setCursorMode('hide');
      else setCursorMode('');
    });
    doc.addEventListener('pointerleave', () => setCursorMode('hide'));
  }

  // ---- The hero drifts slightly against the pointer, and the pearl follows the headline's first line ----
  const heroFloat = doc.querySelector('.hero__float');
  const heroL1 = doc.querySelector('.hero__l1');
  const hero = { x: 0, y: 0, tx: 0, ty: 0 };
  if (fine && heroFloat) {
    window.addEventListener('pointermove', (e) => {
      hero.tx = (e.clientX - window.innerWidth / 2) * -0.066;
      hero.ty = (e.clientY - window.innerHeight / 2) * -0.04;
    }, { passive: true });
  }
  function placePearl() {
    if (!heroL1 || root.dataset.mode === 'call') return;
    const r = heroL1.getBoundingClientRect();
    if (r.width === 0) return;
    const radius = Math.min(r.height * 0.78, window.innerWidth * 0.14);
    // Just clear of the last letter, so the pearl sits beside the line and never over its ink.
    const x = Math.min(r.right + radius * 1.12 - hero.x, window.innerWidth - radius * 0.75);
    const y = r.top + r.height * 0.42 - hero.y - (window.innerWidth < 768 ? radius * 0.9 : 0);
    scene()?.setPearl(x, y, radius);
  }

  let lastT = performance.now();
  function tick(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    if (fine && cursor) {
      let tx = c.tx, ty = c.ty;
      if (snap) {
        const r = snap.getBoundingClientRect();
        tx = r.left + r.width / 2;
        ty = r.top + r.height / 2;
      }
      const k = 1 - Math.pow(snap ? 0.8 : 0.4, dt * 60);
      const px = c.x, py = c.y;
      c.x += (tx - c.x) * k;
      c.y += (ty - c.y) * k;
      const vx = (c.x - px) / Math.max(dt, 1e-3), vy = (c.y - py) / Math.max(dt, 1e-3);
      c.vx += (vx - c.vx) * 0.3;
      c.vy += (vy - c.vy) * 0.3;
      c.calm = Math.max(0, c.calm - dt);
      const s = snap || c.calm > 0 ? 0 : Math.min(Math.hypot(c.vx, c.vy) / 2200, 0.55);
      const angle = Math.atan2(c.vy, c.vx);
      cursor.style.transform = `translate3d(${c.x}px, ${c.y}px, 0)`;
      ring.style.transform = `rotate(${angle}rad) scale(${1 + s}, ${1 - s}) rotate(${-angle}rad)`;
    }
    if (fine && heroFloat && root.dataset.mode === 'hero') {
      const k = 1 - Math.exp(-dt / 0.45);
      hero.x += (hero.tx - hero.x) * k;
      hero.y += (hero.ty - hero.y) * k;
      heroFloat.style.transform = `translate3d(${hero.x.toFixed(2)}px, ${hero.y.toFixed(2)}px, 0)`;
    }
    requestAnimationFrame(tick);
  }
  if (fine) requestAnimationFrame(tick);

  // ---- The header's nav fades once the page scrolls under it, the way unseen's case pages do ----
  // Over a long page the logo steps aside while the page scrolls down, so it never sits on top of the text, and comes
  // back as soon as the page scrolls up. The menu disc stays.
  let lastY = window.scrollY;
  const onScroll = () => {
    const y = window.scrollY;
    root.classList.toggle('scrolled', y > 40);
    if (Math.abs(y - lastY) > 6) {
      root.classList.toggle('header-away', y > 80 && y > lastY);
      lastY = y;
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (!isDonor) {
    setCurrent();
    return;
  }

  // ======== Donor page ========
  const heroEl = doc.getElementById('hero');
  const ws = doc.getElementById('workspace');
  const start = doc.getElementById('start');
  const callLive = () => start?.textContent.trim() === 'End call';
  const heroParts = () => [...doc.querySelectorAll('.hero__caps, .hero__l1, .hero__l2, .hero__cta, .hero__note')];

  function setMode(mode) {
    root.dataset.mode = mode;
    if (ws) ws.inert = mode === 'hero';
    if (heroEl) heroEl.inert = mode === 'call';
    for (const corner of doc.querySelectorAll('.corner')) corner.inert = mode === 'call';
    scene()?.setMode(mode);
    setCurrent();
    sound.update();
  }

  const TARGETS = { line: 'workspace', receipts: 'receipts-title', record: 'record-title' };
  function focusTarget(name) {
    const el = doc.getElementById(TARGETS[name] ?? 'workspace');
    if (!el) return;
    if (name === 'line' || !TARGETS[name]) {
      window.scrollTo({ top: 0, behavior: 'auto' });
      // Start call is the next step, so focus lands on it. During a call it lands on the workspace.
      (callLive() ? ws : start)?.focus({ preventScroll: true });
      return;
    }
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  }

  let moving = false;
  async function openLine(name = 'line') {
    if (root.dataset.mode === 'call') {
      focusTarget(name);
      return;
    }
    if (moving) return;
    moving = true;
    const out = heroParts().map((el, i) => animate(el,
      [{ transform: 'none', opacity: 1, filter: 'blur(0px)' }, { transform: 'translateY(-3rem)', opacity: 0, filter: 'blur(6px)' }],
      { duration: 700, delay: i * 45, easing: EXPO }));
    scene()?.setMode('call');
    await settle(out);
    out.forEach((a) => a?.cancel());
    setMode('call');
    const panels = [...ws.querySelectorAll('.panel, .foot')];
    panels.forEach((p, i) => animate(p, [{ transform: 'translateY(4rem)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 1000, delay: i * 100, easing: EXPO_OUT })?.finished.then((a) => a.cancel()).catch(() => {}));
    moving = false;
    focusTarget(name);
  }

  function showHero() {
    // During a call the logo only scrolls back to the top, so a live call is never hidden away.
    if (callLive()) {
      focusTarget('line');
      return;
    }
    if (root.dataset.mode === 'hero') return;
    window.scrollTo({ top: 0, behavior: 'auto' });
    setMode('hero');
    introHero();
    doc.getElementById('open-line')?.focus({ preventScroll: true });
  }

  // The headline arrives smeared and settles, unseen's opening, faked on real text so it stays readable to everyone.
  function introHero() {
    heroParts().forEach((el, i) => animate(el,
      [{ transform: 'translateY(2.2rem)', opacity: 0, filter: 'blur(14px)' }, { transform: 'none', opacity: 1, filter: 'blur(0px)' }],
      { duration: 1400, delay: 150 + i * 110, easing: EXPO_OUT })?.finished.then((a) => a.cancel()).catch(() => {}));
  }

  doc.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (!go || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    if (menuOpen) closeMenu({ restore: false });
    if (go.dataset.go === 'hero') showHero();
    else openLine(go.dataset.go);
  });

  // ---- Background sound. Off by default: the line speaks its replies, so a bed must never talk over the donor or
  // add to the gap the pilot times. When on, it plays on the hero only and drops to silent the moment a call starts.
  const sound = (() => {
    const disc = doc.getElementById('ambient');
    let ctx = null;
    let bus = null;
    let on = false;
    let rest = 0;
    function build() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      bus = ctx.createGain();
      bus.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      lp.Q.value = 0.4;
      bus.connect(ctx.destination);
      lp.connect(bus);
      // A soft chord of four detuned tones that swells and fades on slow, unrelated cycles.
      [146.83, 220, 277.18, 329.63].forEach((f, i) => {
        const osc = ctx.createOscillator();
        osc.type = i % 2 ? 'sine' : 'triangle';
        osc.frequency.value = f;
        osc.detune.value = (i - 1.5) * 4;
        const g = ctx.createGain();
        g.gain.value = 0.05;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.05 + i * 0.023;
        const depth = ctx.createGain();
        depth.gain.value = 0.04;
        lfo.connect(depth).connect(g.gain);
        osc.connect(g).connect(lp);
        osc.start();
        lfo.start();
      });
      // Water: filtered noise, very low.
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      noise.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 520;
      band.Q.value = 0.7;
      const ng = ctx.createGain();
      ng.gain.value = 0.035;
      noise.connect(band).connect(ng).connect(bus);
      noise.start();
      return true;
    }
    function audible() {
      return on && root.dataset.mode === 'hero' && !callLive();
    }
    function update() {
      if (!disc) return;
      disc.setAttribute('aria-pressed', String(on));
      disc.title = on ? 'Background sound, on' : 'Background sound, off';
      const play = audible();
      disc.classList.toggle('is-playing', play);
      if (!ctx) return;
      const now = ctx.currentTime;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      // Down fast enough that the first reply never shares the air with it.
      bus.gain.linearRampToValueAtTime(play ? 0.32 : 0, now + (play ? 1.6 : 0.25));
      clearTimeout(rest);
      if (play && ctx.state === 'suspended') ctx.resume();
      // Once the fade is down, the whole graph sleeps, so nothing runs next to the mic and the reply.
      if (!play) rest = setTimeout(() => { if (!audible() && ctx.state === 'running') ctx.suspend(); }, 300);
    }
    disc?.addEventListener('click', () => {
      on = !on;
      if (on && !ctx && !build()) on = false;
      update();
    });
    return { update };
  })();

  // A call starting or ending flips Start call's label, which is the one signal app.js gives the page.
  if (start) new MutationObserver(() => sound.update()).observe(start, { childList: true, characterData: true, subtree: true });

  // ---- New proof chips land, the way unseen's filter pills arrive. Only a new turn's chips move ----
  const receipts = doc.getElementById('receipts');
  let turnsSeen = 0;
  if (receipts) {
    new MutationObserver(() => {
      const turns = receipts.querySelectorAll('.turn');
      if (turns.length <= turnsSeen) {
        turnsSeen = turns.length;
        return;
      }
      turnsSeen = turns.length;
      const chips = [...turns[turns.length - 1].querySelectorAll('.chip')];
      chips.forEach((chip, i) => animate(chip,
        [{ transform: 'translateY(0.8rem) scale(0.92)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: 800, delay: 120 + i * 90, easing: EXPO_OUT })?.finished.then((a) => a.cancel()).catch(() => {}));
    }).observe(receipts, { childList: true });
  }

  // ---- Start ----
  const hash = window.location.hash.replace('#', '');
  const deep = { workspace: 'line', 'receipts-title': 'receipts', 'record-title': 'record' }[hash];
  setMode(deep ? 'call' : 'hero');
  if (deep) requestAnimationFrame(() => focusTarget(deep));
  else introHero();

  const pearlLoop = () => {
    placePearl();
    if (fine) requestAnimationFrame(pearlLoop);
  };
  doc.fonts?.ready.then(placePearl);
  window.addEventListener('resize', placePearl);
  if (fine) requestAnimationFrame(pearlLoop);
  else placePearl();
})();
