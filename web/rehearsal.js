const form = document.querySelector('#rehearsal-form');
const output = document.querySelector('#output');
const button = document.querySelector('#run');
const status = document.querySelector('#run-status');
const scenarioChoice = document.querySelector('#scenario-choice');
const mobile = window.matchMedia('(max-width:800px)');
document.querySelector('#conversation-details').open = !mobile.matches;
scenarioChoice.addEventListener('change', () => {
  for (const radio of form.querySelectorAll('input[name="scenario"]')) radio.checked = radio.value === scenarioChoice.value;
});
for (const radio of form.querySelectorAll('input[name="scenario"]')) radio.addEventListener('change', () => { if (radio.checked) scenarioChoice.value = radio.value; });
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const set = (id, text) => { document.getElementById(id).textContent = text; };
const OUTCOMES = {
  covered: ['The month is covered.', 'The sponsor paid first. The donor received the same gross amount back. The monthly gift remains active.'],
  no_consent: ['Nothing moves without a yes.', 'The offer is waiting. Asking for relief did not approve the sponsor capture or donor refund.'],
  changed_charge: ['The old yes cannot pay.', 'The charge changed after the offer. Fresh reads invalidate the old terms. No financial attempt follows.'],
  sponsor_declined: ['No funding. No refund.', 'The sponsor capture was refused. The line does not put the nonprofit into an unfunded refund.'],
  refund_lost: ['One refund. Checked again.', 'The refund response was lost. A fresh read of the same charge confirmed the refund. No second refund was attempted.'],
  refund_unknown: ['Uncertain stays uncertain.', 'The sponsor was captured, but the line cannot establish the donor refund. The case stays open for staff. It does not return the sponsor funds or claim completion.'],
};
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function render(result) {
  const [title, explanation] = OUTCOMES[result.scenario];
  set('result-label', result.passed ? 'Simulation complete. All five checks passed.' : 'Simulation complete. A check needs attention.');
  set('result-title', result.passed ? title : 'The record needs review.');
  set('result-explanation', result.passed ? explanation : 'Inspect the execution record and failed checks below.');
  set('sponsor', money(result.money.sponsorCapturedCents));
  set('refunded', result.money.refundUnresolved ? 'Unresolved' : money(result.money.donorRefundedCents));
  set('gift', result.giftStatus === 'ACTIVE' ? 'Active' : result.giftStatus ?? 'Not established');
  set('fees', `Simulated sponsor processing fee, ${money(result.money.sponsorFeeCents)}. Equal gross amounts do not mean fee-free coverage. ${result.financialAttempts} financial attempts, ${result.readCount} adapter reads, ${result.externalCalls} external calls.`);
  const conversation = document.querySelector('#conversation');
  conversation.replaceChildren();
  for (const turn of result.transcript) for (const [speaker, text, kind] of [['Donor', turn.donor, 'donor'], ['Pledge Line', turn.reply, 'line']]) {
    const node = element('div', undefined, `speech ${kind}`);
    node.append(element('span', speaker, 'speaker'), element('p', text));
    conversation.append(node);
  }
  document.querySelector('#checks').replaceChildren(...result.checks.map((check) => {
    const item = element('li'); item.append(element('span', check.passed ? '✓' : '×', check.passed ? 'check-mark' : 'check-failed'), element('span', `${check.name}. ${check.passed ? 'Passed.' : 'Failed.'}`)); return item;
  }));
  document.querySelector('#timeline').replaceChildren(...result.timeline.map((event) => {
    const row = element('tr');
    row.append(element('td', `${event.seq}. ${event.type}`), element('td', (event.kind ?? 'offer').replaceAll('_', ' ')),
      element('td', event.outcome ?? event.status ?? (event.ok === null ? 'Recorded' : event.ok ? 'Response accepted' : 'Response refused or uncertain')));
    return row;
  }));
  document.querySelector('#sentences').replaceChildren(...result.sentences.map((sentence) => {
    const item = element('li', sentence.text); item.append(element('small', sentence.verdict === 'proven' ? 'Backed by this simulated record' : sentence.verdict === 'plain' ? 'No financial claim' : 'Claim blocked')); return item;
  }));
  document.querySelector('#empty').hidden = true;
  document.querySelector('#result').hidden = false;
  document.querySelector('#result-title').focus({ preventScroll: !mobile.matches });
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity() || button.disabled) return;
  const data = new FormData(form);
  const amountCents = Math.round(Number(data.get('amount')) * 100);
  document.querySelector('#result').hidden = true;
  document.querySelector('#empty').hidden = false;
  button.disabled = true; output.setAttribute('aria-busy', 'true');
  status.textContent = 'Running the consent gate, relief flow and claim checks.';
  try {
    const response = await fetch('/api/rehearsal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: data.get('scenario'), amountCents }) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Please wait a minute before another rehearsal.' : 'The rehearsal could not finish. Please try again.');
    render(await response.json()); status.textContent = 'Complete. Disposable simulation, no payments.';
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; output.setAttribute('aria-busy', 'false'); }
});
