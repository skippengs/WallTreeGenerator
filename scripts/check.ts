// Headless sanity check: flat back/ceiling/floor, closed shells, and clean tiling.
import { buildTree, splitIntoParts, printOrientation, defaultParams, type TreeParams } from '../src/treegen';
import { bounds, clipStats } from '../src/clip';
import { volume } from '../src/tube';

function openEdges(tris: Float32Array) {
  const q = (i: number) => `${Math.round(tris[i] * 20)},${Math.round(tris[i + 1] * 20)},${Math.round(tris[i + 2] * 20)}`;
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

async function run(label: string, p: TreeParams) {
  console.log('---', label);
  let t0 = Date.now();
  const shells = await buildTree(p);
  const tris = shells.reduce((s, a) => s + a.length / 9, 0);
  check('built', shells.length > 5, `${shells.length} shells, ${tris} triangles, ${Date.now() - t0} ms`);
  const b = shells.map(bounds).reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2]), Math.max(a[3], c[3]), Math.max(a[4], c[4]), Math.max(a[5], c[5])]);
  check('flat back z>=0', b[2] > -0.01, b[2]);
  check('ceiling y<=H', b[4] <= p.roomHeight + 0.01, b[4]);
  check('floor y>=0', b[1] > -0.01, b[1]);
  check('reaches into room', p.mainBranches === 0 || b[5] > 300, `max depth ${Math.round(b[5])} mm`);
  check('positive volume', shells.every((s) => volume(s) > 0), '');
  check('shells closed (<=24 stray edges each)', shells.every((s) => openEdges(s) <= 24), shells.map(openEdges).filter((n) => n).length + ' open');
  t0 = Date.now();
  const parts = await splitIntoParts(shells, p);
  check('parts', parts.length > 3, `${parts.filter((q) => q.zone === 'wall').length} wall + ${parts.filter((q) => q.zone === 'ceiling').length} ceiling, ${Date.now() - t0} ms`);
  // overlapping solids (and the pieces around a carved hollow) share faces inside one part, so closure is
  // judged on each solid cut up on its own
  let worst = 0;
  for (const s of shells) {
    for (const q of await splitIntoParts([s], p)) worst = Math.max(worst, openEdges(q.tris));
  }
  check('parts closed (<=24 stray edges each)', worst <= 24, `worst ${worst} stray edges`);
  check('parts fit printer', parts.every((q) => {
    const pb = bounds(printOrientation(q, p));
    return pb[0] > -1e-3 && pb[1] > -0.01 && pb[2] > -0.01 && pb[3] <= p.bedX + 0.01 && pb[4] <= p.bedY + 0.01 && pb[5] <= p.bedZ + 0.01;
  }), (() => { const m = [0, 0, 0]; for (const q of parts) { const pb = bounds(printOrientation(q, p)); m[0] = Math.max(m[0], pb[3]); m[1] = Math.max(m[1], pb[4]); m[2] = Math.max(m[2], pb[5]); } return `max extents ${m.map((v) => v.toFixed(0)).join(' x ')} mm`; })());
}
await run('trunk only on wall (all features)', { ...defaultParams });
await run('branches on wall too', { ...defaultParams, trunkOnly: false });
{
  // the hollow and the windows must really remove material from the trunk
  const plain = { ...defaultParams, cave: false, windows: 0, stubs: 0, rootLumps: 0, mainBranches: 1, generations: 0, subBranches: 0 };
  const carved = { ...plain, cave: true, windows: 4 };
  const vol = async (q: TreeParams) => (await buildTree(q)).reduce((s, a) => s + volume(a), 0);
  const [v0, v1] = [await vol(plain), await vol(carved)];
  check('hollow + windows remove material', v1 < v0 - 5e5, `${(v0 / 1e6).toFixed(1)} -> ${(v1 / 1e6).toFixed(1)} dm3`);
}
console.log('holes dropped:', clipStats.holes, 'stuck:', clipStats.stuck);
process.exit(failed ? 1 : 0);
