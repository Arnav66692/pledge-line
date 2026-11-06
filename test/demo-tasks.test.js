import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const evidence = JSON.parse(read('../web/demo-assets/donor-task-outcomes-20261106.txt'));
const fixture = JSON.parse(read('../docs/results/donor-outcome-2026-11-06/fixture.json')).cases;
const outcomes = read('../docs/results/donor-outcome-2026-11-06/outcomes.jsonl').trim().split('\n').map(JSON.parse).filter((row) => row.kind === 'case');

test('all public task conversations and financial results reproduce the frozen source, including failures', () => {
  assert.equal(evidence.cases.length, 24);
  assert.equal(new Set(evidence.cases.map((row) => `${row.arm}:${row.id}`)).size, 24);
  for (const row of evidence.cases) {
    const raw = outcomes.find((result) => result.arm === row.arm && result.id === row.id);
    const task = fixture.find((result) => result.id === row.id);
    assert.ok(raw && task);
    for (const key of ['complete', 'actualProposals', 'actualWrites', 'finalStatus', 'mockMoney', 'mismatches', 'routes', 'initialStatus', 'replies', 'blockedFollowUp']) assert.deepEqual(row[key], raw[key], `${row.arm}:${row.id}:${key}`);
    assert.equal(row.request, task.text);
    assert.deepEqual(row.followUpsGiven, task.followUps.slice(0, raw.replies.length - 1));
  }
  assert.equal(evidence.cases.filter((row) => row.arm === 'rules' && row.complete).length, 7);
  assert.equal(evidence.cases.filter((row) => row.arm === 'composed' && row.complete).length, 12);
  const html = read('../web/demo.html');
  const first = evidence.cases.find((row) => row.arm === 'composed' && row.id === 'natural-resume-paraphrase');
  assert.ok(html.includes(first.request));
  for (const reply of first.replies) assert.ok(html.includes(reply), 'no-JS example retains the exact recorded reply');
  const baseline = evidence.cases.find((row) => row.arm === 'rules' && row.id === first.id);
  assert.ok(html.includes(`Route: ${baseline.routes[0].intent}. No proposal. No change.`));
  for (const reply of baseline.replies) assert.ok(html.includes(reply));
  assert.ok(html.indexOf('id="agent-proof"') < html.indexOf('id="evidence-archive"'));
});

class Element {
  constructor(text = '') { this.textContent = text; this.children = []; this.events = {}; this.disabled = true; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, handler) { this.events[name] = handler; }
  querySelector(selector) { return this.parts[selector]; }
}
async function browser({ data = evidence, ok = true, fail = false } = {}) {
  const elements = new Map();
  for (const id of ['task-case', 'task-request', 'task-initial', 'task-selection-status', 'task-load-status']) elements.set(id, new Element(`fallback:${id}`));
  for (const arm of ['composed', 'rules']) {
    const card = new Element();
    card.parts = Object.fromEntries(['h3', '.task-result', '.task-conversation', '.task-boundary', '.task-trace'].map((key) => [key, new Element('fallback')]));
    elements.set(`task-${arm}`, card);
  }
  const calls = [];
  vm.runInNewContext(read('../web/demo-tasks.js'), {
    document: { getElementById: (id) => elements.get(id), createElement: () => new Element() },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fail) throw Error('offline');
      return { ok, json: async () => data };
    },
  });
  await new Promise(setImmediate);
  return { elements, calls, select: elements.get('task-case') };
}

test('task selection displays exact approval dialogue for every arm without another request', async () => {
  const page = await browser();
  assert.equal(page.select.disabled, false);
  assert.equal(page.select.children.length, 12);
  for (const task of fixture) {
    page.select.value = task.id;
    page.select.events.change();
    assert.equal(page.elements.get('task-request').textContent, `“${task.text}”`);
    for (const arm of ['composed', 'rules']) {
      const record = evidence.cases.find((row) => row.arm === arm && row.id === task.id);
      const parts = page.elements.get(`task-${arm}`).parts;
      assert.equal(parts.h3.textContent, record.complete ? 'Task complete' : 'Task incomplete');
      const dialogue = parts['.task-conversation'].children.map((turn) => turn.children[1].textContent);
      const expected = record.replies.flatMap((reply, index) => index ? [record.followUpsGiven[index - 1], reply] : [reply]);
      assert.deepEqual(dialogue, expected);
      assert.equal(parts['.task-boundary'].hidden, !record.blockedFollowUp);
      for (const route of record.routes) assert.ok(parts['.task-trace'].children[1].textContent.includes(route.intent));
    }
  }
  assert.deepEqual(page.calls, [{ url: '/demo-assets/donor-task-outcomes-20261106.txt', options: undefined }]);
});

test('unavailable or incomplete task evidence retains the static example and explains the failure', async () => {
  for (const options of [{ fail: true }, { ok: false }, { data: { cases: evidence.cases.slice(1) } }, { data: { cases: Array(24).fill(evidence.cases[0]) } }]) {
    const page = await browser(options);
    assert.equal(page.select.disabled, true);
    assert.equal(page.elements.get('task-request').textContent, 'fallback:task-request');
    assert.equal(page.elements.get('task-composed').parts.h3.textContent, 'fallback');
    assert.match(page.elements.get('task-load-status').textContent, /selector is unavailable/);
    assert.equal(page.calls.length, 1);
  }
});
