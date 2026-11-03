# Vendored files

The staff view at `/staff` draws its table with AG Grid Community. The line serves these files itself, so the page loads nothing from a CDN at run time and the Content-Security-Policy stays self only.

- Package: `ag-grid-community`, version 32.3.3.
- License: MIT, copyright (c) 2015-2024 AG GRID LTD. MIT asks for the notice to travel with every copy, and the minified files carry none, so the full notice sits next to them in `LICENSE-ag-grid-community.txt`. It is copied byte for byte from https://cdn.jsdelivr.net/npm/ag-grid-community@32.3.3/LICENSE.txt, sha256 `977e2b6dfa502036ff3ffb879e9b0a4cc9b0f3bedf1e67b3f356942deac6c8fe`, and the staff page footer links to it.
- Downloaded Nov 2, 2026 from jsDelivr. The styles live at the package root in this version, not under `dist/`, so `dist/styles/...` is a 404.

| File | Source | sha256 |
|---|---|---|
| `ag-grid-community.min.js` | https://cdn.jsdelivr.net/npm/ag-grid-community@32.3.3/dist/ag-grid-community.min.js | `9454efe8fb5be3348b4d273ffc87f9079c1eed9a46141b25d3be450cf87d2d45` |
| `ag-grid.css` | https://cdn.jsdelivr.net/npm/ag-grid-community@32.3.3/styles/ag-grid.css | `c623f89cee588e33da1ab100b9c8cfe21c98340a6c22ee492908c4aa7da0f9f5` |
| `ag-theme-quartz.css` | https://cdn.jsdelivr.net/npm/ag-grid-community@32.3.3/styles/ag-theme-quartz.css | `836a7fad16bdea17e3ffd9dbf473d83add52ddad7e80317b4bdd46e00d841002` |
| `ag-grid-quartz-icons.woff2` | the `agGridQuartz` icon font inside `ag-theme-quartz.css`, decoded from its base64 `data:` URL | `d934d8604253b6f72cd7a991371e10371ce8ee1bd96fdefbc6396a30f3a56a2d` |

None of the three downloaded files is edited. The icon font is taken out because the policy has no font rule, so fonts fall under `default-src 'self'` and a `data:` font is refused. `web/staff.css` declares the same font family from the file, and the later rule wins.

Checked in Chrome on Nov 2 under the line's policy, at 1280 px and 375 px. The grid renders, sorts, filters and selects, and the icon font loads from the file. The console still shows three kinds of refusal, all expected.

- `ag-grid-community.min.js` tries to add its own styles as `<style>` elements, which `style-src 'self'` refuses. That is harmless, since the page links the same two stylesheets itself.
- AG Grid writes each new row's position into a `style` attribute, which the policy also refuses, so every row would sit at the top. `web/staff.js` places each row from AG Grid's own `rowTop` through the style object, which the policy allows. See `placeRows` there.
- The browser still tries Quartz's own `data:` font once and is refused. The file version is the one it uses.

AG Grid has published a build without the injected styles, named noStyle, in some versions. It might drop the first kind. It was not checked or downloaded, since only the files above were named.

To check a file, run `shasum -a 256 web/vendor/*` and compare with the table.
