// Headless sanity check: flat back/ceiling/floor, closed shells, and clean tiling.
import { buildTree, splitIntoParts, printOrientation, defaultParams, type TreeParams } from '../src/treegen';
import { bounds, clipStats } from '../src/clip';
import { volume } from '../src/tube';

function openEdges(tris: Float32Array) {
  const q = (i: number) => `${Math.round(tris[i] * 200)},${Math.round(tris[i + 1] * 200)},${Math.round(tris[i + 2] * 200)}`;
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

let failed = false;
const check = (name: string, ok: boolean, info: unknown) => {
  if (!ok) failed = true;
  console.log(ok ? 'OK  ' : 'FAIL', name, info);
};

function run(label: string, p: TreeParams) {
  console.log('---', label);
  let t0 = Date.now();
  const shells = buildTree(p);
  const tris = shells.reduce((s, a) => s + a.length / 9, 0);
  check('built', shells.length > 5, `${shells.length} shells, ${tris} triangles, ${Date.now() - t0} ms`);
  const b = shells.map(bounds).reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2]), Math.max(a[3], c[3]), Math.max(a[4], c[4]), Math.max(a[5], c[5])]);
  check('flat back z>=0', b[2] > -0.01, b[2]);
  check('ceiling y<=H', b[4] <= p.roomHeight + 0.01, b[4]);
  check('floor y>=0', b[1] > -0.01, b[1]);
  check('reaches into room', p.mainBranches === 0 || b[5] > 300, `max depth ${Math.round(b[5])} mm`);
  check('positive volume', shells.every((s) => volume(s) > 0), '');
  check('shells closed (<=8 stray edges)', shells.every((s) => openEdges(s) <= 8), shells.map(openEdges).filter((n) => n).length + ' open');
  t0 = Date.now();
  const parts = splitIntoParts(shells, p);
  check('parts', parts.length > 3, `${parts.filter((q) => q.zone === 'wall').length} wall + ${parts.filter((q) => q.zone === 'ceiling').length} ceiling, ${Date.now() - t0} ms`);
  check('parts closed (<=8 stray edges)', parts.every((q) => openEdges(q.tris) <= 8), `${parts.filter((q) => openEdges(q.tris)).length} parts with stray edges, worst ${Math.max(...parts.map((q) => openEdges(q.tris)))}`);
  check('parts fit printer', parts.every((q) => {
    const pb = bounds(printOrientation(q, p));
    return pb[0] > -1e-3 && pb[1] > -0.01 && pb[2] > -0.01 && pb[3] <= p.bedX + 0.01 && pb[4] <= p.bedY + 0.01 && pb[5] <= p.bedZ + 0.01;
  }), (() => { const m = [0, 0, 0]; for (const q of parts) { const pb = bounds(printOrientation(q, p)); m[0] = Math.max(m[0], pb[3]); m[1] = Math.max(m[1], pb[4]); m[2] = Math.max(m[2], pb[5]); } return `max extents ${m.map((v) => v.toFixed(0)).join(' x ')} mm`; })());
}
run('trunk only on wall', { ...defaultParams });
run('branches on wall too', { ...defaultParams, trunkOnly: false });
console.log('holes dropped:', clipStats.holes, 'stuck:', clipStats.stuck);
process.exit(failed ? 1 : 0);
