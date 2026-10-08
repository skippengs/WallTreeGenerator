import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';
import { buildTube } from './tube';
import { bounds, clip, clipAll, type Plane } from './clip';

export interface TreeParams {
  // room / trunk (mm)
  roomHeight: number;
  trunkDiameter: number;
  /** Only the trunk stays on the wall; all branches spread over the ceiling. */
  trunkOnly: boolean;
  /** Where the trunk forks when branches are on the wall, as a fraction of the room height. */
  forkHeight: number;
  /** Fraction of the tube diameter that stands out from the wall (0.5 = half round). */
  protrusion: number;
  // branches
  mainBranches: number;
  /** Outer main branches lean this far from vertical (0..90 degrees). */
  spreadAngle: number;
  mainLength: number;
  /** How strongly branches bend back towards vertical (0..1). */
  curl: number;
  subBranches: number;
  /** Generations of smaller branches below the main ones. */
  generations: number;
  // bark
  barkDepth: number;
  barkScale: number;
  seed: number;
  // printing (mm)
  bedX: number;
  bedY: number;
  /** Maximum print height of a part. */
  bedZ: number;
  /** Height of the zone under the ceiling that is printed lying on its ceiling face. */
  ceilingBand: number;
  gridOffsetX: number;
}

export const defaultParams: TreeParams = {
  roomHeight: 2500,
  trunkDiameter: 300,
  trunkOnly: true,
  forkHeight: 0.5,
  protrusion: 0.6,
  mainBranches: 4,
  spreadAngle: 50,
  mainLength: 1500,
  curl: 0.4,
  subBranches: 3,
  generations: 2,
  barkDepth: 8,
  barkScale: 16,
  seed: 7,
  bedX: 256,
  bedY: 256,
  bedZ: 256,
  ceilingBand: 250,
  gridOffsetX: 0,
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Mode = 'wall' | 'bend' | 'ceil';

interface Branch {
  pts: THREE.Vector3[];
  modes: Mode[];
  r0: number;
  r1: number;
  length: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Centerline of a branch. In 'wall' mode it climbs in the wall plane (heading = angle from vertical);
 * on reaching the ceiling it bends 90 degrees into the room and continues in 'ceil' mode
 * (heading = azimuth from straight into the room, towards +x).
 */
function grow(
  p: TreeParams, rand: () => number, start: THREE.Vector3, mode0: Mode, heading: number,
  length: number, r0: number, r1: number, curl: number, wobble: number,
): Branch {
  const H = p.roomHeight;
  const k = 2 * p.protrusion - 1;
  const step = clamp(length / 20, 40, 120);
  const pts: THREE.Vector3[] = [];
  const modes: Mode[] = [];
  const pos = start.clone();
  let mode: Mode = mode0;
  let a = heading;
  let travelled = 0;
  let bend: { d0: THREE.Vector3; d1: THREE.Vector3; i: number; m: number; len: number; psi: number } | null = null;

  while (travelled <= length + 1e-6) {
    const s = Math.min(1, travelled / length);
    const r = lerp(r0, r1, Math.pow(s, 0.8));
    const ymax = H - r * k;
    if (mode === 'wall' && !bend) pos.z = 0;
    pos.y = mode === 'wall' ? Math.min(pos.y, ymax) : ymax;
    if (bend) pos.y = Math.min(pos.y, ymax);
    pts.push(pos.clone());
    modes.push(bend ? 'bend' : mode);

    let dir: THREE.Vector3;
    let adv = step;
    if (bend) {
      const t = (bend.i + 1) / bend.m;
      dir = bend.d0.clone().lerp(bend.d1, t).normalize();
      adv = bend.len;
      if (++bend.i >= bend.m) {
        a = bend.psi;
        mode = 'ceil';
        bend = null;
      }
    } else if (mode === 'wall') {
      a = a * (1 - curl * 0.06) + (rand() - 0.5) * wobble;
      dir = new THREE.Vector3(Math.sin(a), Math.cos(a), 0);
      const rb = Math.max(2.5 * r, 120);
      if (pos.y + rb * Math.max(0, dir.y) * 0.9 >= ymax) {
        let psi = clamp(0.9 * a, -1.4, 1.4);
        if (Math.abs(psi) < 0.2) psi = (rand() < 0.5 ? -1 : 1) * (0.2 + rand() * 0.3);
        const d1 = new THREE.Vector3(Math.sin(psi), 0, Math.cos(psi));
        const m = 6;
        bend = { d0: dir.clone(), d1, i: 0, m, len: (rb * dir.angleTo(d1)) / m, psi };
      }
    } else {
      a = clamp(a + (rand() - 0.5) * wobble, -Math.PI / 2, Math.PI / 2);
      dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    }
    pos.addScaledVector(dir, adv);
    travelled += adv;
  }
  return { pts, modes, r0, r1, length };
}

/** Heading (wall: from vertical; ceiling: from straight into the room) of a branch at point i. */
function headingAt(b: Branch, i: number): number {
  const a = b.pts[Math.max(0, i - 1)], c = b.pts[Math.min(b.pts.length - 1, i + 1)];
  return b.modes[i] === 'ceil' ? Math.atan2(c.x - a.x, c.z - a.z) : Math.atan2(c.x - a.x, c.y - a.y);
}

/** All tubes of the tree (each a closed triangle soup), not yet cut flat. */
export function buildShells(p: TreeParams): Float32Array[] {
  const rand = rng(p.seed);
  const noise = createNoise3D(rng(p.seed + 101));
  const H = p.roomHeight;
  const k = 2 * p.protrusion - 1;
  const shells: Float32Array[] = [];
  const addTube = (b: Branch, flare = 0) => {
    const rad = (s: number) => {
      const base = lerp(b.r0, b.r1, Math.pow(s, 0.8));
      return flare ? base * (1 + flare * Math.exp((-s * b.length) / (b.r0 * 2.5))) : base;
    };
    shells.push(
      buildTube({
        pts: b.pts, radius: rad, protrusion: p.protrusion, ceilingY: H, barkDepth: p.barkDepth,
        barkScale: p.barkScale, noise, noiseOffset: rand() * 100,
      }),
    );
  };

  // trunk, on the wall
  const r0 = p.trunkDiameter / 2;
  const rFork = r0 * 0.55;
  const yTop = p.trunkOnly ? H - rFork * k : H * p.forkHeight;
  const trunkPts: THREE.Vector3[] = [];
  const nT = Math.max(4, Math.round(yTop / 250));
  for (let i = 0; i <= nT; i++) {
    const t = i / nT;
    trunkPts.push(new THREE.Vector3(Math.sin(t * 2.4 + p.seed) * r0 * 0.25 * t, -r0 + t * (yTop + r0), 0));
  }
  const trunk: Branch = { pts: trunkPts, modes: trunkPts.map(() => 'wall' as Mode), r0, r1: rFork, length: yTop + r0 };
  addTube(trunk, 0.35);

  // main branches grow out of the top of the trunk
  const mains: Branch[] = [];
  const nM = Math.max(1, Math.round(p.mainBranches));
  const spread = THREE.MathUtils.degToRad(p.spreadAngle);
  for (let i = 0; i < nM; i++) {
    const side = nM === 1 ? 0 : (2 * (i + 0.5)) / nM - 1;
    const heading = spread * side + (rand() - 0.5) * 0.15;
    const len = p.mainLength * (0.85 + 0.3 * rand());
    const rb = rFork * (nM > 2 ? 0.92 : 1);
    let b: Branch;
    if (p.trunkOnly) {
      const top = trunkPts[trunkPts.length - 1];
      b = grow(p, rand, new THREE.Vector3(top.x, H - rb * k, rb * 0.6), 'ceil', heading, len, rb, rb * 0.35, 0, 0.25);
    } else {
      const f = 0.82 + 0.18 * rand();
      const start = trunkPts[Math.min(trunkPts.length - 1, Math.round(f * (trunkPts.length - 1)))];
      b = grow(p, rand, new THREE.Vector3(start.x, start.y, 0), 'wall', heading, len, rb, rb * 0.35, p.curl, 0.25);
    }
    mains.push(b);
    addTube(b);
  }

  // smaller branches split off in the plane the parent is running in (wall or ceiling)
  let parents = mains;
  for (let g = 1; g <= p.generations; g++) {
    const next: Branch[] = [];
    const count = g === 1 ? p.subBranches : Math.max(1, p.subBranches - 1);
    for (const par of parents) {
      for (let j = 0; j < count; j++) {
        const f = 0.25 + 0.65 * ((j + 0.5) / count) + (rand() - 0.5) * 0.08;
        const idx = Math.min(par.pts.length - 1, Math.round(f * (par.pts.length - 1)));
        const mode = par.modes[idx];
        if (mode === 'bend') continue;
        const at = par.pts[idx];
        const rPar = lerp(par.r0, par.r1, Math.pow(idx / (par.pts.length - 1), 0.8));
        const rb = rPar * 0.62;
        if (rb < 6) continue;
        const sideSign = j % 2 === 0 ? 1 : -1;
        const off = THREE.MathUtils.degToRad(28 + rand() * 25) * sideSign;
        const len = Math.max(150, par.length * (1 - f) * 0.9 * Math.pow(0.8, g - 1) + par.length * 0.12);
        const h = headingAt(par, idx) + off;
        const b = grow(
          p, rand, at.clone(), mode, mode === 'ceil' ? clamp(h, -Math.PI / 2, Math.PI / 2) : h, len, rb,
          Math.max(4, rb * 0.3), p.curl * 0.6, 0.35,
        );
        next.push(b);
        addTube(b);
      }
    }
    parents = next;
  }
  return shells;
}

/** Flat back on the wall (z = 0), flat top on the ceiling, flat bottom on the floor. */
export function roomPlanes(p: TreeParams): Plane[] {
  return [
    { axis: 2, sign: -1, pos: 0 },
    { axis: 1, sign: 1, pos: p.roomHeight },
    { axis: 1, sign: -1, pos: 0 },
  ];
}

export function buildTree(p: TreeParams): Float32Array[] {
  const planes = roomPlanes(p);
  return buildShells(p).map((s) => clipAll(s, planes)).filter((s) => s.length > 0);
}

export interface Part {
  /** 'wall' parts are tiled in x/y and print on their flat back; 'ceiling' parts are tiled in x/z and print on their flat ceiling face. */
  zone: 'wall' | 'ceiling';
  i: number;
  j: number;
  /** Triangle soup in tree coordinates (mm). */
  tris: Float32Array;
}

function tile(
  shells: Float32Array[], zone: Part['zone'], au: 0 | 1 | 2, av: 0 | 1 | 2,
  offU: number, sizeU: number, sizeV: number,
): Part[] {
  const tiles = new Map<string, Float32Array[]>();
  const add = (i: number, j: number, t: Float32Array) => {
    if (t.length === 0) return;
    const key = `${i},${j}`;
    tiles.set(key, [...(tiles.get(key) ?? []), t]);
  };
  for (const sh of shells) {
    const b = bounds(sh);
    const ia = Math.floor((b[au] - offU) / sizeU), ib = Math.floor((b[au + 3] - offU - 1e-6) / sizeU);
    const ja = Math.floor(b[av] / sizeV), jb = Math.floor((b[av + 3] - 1e-6) / sizeV);
    for (let i = ia; i <= ib; i++) {
      let col = sh;
      if (ia !== ib) {
        col = clip(col, { axis: au, sign: -1, pos: offU + i * sizeU });
        col = clip(col, { axis: au, sign: 1, pos: offU + (i + 1) * sizeU });
      }
      for (let j = ja; j <= jb; j++) {
        let t = col;
        if (ja !== jb) {
          t = clip(t, { axis: av, sign: -1, pos: j * sizeV });
          t = clip(t, { axis: av, sign: 1, pos: (j + 1) * sizeV });
        }
        add(i, j, t);
      }
    }
  }
  return [...tiles.entries()].map(([key, list]) => {
    const [i, j] = key.split(',').map(Number);
    const tris = new Float32Array(list.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of list) {
      tris.set(a, o);
      o += a.length;
    }
    return { zone, i, j, tris };
  });
}

/**
 * Cut the finished tree into printable parts: everything below the ceiling band is tiled in the
 * wall plane, the band under the ceiling is tiled in the ceiling plane.
 */
export function splitIntoParts(shells: Float32Array[], p: TreeParams): Part[] {
  const yCut = p.roomHeight - p.ceilingBand;
  const wall: Float32Array[] = [];
  const ceil: Float32Array[] = [];
  for (const sh of shells) {
    const w = clip(sh, { axis: 1, sign: 1, pos: yCut });
    const c = clip(sh, { axis: 1, sign: -1, pos: yCut });
    if (w.length) wall.push(w);
    if (c.length) ceil.push(c);
  }
  return [
    ...tile(wall, 'wall', 0, 1, p.gridOffsetX, p.bedX, p.bedY),
    ...tile(ceil, 'ceiling', 0, 2, p.gridOffsetX, p.bedX, p.bedY),
  ];
}

export function partName(part: Part): string {
  return part.zone === 'wall' ? `tree_wall_x${part.i}_y${part.j}` : `tree_ceiling_x${part.i}_z${part.j}`;
}

/** Part moved to its own print position: flat face on the bed, origin at the tile corner. */
export function printOrientation(part: Part, p: TreeParams): Float32Array {
  const t = part.tris;
  const out = new Float32Array(t.length);
  const x0 = p.gridOffsetX + part.i * p.bedX;
  for (let n = 0; n < t.length; n += 3) {
    const x = t[n] - x0, y = t[n + 1], z = t[n + 2];
    if (part.zone === 'wall') {
      out[n] = x;
      out[n + 1] = y - part.j * p.bedY;
      out[n + 2] = z;
    } else {
      // turn the part over so its flat ceiling face lies on the bed (a proper rotation, no mirroring)
      out[n] = x;
      out[n + 1] = z - part.j * p.bedY;
      out[n + 2] = p.roomHeight - y;
    }
  }
  return out;
}
