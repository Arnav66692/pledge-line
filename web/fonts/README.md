# Fonts

The page's policy is `default-src 'self'`, so every face is a file served from here, never a font CDN at run time. All
are under the SIL Open Font License 1.1, and each license sits next to its files.

The site's look follows typesafe.ai. Hanken Grotesk, VT323 and JetBrains Mono stand in for its paid faces (Die Grotesk
and LisaTerminal) and its mono. They were fetched on Nov 8, 2026 with `npm pack` from the npm registry, pinned to an
exact version, and only the latin subset is kept. Instrument Serif and Geist are the earlier stand-ins, fetched on
Nov 2, 2026 from jsDelivr's copies of the same fontsource packages. The demo and supply desk stylesheets still name them.

| File | Package and version | Source URL | sha256 |
|---|---|---|---|
| `hanken-grotesk-latin-wght-normal.woff2` | `@fontsource-variable/hanken-grotesk@5.3.0` | https://registry.npmjs.org/@fontsource-variable/hanken-grotesk/-/hanken-grotesk-5.3.0.tgz (files/hanken-grotesk-latin-wght-normal.woff2) | `e9201eddf1d41d0b62253295d869ce3cf65768f7102b797f02c7f8c876b4a9d5` |
| `vt323-latin-400-normal.woff2` | `@fontsource/vt323@5.3.0` | https://registry.npmjs.org/@fontsource/vt323/-/vt323-5.3.0.tgz (files/vt323-latin-400-normal.woff2) | `8ddbebcc1048154132e1d78eb9b1f7850bca1b7d857035ccf1cb4318ebc615b6` |
| `jetbrains-mono-latin-300-normal.woff2` | `@fontsource/jetbrains-mono@5.3.0` | https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-5.3.0.tgz (files/jetbrains-mono-latin-300-normal.woff2) | `722972afda59a9739c5837279d0cc636d179240b3ec9d052b8ef147681874e61` |
| `jetbrains-mono-latin-400-normal.woff2` | `@fontsource/jetbrains-mono@5.3.0` | https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-5.3.0.tgz (files/jetbrains-mono-latin-400-normal.woff2) | `14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb` |
| `OFL-hanken-grotesk.txt` | `@fontsource-variable/hanken-grotesk@5.3.0` | https://registry.npmjs.org/@fontsource-variable/hanken-grotesk/-/hanken-grotesk-5.3.0.tgz (LICENSE) | `f45f60ca871850c58d8dc9c973bd6fcad40c137e9d037172b961e8ca68c87ef7` |
| `OFL-vt323.txt` | `@fontsource/vt323@5.3.0` | https://registry.npmjs.org/@fontsource/vt323/-/vt323-5.3.0.tgz (LICENSE) | `27d9af34210253e7ca1251fbace86c6f65b40031d6ce1a75493a1b2093631298` |
| `OFL-jetbrains-mono.txt` | `@fontsource/jetbrains-mono@5.3.0` | https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-5.3.0.tgz (LICENSE) | `403581b69dac5cff4079205e01c6b467e56af449ecbd7247693ddb1baafa005b` |
| `instrument-serif-latin-400-normal.woff2` | `@fontsource/instrument-serif@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource/instrument-serif@5.3.0/files/instrument-serif-latin-400-normal.woff2 | `5eb09b5ac0e28b67c2f041c8ba6d244604ca0c0980d65912ab2d47fed84ddc31` |
| `instrument-serif-latin-400-italic.woff2` | `@fontsource/instrument-serif@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource/instrument-serif@5.3.0/files/instrument-serif-latin-400-italic.woff2 | `5a51946dfffa82972bc98745359c46761515641fda557c25116459a9f83da4a7` |
| `geist-latin-wght-normal.woff2` | `@fontsource-variable/geist@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.3.0/files/geist-latin-wght-normal.woff2 | `19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1` |
| `OFL-instrument-serif.txt` | `@fontsource/instrument-serif@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource/instrument-serif@5.3.0/LICENSE | `b6106a757902d2d412e09d94dc4a226fe3da80485208a98003969f1b8b6b1d74` |
| `OFL-geist.txt` | `@fontsource-variable/geist@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.3.0/LICENSE | `71609cbb5c78b5870d712eab73a31d76622635c6ed034ab5cee3b9ecbda8685f` |

Hanken Grotesk is by the Hanken Grotesk Project Authors, VT323 by Peter Hull, and JetBrains Mono by JetBrains.
Instrument Serif is by the Instrument Serif Project Authors and Geist by the Geist Project Authors.
`test/server.test.js` checks each file against the sha256 above and that it serves with its type and the page's policy.
