// Sanity check: build the tree headless and verify the back is flat (nothing behind z = 0).
import * as THREE from 'three';
import { buildTree, defaultParams } from '../src/tree';

function stats(group: THREE.Group) {
  let minZ = Infinity;
  const edges = new Map<string, number>();
  const key = (v: THREE.Vector3) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
  let tris = 0;
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position;
    const idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    const v = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
    for (let i = 0; i < n; i += 3) {
      const ks = [0, 1, 2].map((k) => {
        const p = v(i + k);
        minZ = Math.min(minZ, p.z);
        return key(p);
      });
      tris++;
      for (let k = 0; k < 3; k++) {
        const a = ks[k], b = ks[(k + 1) % 3];
        const e = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
    }
  });
  const bad = [...edges.values()].filter((c) => c !== 2).length;
  return { tris, minZ, badEdges: bad };
}

let failed = false;
for (const angle of [0, 45, 90]) {
  const g = buildTree({ ...defaultParams, branchAngle: angle });
  const s = stats(g);
  const ok = s.minZ > -1e-3 && s.tris > 0;
  if (!ok) failed = true;
  console.log(`angle=${angle}`, s, ok ? 'OK' : 'FAIL');
}
process.exit(failed ? 1 : 0);
