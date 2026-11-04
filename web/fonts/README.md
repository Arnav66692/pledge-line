# Fonts

The page's policy is `default-src 'self'`, so the two faces are files served from here, never a font CDN at run time.
They stand in for the paid faces unseen.co uses (Neue Montreal and Saol Display). Both are under the SIL Open Font
License 1.1, and each license sits next to its files.

Fetched on Nov 2, 2026 from jsDelivr's copies of the fontsource npm packages, pinned to an exact version. Only the
latin subset is kept.

| File | Package and version | Source URL | sha256 |
|---|---|---|---|
| `instrument-serif-latin-400-normal.woff2` | `@fontsource/instrument-serif@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource/instrument-serif@5.3.0/files/instrument-serif-latin-400-normal.woff2 | `5eb09b5ac0e28b67c2f041c8ba6d244604ca0c0980d65912ab2d47fed84ddc31` |
| `instrument-serif-latin-400-italic.woff2` | `@fontsource/instrument-serif@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource/instrument-serif@5.3.0/files/instrument-serif-latin-400-italic.woff2 | `5a51946dfffa82972bc98745359c46761515641fda557c25116459a9f83da4a7` |
| `geist-latin-wght-normal.woff2` | `@fontsource-variable/geist@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.3.0/files/geist-latin-wght-normal.woff2 | `19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1` |
| `OFL-instrument-serif.txt` | `@fontsource/instrument-serif@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource/instrument-serif@5.3.0/LICENSE | `b6106a757902d2d412e09d94dc4a226fe3da80485208a98003969f1b8b6b1d74` |
| `OFL-geist.txt` | `@fontsource-variable/geist@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.3.0/LICENSE | `71609cbb5c78b5870d712eab73a31d76622635c6ed034ab5cee3b9ecbda8685f` |
| `jetbrains-mono-latin-400-normal.woff2` | `@fontsource/jetbrains-mono@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.3.0/files/jetbrains-mono-latin-400-normal.woff2 | `14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb` |
| `OFL-jetbrains-mono.txt` | `@fontsource/jetbrains-mono@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.3.0/LICENSE | `403581b69dac5cff4079205e01c6b467e56af449ecbd7247693ddb1baafa005b` |

Instrument Serif is by the Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif). Geist is
by the Geist Project Authors (https://github.com/vercel/geist-font). `test/server.test.js` checks each file against the
sha256 above and that it serves with its type and the page's policy.
