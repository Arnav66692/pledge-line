# The room

The room behind the donor page is Arnav's own, from his portfolio build (`portfolio-site-unseen`). It was modelled and
light-baked in Blender from code by `tools/room/build_room.py -- --variant left`, the arcade room: a back wall with a
high window, a left wall of three arches turned 14 degrees toward the camera, a right wall with two arches, a ledge and
one rock, all standing in water. Nothing here comes from unseen.co.

The files are copied unchanged from the portfolio's `public/room-left/` (built Oct 29, 2026). The bake is white plaster
with a crimson bounce, and `web/scene.js` re-colours it at run time into the pink plaster, lilac shade and peach sun
used here, so no re-bake was needed. The shader also hides the portfolio's column on the ledge, since the pearl here
floats beside the headline instead of resting on it.

| File | What it is | Bytes | sha256 |
|---|---|---|---|
| `room.glb` | The walls, ledge and rock, a glTF binary with positions, normals and the bake's uv set | 189776 | `5ad2cd879cad93799c54c5982c62929617104610b1eec980cb23363c2c7355b3` |
| `room-light.webp` | The walls' baked light, 2048 px square | 44652 | `cd696062b47c80af1278acf095a86437fa91dd22daa71814e8e7beae63e2465e` |
| `rocks-light.webp` | The rock's baked light, 512 px square | 19180 | `dae1c4df2503f980c2414b00403a0b35c77027243bcaa9709b82fbeb7d81ed90` |

The three files come to 253608 bytes. `test/server.test.js` checks each one against the sha256 above and that it
serves with its type and the page's policy. This README is notes for people and is not served.
