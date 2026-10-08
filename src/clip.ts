/**
 * Plane clipping of closed triangle soups, with capping: the cut is closed with flat faces,
 * so the result is again a closed solid.
 * An axis plane keeps the side where sign * (p[axis] - pos) <= 0; a general plane keeps n . p <= d.
 */
export interface AxisPlane {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  pos: number;
}
export interface GeneralPlane {
  n: [number, number, number];
  d: number;
}
export type Plane = AxisPlane | GeneralPlane;

/** The same plane facing the other way (keeps the other side). */
export function flipPlane(pl: GeneralPlane): GeneralPlane {
  return { n: [-pl.n[0], -pl.n[1], -pl.n[2]], d: -pl.d };
}

const fr = Math.fround;
const key = (x: number, y: number, z: number) =>
  `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;

export const clipStats = { holes: 0, stuck: 0 };

export function bounds(tris: Float32Array): [number, number, number, number, number, number] {
  const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = tris[i + k];
      if (v < b[k]) b[k] = v;
      if (v > b[k + 3]) b[k + 3] = v;
    }
  }
  return b;
}

/** Point on edge a-b where the plane cuts it. Endpoints are ordered so both neighbours get identical results. */
function cut(a: number[], b: number[], n: number[], d: number, exactAxis: number): number[] {
  if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) {
    const t = a;
    a = b;
    b = t;
  }
  const da = a[0] * n[0] + a[1] * n[1] + a[2] * n[2] - d;
  const db = b[0] * n[0] + b[1] * n[1] + b[2] * n[2] - d;
  const t = da / (da - db);
  const p = [fr(a[0] + (b[0] - a[0]) * t), fr(a[1] + (b[1] - a[1]) * t), fr(a[2] + (b[2] - a[2]) * t)];
  if (exactAxis >= 0) p[exactAxis] = fr(d / n[exactAxis]);
  return p;
}

/**
 * Planes are nudged by three microns so no mesh vertex lies exactly on them (tubes have rings
 * that sit exactly on the wall plane, which would make the cut run along mesh edges). The nudge
 * goes the same way in space for a plane and its flipped twin, so the two halves of a cut still meet.
 */
const NUDGE = 3.1e-3;

export function clip(tris: Float32Array, pl0: Plane): Float32Array {
  let n: [number, number, number];
  let d: number;
  if ('n' in pl0) {
    n = pl0.n;
    d = pl0.d;
  } else {
    n = [0, 0, 0];
    n[pl0.axis] = pl0.sign;
    d = pl0.sign * pl0.pos;
  }
  const first = n[0] !== 0 ? n[0] : n[1] !== 0 ? n[1] : n[2];
  d += first > 0 ? NUDGE : -NUDGE;
  let axis: 0 | 1 | 2 = 0;
  if (Math.abs(n[1]) > Math.abs(n[axis])) axis = 1;
  if (Math.abs(n[2]) > Math.abs(n[axis])) axis = 2;
  const exactAxis = Math.abs(n[axis]) === 1 ? axis : -1;
  const sign = Math.sign(n[axis]);
  const out: number[] = [];
  const seg: number[][][] = []; // directed boundary edges lying on the plane
  const a1 = ((axis + 1) % 3) as 0 | 1 | 2;
  const a2 = ((axis + 2) % 3) as 0 | 1 | 2;

  for (let i = 0; i < tris.length; i += 9) {
    const v = [
      [tris[i], tris[i + 1], tris[i + 2]],
      [tris[i + 3], tris[i + 4], tris[i + 5]],
      [tris[i + 6], tris[i + 7], tris[i + 8]],
    ];
    const ins = v.map((p) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2] - d <= 0);
    if (ins[0] && ins[1] && ins[2]) {
      for (const p of v) out.push(p[0], p[1], p[2]);
      continue;
    }
    if (!ins[0] && !ins[1] && !ins[2]) continue;

    const poly: number[][] = [];
    let enter: number[] | null = null;
    let exit: number[] | null = null;
    for (let k = 0; k < 3; k++) {
      const a = v[k];
      const b = v[(k + 1) % 3];
      if (ins[k]) poly.push(a);
      if (ins[k] !== ins[(k + 1) % 3]) {
        const x = cut(a, b, n, d, exactAxis);
        poly.push(x);
        if (ins[k]) exit = x;
        else enter = x;
      }
    }
    for (let k = 1; k + 1 < poly.length; k++) {
      const p = poly[0], q = poly[k], r = poly[k + 1];
      const kp = key(p[0], p[1], p[2]), kq = key(q[0], q[1], q[2]), kr = key(r[0], r[1], r[2]);
      if (kp === kq || kq === kr || kp === kr) continue; // collapsed
      out.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
    }
    if (enter && exit && key(enter[0], enter[1], enter[2]) !== key(exit[0], exit[1], exit[2])) seg.push([enter, exit]);
  }

  // stitch boundary edges into loops
  const byStart = new Map<string, number[]>();
  seg.forEach((s, i) => {
    const k = key(s[0][0], s[0][1], s[0][2]);
    const l = byStart.get(k);
    if (l) l.push(i);
    else byStart.set(k, [i]);
  });
  const TOL = 0.004; // mm; chain ends that miss by a few microns still join up
  const cellOf = (x: number, y: number, z: number): [number, number, number] =>
    [Math.floor(x / TOL), Math.floor(y / TOL), Math.floor(z / TOL)];
  const cells = new Map<string, number[]>();
  seg.forEach((sg, idx) => {
    const c = cellOf(sg[0][0], sg[0][1], sg[0][2]);
    const ck = c.join(',');
    const l = cells.get(ck);
    if (l) l.push(idx);
    else cells.set(ck, [idx]);
  });
  const near = (e: number[], used: Uint8Array): number => {
    const c = cellOf(e[0], e[1], e[2]);
    let best = -1;
    let bd = TOL;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of cells.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) {
            if (used[j]) continue;
            const d = Math.hypot(seg[j][0][0] - e[0], seg[j][0][1] - e[1], seg[j][0][2] - e[2]);
            if (d < bd) {
              bd = d;
              best = j;
            }
          }
        }
    return best;
  };
  const used = new Uint8Array(seg.length);
  const loops: number[][][] = [];
  for (let i = 0; i < seg.length; i++) {
    if (used[i]) continue;
    // walk the boundary; whenever it returns to a vertex it has already visited, that part is a closed loop
    const stack: number[][] = [];
    const keys: string[] = [];
    const where = new Map<string, number>();
    let cur = i;
    let lastEnd = '';
    let lastPt: number[] = seg[i][0];
    while (cur >= 0 && !used[cur]) {
      used[cur] = 1;
      const sp = seg[cur][0];
      const sk = key(sp[0], sp[1], sp[2]);
      const at = where.get(sk);
      if (at !== undefined) {
        const sub = stack.splice(at);
        keys.splice(at).forEach((k) => where.delete(k));
        if (sub.length >= 3) loops.push(sub);
      }
      where.set(sk, stack.length);
      stack.push(sp);
      keys.push(sk);
      lastPt = seg[cur][1];
      lastEnd = key(lastPt[0], lastPt[1], lastPt[2]);
      cur = (byStart.get(lastEnd) ?? []).find((j) => !used[j]) ?? -1;
      if (cur < 0 && !where.has(lastEnd)) cur = near(lastPt, used);
    }
    let at = where.get(lastEnd);
    if (at === undefined) {
      const first = stack.findIndex((q) => Math.hypot(q[0] - lastPt[0], q[1] - lastPt[1], q[2] - lastPt[2]) < TOL);
      if (first >= 0) at = first;
    }
    // A chain that does not return to its start (a stray gap in the mesh) is closed with a straight edge:
    // a small error is better than losing the whole cap.
    const sub = stack.splice(at ?? 0);
    if (sub.length >= 3) loops.push(sub);
  }
  if (loops.length === 0) return Float32Array.from(out);

  // cap: classify loops into outlines and holes, then triangulate
  const area2 = (l: number[][]) => {
    let s = 0;
    for (let i = 0; i < l.length; i++) {
      const p = l[i], q = l[(i + 1) % l.length];
      s += p[a1] * q[a2] - q[a1] * p[a2];
    }
    return s;
  };
  const areas = loops.map(area2);
  let big = 0;
  areas.forEach((a, i) => {
    if (Math.abs(a) > Math.abs(areas[big])) big = i;
  });
  const outerSign = Math.sign(areas[big]);
  const outers: number[] = [];
  const holes: number[] = [];
  areas.forEach((a, i) => {
    if (Math.abs(a) < 1e-9) return;
    (Math.sign(a) === outerSign ? outers : holes).push(i);
  });
  const inside = (pt: number[], l: number[][]) => {
    let c = false;
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      const yi = l[i][a2], yj = l[j][a2];
      if (yi > pt[a2] !== yj > pt[a2] && pt[a1] < ((l[j][a1] - l[i][a1]) * (pt[a2] - yi)) / (yj - yi) + l[i][a1]) c = !c;
    }
    return c;
  };
  const holesOf = new Map<number, number[][][]>();
  for (const h of holes) {
    let best = -1;
    for (const o of outers) {
      if (inside(loops[h][0], loops[o]) && (best < 0 || Math.abs(areas[o]) < Math.abs(areas[best]))) best = o;
    }
    if (best >= 0) holesOf.set(best, [...(holesOf.get(best) ?? []), loops[h]]);
  }
  for (const o of outers) {
    const flip = Math.sign(areas[o]) < 0; // make it counter-clockwise in (a1, a2)
    const orient = (l: number[][]) => (flip ? [...l].reverse() : l);
    let pts = orient(loops[o]);
    // join each hole to the outline with a zero-width bridge
    for (const hole of holesOf.get(o) ?? []) {
      const hp = orient(hole);
      let bo = 0, bh = 0, bd = Infinity;
      pts.forEach((p, i) =>
        hp.forEach((q, j) => {
          const d = (p[a1] - q[a1]) ** 2 + (p[a2] - q[a2]) ** 2;
          if (d < bd) { bd = d; bo = i; bh = j; }
        }));
      const rot = [...hp.slice(bh), ...hp.slice(0, bh), hp[bh]];
      pts = [...pts.slice(0, bo + 1), ...rot, pts[bo], ...pts.slice(bo + 1)];
    }
    const flat = pts.map((p) => [p[a1], p[a2]] as [number, number]);
    const seen = new Map<string, number[]>();
    for (const [i, j, k] of earClip(flat)) {
      // a triangle and its mirror image on the same corners cancel out (zero-thickness fin)
      const kk = [i, j, k].map((n) => key(pts[n][0], pts[n][1], pts[n][2])).sort().join('|');
      if (seen.has(kk)) {
        seen.delete(kk);
        continue;
      }
      // (a1, a2, axis) is right-handed: counter-clockwise faces +axis, the removed side when sign > 0
      seen.set(kk, sign > 0 ? [i, j, k] : [i, k, j]);
    }
    for (const t of seen.values()) for (const n of t) out.push(pts[n][0], pts[n][1], pts[n][2]);
  }
  clipStats.holes += holes.length;
  return Float32Array.from(out);
}

export function clipAll(tris: Float32Array, planes: Plane[]): Float32Array {
  let t = tris;
  for (const p of planes) {
    if (t.length === 0) break;
    t = clip(t, p);
  }
  return t;
}

/**
 * Ear clipping that keeps every input vertex (collinear ones included), so cap edges
 * match the neighbouring faces exactly. Input must be counter-clockwise.
 */
function earClip(p: [number, number][]): [number, number, number][] {
  const n = p.length;
  const prev = Array.from({ length: n }, (_, i) => (i + n - 1) % n);
  const next = Array.from({ length: n }, (_, i) => (i + 1) % n);
  const cr = (a: number, b: number, c: number) =>
    (p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0]);
  const tris: [number, number, number][] = [];
  let left = n;
  let i = 0;
  let sinceCut = 0;
  let relaxed = false;
  while (left > 3) {
    const a = prev[i], b = i, c = next[i];
    let ear = false;
    const area = cr(a, b, c);
    if (area > 1e-12 || (relaxed && area >= -1e-12)) {
      ear = true;
      if (area > 1e-12) {
        for (let j = next[c]; j !== a; j = next[j]) {
          if (cr(a, b, j) >= 0 && cr(b, c, j) >= 0 && cr(c, a, j) >= 0 &&
              !(p[j][0] === p[a][0] && p[j][1] === p[a][1]) && !(p[j][0] === p[b][0] && p[j][1] === p[b][1]) &&
              !(p[j][0] === p[c][0] && p[j][1] === p[c][1])) {
            ear = false;
            break;
          }
        }
      }
    }
    if (ear) {
      tris.push([a, b, c]);
      next[a] = c;
      prev[c] = a;
      left--;
      i = c;
      sinceCut = 0;
      relaxed = false;
    } else {
      i = next[i];
      if (++sinceCut > left) {
        if (relaxed) {
          // not a simple polygon (self-touching section): fan the rest so the cap stays closed
          clipStats.stuck++;
          const rest: number[] = [i];
          for (let j = next[i]; j !== i; j = next[j]) rest.push(j);
          for (let q = 1; q + 1 < rest.length; q++) tris.push([rest[0], rest[q], rest[q + 1]]);
          return tris;
        }
        relaxed = true;
        sinceCut = 0;
      }
    }
  }
  if (left === 3) {
    const a = i, b = next[a], c = next[b];
    tris.push([a, b, c]);
  }
  return tris;
}
