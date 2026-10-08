// Headless sanity check: flat back/ceiling/floor, closed shells, and clean tiling.
import { buildTree, splitIntoParts, defaultParams } from '../src/treegen';
import { bounds, clipStats } from '../src/clip';
import { volume } from '../src/tube';

function openEdges(tris: Float32Array) {
  const q = (i: number) => `${Math.round(tris[i] * 1000)},${Math.round(tris[i + 1] * 1000)},${Math.round(tris[i + 2] * 1000)}`;
  const e = new Map<string, number>();
  for (let i = 0; i < tris.length; i += 9) {
    const k = [q(i), q(i + 3), q(i + 6)];
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) continue;
    for (let j = 0; j < 3; j++) {
      const a = k[j], b = k[(j + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      e.set(key, (e.get(key) ?? 0) + 1);
    }
  }
  return [...e.values()].filter((c) => c !== 2).length;
}

import { buildShells } from '../src/treegen';
let failed = false;
const check = (name: string, ok: boolean, info: unknown) => {
  if (!ok) failed = true;
  console.log(ok ? 'OK  ' : 'FAIL', name, info);
};

const p = { ...defaultParams };
let t0 = Date.now();
const raw = buildShells(p);
console.log('raw shells open edges:', raw.map(openEdges).join(','), 'volumes>0:', raw.every((s) => volume(s) > 0));
const shells = buildTree(p);
const tris = shells.reduce((s, a) => s + a.length / 9, 0);
check('built', shells.length > 5, `${shells.length} shells, ${tris} triangles, ${Date.now() - t0} ms`);
const b = shells.map(bounds).reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2]), Math.max(a[3], c[3]), Math.max(a[4], c[4]), Math.max(a[5], c[5])]);
check('flat back z>=0', b[2] > -1e-3, b[2]);
check('ceiling y<=H', b[4] <= p.roomHeight + 1e-3, b[4]);
check('floor y>=0', b[1] > -1e-3, b[1]);
check('positive volume', shells.every((s) => volume(s) > 0), shells.map((s) => Math.round(volume(s) / 1e6)).slice(0, 5));
check('shells closed', shells.every((s) => openEdges(s) === 0), shells.map(openEdges).filter((n) => n).length + ' open');

t0 = Date.now();
const parts = splitIntoParts(shells, p);
check('parts', parts.length > 3, `${parts.length} parts, ${Date.now() - t0} ms`);
check('parts closed', parts.every((q) => openEdges(q.tris) === 0), parts.filter((q) => openEdges(q.tris)).length + ' open');
check('parts fit bed', parts.every((q) => {
  const pb = bounds(q.tris);
  return pb[3] - pb[0] <= p.bedX + 1e-3 && pb[4] - pb[1] <= p.bedY + 1e-3;
}), '');
console.log('holes dropped:', clipStats.holes, 'stuck:', clipStats.stuck);
process.exit(failed ? 1 : 0);
