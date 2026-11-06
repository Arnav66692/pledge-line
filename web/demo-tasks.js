(() => {
  'use strict';
  const select = document.getElementById('task-case');
  if (!select) return;
  const dataUrl = '/demo-assets/donor-task-outcomes-20261106.txt';
  const request = document.getElementById('task-request');
  const initial = document.getElementById('task-initial');
  const status = document.getElementById('task-selection-status');
  const loadStatus = document.getElementById('task-load-status');
  const labels = {
    'control-status': 'Read the gift', 'control-pause': 'Pause a gift',
    'control-resume': 'Restart a gift', 'control-cancel': 'Cancel a gift',
    'control-hardship': 'Ask for hardship relief', 'control-charge-check': 'Decline a charge review',
    'natural-resume-paraphrase': 'Restart a gift in other words',
    'natural-pause-after-refusal': 'Pause, after refusing cancellation',
    'natural-cancel-refuses-pause': 'Cancel, after refusing a pause',
    'natural-hardship-budget': 'Describe a difficult month',
    'natural-clarify-undecided': 'Leave a choice undecided',
    'natural-clarify-refuses-both': 'Refuse both suggested actions',
  };
  const node = (tag, text) => {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  };
  function recordCard(arm, record) {
    const card = document.getElementById(`task-${arm}`);
    card.querySelector('h3').textContent = record.complete ? 'Task complete' : 'Task incomplete';
    const changes = record.actualWrites.filter((write) => write.ok).length;
    const money = record.mockMoney;
    const dollars = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    card.querySelector('.task-result').textContent = `Mock gift ${record.finalStatus.toLowerCase()} · ${changes ? `${changes} approved change${changes === 1 ? '' : 's'}` : 'no changes'}` +
      (money.sponsorCapturedCents || money.donorRefundedCents ? ` · sponsor ${dollars(money.sponsorCapturedCents)}, refund ${dollars(money.donorRefundedCents)}` : '');
    const conversation = card.querySelector('.task-conversation');
    const turns = [];
    record.replies.forEach((reply, index) => {
      if (index > 0) {
        const turn = node('li', '');
        turn.append(node('span', 'Scripted caller'), node('p', record.followUpsGiven[index - 1]));
        turns.push(turn);
      }
      const turn = node('li', '');
      turn.append(node('span', 'Agent'), node('p', reply));
      turns.push(turn);
    });
    conversation.replaceChildren(...turns);
    let boundary = card.querySelector('.task-boundary');
    if (!boundary) {
      boundary = node('p', '');
      boundary.className = 'task-boundary';
      conversation.after(boundary);
    }
    boundary.hidden = !record.blockedFollowUp;
    boundary.textContent = record.blockedFollowUp ? `Scripted consent boundary: ${record.blockedFollowUp}` : '';
    const trace = card.querySelector('.task-trace');
    trace.open = false;
    const route = record.routes.map((entry) => `${entry.intent} (${entry.model}; ${(entry.latencyMs / 1000).toFixed(2)} seconds)`).join('; ');
    trace.replaceChildren(node('summary', 'Routing and execution record'),
      node('p', `Recorded route: ${route || 'none'}. Proposals: ${record.actualProposals.join(', ') || 'none'}. Changes: ${record.actualWrites.map((write) => `${write.kind}: ${write.ok ? 'confirmed' : 'not confirmed'}`).join(', ') || 'none'}.`),
      node('p', record.mismatches.length ? `Task mismatches: ${record.mismatches.join('; ')}` : 'No mismatches against this task’s frozen completion contract.'));
  }
  function valid(record) {
    return record && Object.hasOwn(labels, record.id) && ['rules', 'composed'].includes(record.arm) &&
      typeof record.complete === 'boolean' && typeof record.request === 'string' &&
      typeof record.initialStatus === 'string' && typeof record.finalStatus === 'string' &&
      ['replies', 'followUpsGiven', 'actualProposals', 'mismatches'].every((key) => Array.isArray(record[key]) && record[key].every((value) => typeof value === 'string')) &&
      record.replies.length > 0 && record.followUpsGiven.length === record.replies.length - 1 &&
      Array.isArray(record.actualWrites) && record.actualWrites.every((write) => typeof write.kind === 'string' && typeof write.ok === 'boolean') &&
      Array.isArray(record.routes) && record.routes.every((route) => typeof route.intent === 'string' && typeof route.model === 'string' && Number.isFinite(route.latencyMs)) &&
      Number.isSafeInteger(record.mockMoney?.sponsorCapturedCents) && Number.isSafeInteger(record.mockMoney?.donorRefundedCents);
  }
  async function load() {
    try {
      const response = await fetch(dataUrl);
      if (!response.ok) throw Error('Recorded evidence unavailable');
      const data = await response.json();
      if (!Array.isArray(data.cases) || data.cases.length !== 24 || !data.cases.every(valid)) throw Error('Recorded evidence incomplete');
      const records = new Map(data.cases.map((record) => [`${record.arm}:${record.id}`, record]));
      if (records.size !== 24 || Object.keys(labels).some((id) => !records.has(`rules:${id}`) || !records.has(`composed:${id}`))) throw Error('Recorded evidence incomplete');
      function render(id) {
        const composed = records.get(`composed:${id}`), rules = records.get(`rules:${id}`);
        request.textContent = `“${composed.request}”`;
        initial.textContent = `Starting mock gift: ${composed.initialStatus.toLowerCase()}.`;
        recordCard('composed', composed); recordCard('rules', rules);
      }
      const options = Object.entries(labels).map(([id, label]) => {
        const option = node('option', `${id.startsWith('control-') ? 'Direct control' : 'Context and phrasing'} · ${label}`);
        option.value = id;
        return option;
      });
      select.replaceChildren(...options);
      select.value = 'natural-resume-paraphrase';
      render(select.value);
      select.disabled = false;
      select.addEventListener('change', () => {
        if (!Object.hasOwn(labels, select.value)) return;
        render(select.value);
        status.textContent = `Showing recorded comparison: ${labels[select.value]}.`;
      });
    } catch {
      loadStatus.textContent = 'The task selector is unavailable. The recorded restart example remains below; all outcomes can also be downloaded.';
    }
  }
  load();
})();
