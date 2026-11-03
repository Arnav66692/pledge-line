import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// GLSL leaves smoothstep with edges high to low, and pow with a negative base, undefined. Metal returns NaN for both,
// and a NaN pixel shows as a black square. These checks read the room's shaders as text.
const src = fs.readFileSync(new URL('../web/scene.js', import.meta.url), 'utf8');

test('every smoothstep with number edges runs low to high', () => {
  const calls = [...src.matchAll(/smoothstep\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,/g)];
  assert.ok(calls.length > 10, `found ${calls.length}`);
  for (const [call, lo, hi] of calls) assert.ok(Number(lo) < Number(hi), call);
});

test('every pow base is clamped, a max, or a value that cannot go below 0', () => {
  // Names the shaders build from max(), clamp() or a length, so they are never negative.
  const safe = new Set(['s', 'nh', 'd * uFogDensity', 'dist * uFogDensity * 0.85']);
  const bases = [];
  for (const m of src.matchAll(/\bpow\(/g)) {
    let depth = 0;
    let i = m.index + 4;
    const start = i;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === ',' && depth === 0) break;
    }
    bases.push(src.slice(start, i).trim());
  }
  // JavaScript's Math.pow is not GLSL.
  const glsl = bases.filter((b) => !/^0\.\d+$/.test(b) && !/^1 - /.test(b) && b !== '0.955');
  assert.ok(glsl.length > 10, `found ${glsl.length}`);
  for (const b of glsl) assert.ok(/^(max|clamp)\(/.test(b) || safe.has(b), `pow base ${b}`);
});
