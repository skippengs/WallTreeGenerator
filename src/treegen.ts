import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';
import { buildTube } from './tube';
import { bounds, clip, clipAll, type Plane } from './clip';

export interface TreeParams {
  // room / trunk (mm)
  roomHeight: number;
  trunkDiameter: number;
  /** Where the trunk forks, as a fraction of the room height. */
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
  gridOffsetX: number;
}

export const defaultParams: TreeParams = {
  roomHeight: 2500,
  trunkDiameter: 300,
  forkHeight: 0.5,
  protrusion: 0.5,
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

interface Branch {
  pts: THREE.Vector3[];
  r0: number;
  r1: number;
  length: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Centerline of a branch in the wall plane. It slides along the ceiling instead of passing through it. */
function growPath(
  p: TreeParams, rand: () => number, sx: number, sy: number, heading: number,
  length: number, r0: number, r1: number, curl: number, wobble: number,
): Branch {
  const step = Math.max(40, length / 24);
  const n = Math.max(3, Math.round(length / step));
  const pts: THREE.Vector3[] = [];
  let x = sx, y = sy, a = heading;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const r = lerp(r0, r1, Math.pow(s, 0.8));
    const ymax = p.roomHeight - r * (2 * p.protrusion - 1);
    y = Math.min(y, ymax);
    pts.push(new THREE.Vector3(x, y, 0));
    a = a * (1 - curl * 0.06) + (rand() - 0.5) * wobble;
    x += Math.sin(a) * (length / n);
    y += Math.cos(a) * (length / n);
    if (y > ymax) {
      a = (Math.sin(a) >= 0 ? 1 : -1) * Math.PI / 2; // run along the ceiling
    }
  }
  return { pts, r0, r1, length };
}

function headingAt(b: Branch, i: number): number {
  const a = b.pts[Math.max(0, i - 1)], c = b.pts[Math.min(b.pts.length - 1, i + 1)];
  return Math.atan2(c.x - a.x, c.y - a.y);
}

/** All tubes of the tree (each a closed triangle soup), not yet cut flat. */
export function buildShells(p: TreeParams): Float32Array[] {
  const rand = rng(p.seed);
  const noise = createNoise3D(rng(p.seed + 101));
  const protrusion = p.protrusion;
  const shells: Float32Array[] = [];
  const addTube = (b: Branch, flare = 0) => {
    const rad = (s: number) => {
      const base = lerp(b.r0, b.r1, Math.pow(s, 0.8));
      return flare ? base * (1 + flare * Math.exp((-s * b.length) / (b.r0 * 2.5))) : base;
    };
    shells.push(
      buildTube({
        pts: b.pts, radius: rad, protrusion, barkDepth: p.barkDepth, barkScale: p.barkScale,
        noise, noiseOffset: rand() * 100,
      }),
    );
  };

  // trunk
  const yFork = p.roomHeight * p.forkHeight;
  const r0 = p.trunkDiameter / 2;
  const rFork = r0 * 0.55;
  const trunkPts: THREE.Vector3[] = [];
  const nT = Math.max(4, Math.round(yFork / 250));
  for (let i = 0; i <= nT; i++) {
    const t = i / nT;
    trunkPts.push(new THREE.Vector3(Math.sin(t * 2.4 + p.seed) * r0 * 0.25 * t, -r0 + t * (yFork + r0), 0));
  }
  const trunk: Branch = { pts: trunkPts, r0, r1: rFork, length: yFork + r0 };
  addTube(trunk, 0.35);

  // main branches grow out of the top of the trunk
  const mains: Branch[] = [];
  const nM = Math.max(1, Math.round(p.mainBranches));
  const spread = THREE.MathUtils.degToRad(p.spreadAngle);
  for (let i = 0; i < nM; i++) {
    const side = nM === 1 ? 0 : (2 * (i + 0.5)) / nM - 1;
    const heading = spread * side + (rand() - 0.5) * 0.15;
    const f = 0.82 + 0.18 * rand();
    const start = trunkPts[Math.min(trunkPts.length - 1, Math.round(f * (trunkPts.length - 1)))];
    const len = p.mainLength * (0.85 + 0.3 * rand());
    const rb = rFork * (nM > 2 ? 0.92 : 1);
    const b = growPath(p, rand, start.x, start.y, heading, len, rb, rb * 0.35, p.curl, 0.25);
    mains.push(b);
    addTube(b);
  }

  // smaller branches
  let parents = mains;
  for (let g = 1; g <= p.generations; g++) {
    const next: Branch[] = [];
    const count = g === 1 ? p.subBranches : Math.max(1, p.subBranches - 1);
    for (const par of parents) {
      for (let k = 0; k < count; k++) {
        const f = 0.25 + 0.65 * ((k + 0.5) / count) + (rand() - 0.5) * 0.08;
        const idx = Math.min(par.pts.length - 1, Math.round(f * (par.pts.length - 1)));
        const at = par.pts[idx];
        const rPar = lerp(par.r0, par.r1, Math.pow(idx / (par.pts.length - 1), 0.8));
        const rb = rPar * 0.62;
        if (rb < 6) continue;
        const sideSign = k % 2 === 0 ? 1 : -1;
        const off = THREE.MathUtils.degToRad(28 + rand() * 25) * sideSign;
        const len = Math.max(150, par.length * (1 - f) * 0.9 * Math.pow(0.8, g - 1) + par.length * 0.12);
        const b = growPath(p, rand, at.x, at.y, headingAt(par, idx) + off, len, rb, Math.max(4, rb * 0.3), p.curl * 0.6, 0.35);
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
  ix: number;
  iy: number;
  /** Triangle soup in tree coordinates (mm). */
  tris: Float32Array;
}

/** Cut the finished tree into bed-sized tiles in the wall plane. */
export function splitIntoParts(shells: Float32Array[], p: TreeParams): Part[] {
  const tiles = new Map<string, Float32Array[]>();
  const add = (ix: number, iy: number, t: Float32Array) => {
    if (t.length === 0) return;
    const k = `${ix},${iy}`;
    tiles.set(k, [...(tiles.get(k) ?? []), t]);
  };
  const x0 = (ix: number) => p.gridOffsetX + ix * p.bedX;
  const y0 = (iy: number) => iy * p.bedY;
  for (const sh of shells) {
    const b = bounds(sh);
    const ixa = Math.floor((b[0] - p.gridOffsetX) / p.bedX), ixb = Math.floor((b[3] - p.gridOffsetX - 1e-6) / p.bedX);
    const iya = Math.floor(b[1] / p.bedY), iyb = Math.floor((b[4] - 1e-6) / p.bedY);
    for (let ix = ixa; ix <= ixb; ix++) {
      let col = sh;
      if (ixa !== ixb) {
        col = clip(col, { axis: 0, sign: -1, pos: x0(ix) });
        col = clip(col, { axis: 0, sign: 1, pos: x0(ix + 1) });
      }
      for (let iy = iya; iy <= iyb; iy++) {
        let t = col;
        if (iya !== iyb) {
          t = clip(t, { axis: 1, sign: -1, pos: y0(iy) });
          t = clip(t, { axis: 1, sign: 1, pos: y0(iy + 1) });
        }
        add(ix, iy, t);
      }
    }
  }
  return [...tiles.entries()].map(([k, list]) => {
    const [ix, iy] = k.split(',').map(Number);
    const n = list.reduce((s, a) => s + a.length, 0);
    const tris = new Float32Array(n);
    let o = 0;
    for (const a of list) {
      tris.set(a, o);
      o += a.length;
    }
    return { ix, iy, tris };
  });
}
