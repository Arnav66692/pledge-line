// An in-memory stand-in for PayPal's Subscriptions v1 endpoints. It returns the shapes PayPal's public docs describe
// and never touches the network. The ids and times in the demo are made up.

const RULES = Object.freeze({
  suspend: { from: ['ACTIVE'], to: 'SUSPENDED' },
  activate: { from: ['SUSPENDED'], to: 'ACTIVE' },
  cancel: { from: ['ACTIVE', 'SUSPENDED'], to: 'CANCELLED' },
});

export class FakePayPal {
  #subs;

  constructor(subs) {
    this.#subs = structuredClone(subs);
  }

  async get(id) {
    const sub = this.#subs[id];
    if (!sub) return { httpStatus: 404, body: { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.', debug_id: 'fake-404' } };
    return { httpStatus: 200, body: structuredClone(sub) };
  }

  async suspend(id) {
    return this.#act(id, 'suspend');
  }

  async activate(id) {
    return this.#act(id, 'activate');
  }

  async cancel(id) {
    return this.#act(id, 'cancel');
  }

  #act(id, action) {
    const sub = this.#subs[id];
    if (!sub) return { httpStatus: 404, body: { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.', debug_id: 'fake-404' } };
    const rule = RULES[action];
    if (!rule.from.includes(sub.status)) {
      return { httpStatus: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'The subscription status does not allow this action.', debug_id: 'fake-422' } };
    }
    this.#subs[id] = { ...sub, status: rule.to };
    return { httpStatus: 204, body: null };
  }
}
