(() => {
  'use strict';
  const chapters = [...document.querySelectorAll('.chapter')];
  const links = [...document.querySelectorAll('[data-chapter]')];
  const present = document.getElementById('present');
  const previous = document.getElementById('previous');
  const next = document.getElementById('next');
  const position = document.getElementById('chapter-position');
  const status = document.getElementById('verification');
  const original = document.getElementById('verify-original');
  const edited = document.getElementById('verify-edited');
  let current = 0, timer = null, playing = false, verifying = false;
  function stop() { playing = false; clearTimeout(timer); timer = null; present.textContent = 'Play walkthrough'; }
  function show(index, focus = false) {
    current = Math.max(0, Math.min(chapters.length - 1, index));
    chapters.forEach((chapter, i) => { chapter.hidden = i !== current; });
    links.forEach((link, i) => { if (i === current) link.setAttribute('aria-current', 'step'); else link.removeAttribute('aria-current'); });
    previous.disabled = current === 0; next.disabled = current === chapters.length - 1;
    position.textContent = `${current + 1} of ${chapters.length}. Recorded sandbox evidence.`;
    if (focus) document.getElementById('story').focus({ preventScroll: true });
  }
  function advance() {
    if (!playing) return;
    if (current === chapters.length - 1) { stop(); return; }
    show(current + 1); timer = setTimeout(advance, 25000);
  }
  links.forEach((link, index) => link.addEventListener('click', (event) => { event.preventDefault(); stop(); show(index, true); }));
  previous.addEventListener('click', () => { stop(); show(current - 1, true); });
  next.addEventListener('click', () => { stop(); show(current + 1, true); });
  present.hidden = false;
  document.querySelector('.transport').hidden = false;
  present.addEventListener('click', () => {
    if (playing) { stop(); return; }
    playing = true; show(0); present.textContent = 'Pause walkthrough'; timer = setTimeout(advance, 25000);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', stop);
  async function verify(tamper) {
    if (verifying) return;
    verifying = true; original.disabled = edited.disabled = true;
    status.textContent = 'Checking the receipt signature…';
    try {
      const file = await fetch('/demo-assets/covered-month-receipt.txt', { cache: 'no-store' });
      if (!file.ok) throw Error('Receipt unavailable');
      const text = await file.text();
      const payload = JSON.parse(text);
      async function check(body) {
        const response = await fetch('/api/receipts/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        if (!response.ok) throw Error('Verification unavailable');
        return response.json();
      }
      const baseline = await check(text);
      if (baseline.check?.ok !== true) {
        status.textContent = 'This instance could not verify the original. Check its configured receipt signing identity.';
        return;
      }
      if (tamper) {
        const sentence = payload.sentences.find((entry) => entry.text.includes('$25.00'));
        if (!sentence) throw Error('Example amount unavailable');
        sentence.text = sentence.text.replace('$25.00', '$250.00');
      }
      const result = tamper ? await check(JSON.stringify(payload)) : baseline;
      if (!tamper) status.textContent = 'Original verified. The signature is valid and the receipt is unchanged.';
      else status.textContent = result.check?.ok === false ? 'Edited copy rejected. Changing $25.00 to $250.00 breaks the receipt proof.' : 'The edited receipt was unexpectedly accepted. Do not rely on this check.';
    } catch { status.textContent = 'Verification is unavailable on this instance. You can download the receipt and check it on the accepted deployment.'; }
    finally { verifying = false; original.disabled = edited.disabled = false; }
  }
  original.addEventListener('click', () => verify(false)); edited.addEventListener('click', () => verify(true));
  show(0);
})();
