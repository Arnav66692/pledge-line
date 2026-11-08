'use strict';

// The chrome every page shares, after typesafe.ai: a phone menu of tiles that opens in one frame, jumps between the
// donor page's sections, and on the donor page the loader window, the headline's spring entrance, the desk windows that
// can be tugged and spring back, and the single-open questions. It never touches app.js's elements beyond reading them,
// so the call works the same with or without this file.
(() => {
  const root = document.documentElement;
  const doc = document;
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isDonor = doc.body.classList.contains('donor');
  const animate = (el, frames, opts) => {
    if (!el || reduced() || typeof el.animate !== 'function') return null;
    return el.animate(frames, opts);
  };

  // ---- Menu: right-aligned tiles, no animation. Esc closes, focus stays inside ----
  const toggle = doc.querySelector('[data-menu-toggle]');
  const menu = doc.getElementById('menu');
  let menuOpen = false;
  let lastFocus = null;

  function setCurrent(page) {
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
    menu.hidden = false;
    root.classList.add('menu-open');
    toggle.setAttribute('aria-expanded', 'true');
    menu.querySelector('.menu__item')?.focus({ preventScroll: true });
  }

  function closeMenu({ restore = true } = {}) {
    if (!menuOpen) return;
    menuOpen = false;
    menu.hidden = true;
    root.classList.remove('menu-open');
    toggle.setAttribute('aria-expanded', 'false');
    if (!restore) return;
    const back = lastFocus && doc.contains(lastFocus) && lastFocus !== doc.body ? lastFocus : toggle;
    back.focus({ preventScroll: true });
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
      if (e.key !== 'Tab') return;
      const focusables = [toggle, ...menu.querySelectorAll('a[href]')];
      const i = focusables.indexOf(doc.activeElement);
      const n = e.shiftKey ? i - 1 : i + 1;
      if (i === -1 || n < 0 || n >= focusables.length) {
        e.preventDefault();
        focusables[(n + focusables.length) % focusables.length].focus();
      }
    }, true);
  }

  if (!isDonor) {
    setCurrent(root.dataset.page);
    return;
  }

  // ======== Donor page ========
  const start = doc.getElementById('start');
  const ws = doc.getElementById('workspace');
  const callLive = () => start?.textContent.trim() === 'End call';
  const TARGETS = { hero: 'hero', line: 'line-sec', receipts: 'receipts-title', record: 'record-title' };

  // Native scroll, no smooth scrolling, the way Typesafe moves. Focus lands on the next step.
  function go(name) {
    const el = doc.getElementById(TARGETS[name] ?? 'line-sec');
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'auto' });
    if (name === 'hero') {
      doc.getElementById('open-line')?.focus({ preventScroll: true });
      return;
    }
    if (name === 'line') {
      (callLive() ? ws : start)?.focus({ preventScroll: true });
      return;
    }
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }

  doc.addEventListener('click', (e) => {
    const link = e.target.closest('[data-go]');
    if (!link || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    if (menuOpen) closeMenu({ restore: false });
    go(link.dataset.go);
  });

  // The Line tile reads as current while the call is on screen.
  const lineSec = doc.getElementById('line-sec');
  if (lineSec && 'IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => setCurrent(entry.isIntersecting ? 'line' : ''), { threshold: 0.2 }).observe(lineSec);
  }

  // ---- Questions: one open at a time. The icon turns over ----
  const faq = doc.querySelector('[data-faq]');
  if (faq) {
    faq.addEventListener('click', (e) => {
      const q = e.target.closest('.faq__q');
      if (!q) return;
      const opening = q.getAttribute('aria-expanded') !== 'true';
      for (const item of faq.querySelectorAll('.faq__item')) {
        const btn = item.querySelector('.faq__q');
        const panel = doc.getElementById(btn.getAttribute('aria-controls'));
        const open = opening && btn === q;
        btn.setAttribute('aria-expanded', String(open));
        item.classList.toggle('is-open', open);
        if (panel) panel.hidden = !open;
      }
    });
  }

  // ---- Desk windows: tug one by its bar, it follows the pointer 1 to 1 and springs back on release ----
  const wide = window.matchMedia('(min-width: 810px)');
  let topZ = 10;
  for (const win of doc.querySelectorAll('.desk .win')) {
    const bar = win.querySelector('.win__bar');
    let drag = null;
    bar?.addEventListener('pointerdown', (e) => {
      if (!wide.matches || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
      win.style.zIndex = String(topZ += 1);
      win.classList.add('is-held');
      win.getAnimations?.().forEach((a) => a.cancel());
      bar.setPointerCapture(e.pointerId);
    });
    bar?.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.dx = e.clientX - drag.x;
      drag.dy = e.clientY - drag.y;
      win.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
    });
    const release = () => {
      if (!drag) return;
      const from = `translate(${drag.dx}px, ${drag.dy}px)`;
      drag = null;
      win.classList.remove('is-held');
      win.style.transform = '';
      // A small overshoot near 360 ms, settled by about 525 ms.
      animate(win, [{ transform: from }, { transform: 'none' }], { duration: 525, easing: 'cubic-bezier(0.3, 1.25, 0.5, 1)' });
    };
    bar?.addEventListener('pointerup', release);
    bar?.addEventListener('pointercancel', release);
  }

  // ---- Loader window, then the headline springs up ----
  function entrance() {
    // A hidden tab pauses animations, which would leave the headline parked at its first frame.
    if (doc.hidden) return;
    const anims = [
      animate(doc.querySelector('.hero .eyebrow'), [{ opacity: 0.02 }, { opacity: 1 }], { duration: 175, easing: 'linear' }),
      animate(doc.querySelector('.h-hero'),
        [{ transform: 'translateY(94px) scaleY(1.131)', transformOrigin: '0 100%' }, { transform: 'none', transformOrigin: '0 100%' }],
        { duration: 391, easing: 'cubic-bezier(0.2, 1.02, 0.4, 1)' }),
    ];
    // If the page is throttled, jump to the end rather than park the headline mid-move.
    setTimeout(() => anims.forEach((a) => { try { a?.finish(); } catch { /* already done */ } }), 700);
  }

  const loader = doc.getElementById('loader');
  const deep = window.location.hash.replace('#', '');
  const deepName = { workspace: 'line', 'line-sec': 'line', 'receipts-title': 'receipts', 'record-title': 'record' }[deep];
  if (deepName) {
    requestAnimationFrame(() => go(deepName));
  } else if (loader && !reduced() && typeof loader.animate === 'function') {
    loader.hidden = false;
    const fill = loader.querySelector('.loader__fill');
    let shown = false;
    const reveal = () => {
      if (shown) return;
      shown = true;
      loader.hidden = true;
      entrance();
    };
    // The bar decelerates to 84 percent at about one second, then the page swaps in. A background tab can stall the
    // animation, so a timer reveals the page regardless.
    fill.animate([{ width: '0%' }, { width: '7%', offset: 0.1 }, { width: '84%' }],
      { duration: 1000, easing: 'cubic-bezier(0.2, 0.7, 0.4, 1)', fill: 'forwards' })
      .finished.catch(() => {}).then(reveal);
    setTimeout(reveal, 1300);
  } else {
    entrance();
  }
})();
