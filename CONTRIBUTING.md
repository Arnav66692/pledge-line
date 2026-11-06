# Contributing

Start with the [project overview](README.md), [specification](SPEC.md) and [documentation index](docs/README.md).

## Local development

Use Node.js 22.12 or newer. From a fresh checkout:

```sh
npm ci
npm test
npm run pilot:dry -- --mock
npm run dev
```

The default tests and mock dry run need no provider credentials. Keep a clean environment for offline work. If using an existing guarded environment, disable donor durability for the database-free walkthrough as described in the README.

## Changes

- Describe the affected workflow and how to reproduce the change.
- Add regression coverage for behavior changes, especially consent, amounts, provider errors, payment identities and receipts.
- Use fictional donors and synthetic fixtures. Keep credentials, personal data, private environment files and runtime ledgers out of commits.
- Use mock provider behavior for routine development. Sandbox writes, hosted integration tests and paid inference need separate configuration and authorization; see [setup](SETUP.md).
- Keep failed evaluation rounds and report what a result establishes. A mock run, hosted-only skip or prepared draft is not a successful provider transaction.

When changing speech templates, follow the vocabulary and history requirements in the [project reference](docs/PROJECT_GUIDE.md). Do not regenerate history or evaluation artifacts as an incidental cleanup.

Include the commands you ran and any skipped integration checks in the pull request. Do not claim live-money readiness or independent supplier participation from sandbox evidence.
