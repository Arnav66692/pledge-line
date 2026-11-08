# Pledge Line

Try `/rehearsal` for a credential-free donor-relief simulation with six inspectable outcomes. It runs the current consent, relief and claim-checking code against disposable mock records, without API credits or payments. [Scope and validation](docs/RELIEF-REHEARSAL-2026-11-06.md).

A donor support line and supply desk for small nonprofits, with explicit approval before PayPal sandbox actions and receipts backed by provider records.

[Donor line demo](https://pledge-line.onrender.com/) · [Covered Month and rehearsal](https://pledge-line.onrender.com/demo) · [Documentation](docs/README.md) · [Setup](SETUP.md) · [AI evidence](docs/AI-VALUE-EVIDENCE-2026-11-05.md) · [pledge-proof, the claim checker as a library](packages/pledge-proof/README.md)

Hosted donor line: open the Donor line demo link, press **Start call**, and enter the demo PIN **2468** on the keypad. The gift is a PayPal sandbox subscription, so no real money moves.

Pledge Line lets a fictional donor pause or restart a monthly gift, request a one-time invoice, or review an unfamiliar charge through voice or text. Its supply desk turns a purchasing goal into reviewed limits, compares supplier quotes and settles an approved plan. Models can suggest intent and terms; application code controls consent and payment authority.

**Status:** PayPal sandbox project for the PayPal AI Hackathon. No real money moves. The shared demo PIN gates a fictional account; it does not establish a real donor's identity. The three controlled supplier endpoints share one owned sandbox merchant. Independent suppliers, fulfillment and live-money readiness have not been established.

## What you can inspect

| Component | Behavior |
| --- | --- |
| Donor line | Reads a gift from PayPal, requests a separate confirmation, makes an approved change and reads the result back. |
| Covered Month | For eligible hardship relief, captures sponsor sandbox funds and refunds the donor's charge, with each leg tracked separately. |
| Supply desk | Drafts editable buying limits, validates quotes and chooses a complete allocation within the budget. Exact-plan and PayPal buyer approvals precede settlement. |
| Receipts | Associates statements with provider reads and offers signed, tamper-evident donor receipts. |
| Recovery and staff view | Shows uncertain or partial outcomes and checks existing payment identities before allowing further action. |

See the [project reference](docs/PROJECT_GUIDE.md) for the full behavior, configuration, safety rules and known gaps.

## Run locally without keys

Use Node.js 22.12 or newer, from a fresh checkout:

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000), choose **Start call** and enter the mock PIN **2468**. Try “Pause my gift,” then confirm in a separate turn. Open `/procurement` to try the supply desk with simulated suppliers.

Mock mode uses an in-memory PayPal and offline routing rules. A fresh checkout needs no environment file. If you already copied the guarded `.env.example`, set `DONOR_DURABILITY_ENABLED=false` for database-free mock use. Private configuration can enable other integrations; use a fresh checkout for the offline walkthrough.

```sh
npm test
npm run pilot:dry -- --mock
```

The default suite and mock dry run need no external services or keys. Hosted database tests are opt-in; skipped hosted tests do not establish acceptance. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Evidence and limits

- An actual [sandbox checkout](docs/results/guarded-checkout-2026-11-05.json) completed two captures totaling **$674.15 in test funds**, confirmed by authenticated PayPal reads.
- In that run, the price guard chose the cheaper deterministic plan over the $676.25 AI candidate. This demonstrates the guard and checkout flow; it does not establish AI-specific savings.
- The latest fresh purchase-drafting comparison failed its improvement gate. A historical routing comparison shows a narrower advantage. [Retained evaluations](docs/AI-VALUE-EVIDENCE-2026-11-05.md) include failed rounds and their limits.
- The [demo guide](docs/DEMO.md) distinguishes the recorded workflow from the separate checkout and earlier restart tests.

## Sandbox and guarded AI setup

Follow [SETUP.md](SETUP.md) for private credentials, database migrations, model spending allocations and sandbox configuration. Consult [AI status](docs/AI-STATUS.md) before enabling inference; stopped allocations remain stopped. The [production assessment](PRODUCTION.md) describes operational limits.

| Location | Purpose |
| --- | --- |
| `src/` | Server, routing, consent, provider integrations and receipts |
| `web/` | Donor, staff, procurement and demo interfaces |
| `scripts/` | Sandbox setup, checks and evaluation tools |
| `test/` | Offline and opt-in integration tests |
| `docs/` | Setup references, evaluation reports and retained evidence |

## License

MIT. See [LICENSE](LICENSE). Third-party assets retain their notices in `web/vendor/` and `web/fonts/`.
