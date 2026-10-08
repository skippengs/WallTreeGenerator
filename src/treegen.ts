import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';
import { buildTube } from './tube';
import { bounds, clip, clipAll, flipPlane, type GeneralPlane, type Plane } from './clip';

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
  /** Lumpy swellings at the foot of the trunk (0 = none). */
  rootLumps: number;
  // branches
  mainBranches: number;
  /** Outer main branches lean this far from vertical (0..90 degrees). */
  spreadAngle: number;
  mainLength: number;
  /** Height of the sloping crotch where the branches leave the trunk (trunk-only mode). */
  crotch: number;
  /** How much the trunk widens towards the crotch. */
  topFlare: number;
  /** How strongly branches bend back towards vertical (0..1). */
  curl: number;
  subBranches: number;
  /** Generations of smaller branches below the main ones. */
  generations: number;
  // old sawn-off branches
  stubs: number;
  stubLength: number;
  stubThickness: number;
  // hollow at the foot of the trunk
  cave: boolean;
  caveWidth: number;
  caveHeight: number;
  /** How much wider the chamber is than the opening. */
  caveWiden: number;
  /** Distance of the chamber's back wall from the wall plane. */
  caveBack: number;
  // windows
  windows: number;
  windowWidth: number;
  windowHeight: number;
  windowDepth: number;
  windowRound: boolean;
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
  rootLumps: 0.2,
  mainBranches: 4,
  spreadAngle: 50,
  mainLength: 1500,
  crotch: 400,
  topFlare: 0.5,
  curl: 0.4,
  subBranches: 3,
  generations: 2,
  stubs: 5,
  stubLength: 150,
  stubThickness: 60,
  cave: true,
  caveWidth: 110,
  caveHeight: 160,
  caveWiden: 1.7,
  caveBack: 25,
  windows: 4,
  windowWidth: 55,
  windowHeight: 85,
  windowDepth: 40,
  windowRound: false,
  barkDepth: 8,
  barkScale: 16,
  seed: 7,
  bedX: 256,
  bedY: 256,
  bedZ: 256,
  ceilingBand: 250,
  gridOffsetX: 0,
};

/** Progress callback: fraction 0..1 and a short description of the current step. May be async to let the UI breathe. */
export type Progress = (frac: number, label: string) => Promise<void> | void;
const noProgress: Progress = () => {};

/** Reports into the sub-range [lo, hi] of a parent progress. */
function sub(progress: Progress, lo: number, hi: number): Progress {
  return (f, label) => progress(lo + (hi - lo) * Math.min(1, Math.max(0, f)), label);
}

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

/** Convex pocket cut into the trunk, as the planes of a convex solid (inside = n . p <= d for all planes). */
interface Pocket {
  yMin: number;
  yMax: number;
  planes: GeneralPlane[];
  label: string;
}

/** Arch (or circle) outline, counter-clockwise, bottom centre at the origin. */
export function outline(w: number, h: number, round: boolean, arcSteps = 4): [number, number][] {
  const pts: [number, number][] = [];
  if (round) {
    const rr = Math.min(w, h) / 2;
    const m = arcSteps * 2;
    for (let i = 0; i < m; i++) {
      const a = (i / m) * Math.PI * 2 - Math.PI / 2;
      pts.push([Math.cos(a) * rr * (w / Math.min(w, h)), rr + Math.sin(a) * rr * (h / Math.min(w, h))]);
    }
    return pts;
  }
  const hs = Math.max(0, h - w / 2);
  pts.push([-w / 2, 0], [w / 2, 0], [w / 2, hs]);
  for (let i = 1; i < arcSteps; i++) {
    const a = (i / arcSteps) * Math.PI;
    pts.push([Math.cos(a) * (w / 2), hs + Math.sin(a) * (w / 2)]);
  }
  pts.push([-w / 2, hs]);
  return pts;
}

/**
 * A pocket cut straight into the wall from the front: `outline` at depth zs, growing by `widen`
 * (1 = straight walls) around its bottom centre towards the back plane at zb.
 */
export function pocket(
  cx: number, sill: number, zs: number, zb: number, poly: [number, number][], widen: number, label: string,
): Pocket {
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const D = zs - zb;
  const grow = (widen - 1) / D;
  let hMax = 0;
  for (const q of poly) hMax = Math.max(hMax, q[1]);
  const inner = V(cx, sill + hMax * 0.4, zs - D * 0.5);
  const planes: GeneralPlane[] = [{ n: [0, 0, -1], d: -zb }];
  for (let i = 0; i < poly.length; i++) {
    const pi = poly[i], pj = poly[(i + 1) % poly.length];
    const A = V(cx + pi[0], sill + pi[1], zs);
    const e = V(cx + pj[0], sill + pj[1], zs).sub(A);
    const g = V(pi[0] * grow, pi[1] * grow, -1);
    const n = e.cross(g).normalize();
    if (n.dot(inner.clone().sub(A)) > 0) n.negate();
    planes.push({ n: [n.x, n.y, n.z], d: n.dot(A) });
  }
  const top = hMax * Math.max(1, widen);
  return { yMin: sill - 5, yMax: sill + top + 5, planes, label };
}

/** Everything of `tris` outside the convex pocket, as disjoint closed pieces that share their cut faces. */
export async function carve(tris: Float32Array, pk: Pocket, progress: Progress): Promise<Float32Array[]> {
  const pieces: Float32Array[] = [];
  let rest = tris;
  for (let i = 0; i < pk.planes.length && rest.length > 0; i++) {
    const out = clip(rest, flipPlane(pk.planes[i]));
    if (out.length) pieces.push(out);
    rest = clip(rest, pk.planes[i]);
    await progress((i + 1) / pk.planes.length, pk.label);
  }
  return pieces;
}

/** Expected number of tubes, for the progress bar. */
function tubeEstimate(p: TreeParams): number {
  const nM = Math.max(1, Math.round(p.mainBranches));
  let total = 1 + p.stubs + nM;
  let level = nM;
  for (let g = 1; g <= p.generations; g++) {
    level *= g === 1 ? p.subBranches : Math.max(1, p.subBranches - 1);
    total += level;
  }
  return total;
}

/**
 * The finished tree as closed solids (overlapping where branches join), cut flat against the wall,
 * the ceiling and the floor, with the cave and windows carved out of the trunk.
 */
export async function buildTree(p: TreeParams, progress: Progress = noProgress): Promise<Float32Array[]> {
  const rand = rng(p.seed);
  const noise = createNoise3D(rng(p.seed + 101));
  const H = p.roomHeight;
  const k = 2 * p.protrusion - 1;
  const shellsRaw: Float32Array[] = [];
  const planes = roomPlanes(p);
  const expected = tubeEstimate(p);
  const build = sub(progress, 0, 0.5);
  let built = 0;
  const addTube = async (b: Branch, label: string, extra: Partial<Parameters<typeof buildTube>[0]> = {}, flare = 0) => {
    const rad = (s: number) => {
      const base = lerp(b.r0, b.r1, Math.pow(s, 0.8));
      return flare ? base * (1 + flare * Math.exp((-s * b.length) / (b.r0 * 2.5))) : base;
    };
    shellsRaw.push(
      buildTube({
        pts: b.pts, radius: rad, protrusion: p.protrusion, ceilingY: H, barkDepth: p.barkDepth,
        barkScale: p.barkScale, noise, noiseOffset: rand() * 100, ...extra,
      }),
    );
    await build(Math.min(1, ++built / expected), label);
  };

  // ---- trunk, on the wall -------------------------------------------------
  const r0 = p.trunkDiameter / 2;
  const rFork = r0 * 0.55;
  const yTop = p.trunkOnly ? H - rFork * k : H * p.forkHeight;
  const trunkLen = yTop + r0;
  const trunkPts: THREE.Vector3[] = [];
  const nT = Math.max(4, Math.round(yTop / 250));
  for (let i = 0; i <= nT; i++) {
    const t = i / nT;
    trunkPts.push(new THREE.Vector3(Math.sin(t * 2.4 + p.seed) * r0 * 0.25 * t, -r0 + t * trunkLen, 0));
  }
  const xAtY = (y: number) => {
    const t = clamp((y + r0) / trunkLen, 0, 1) * nT;
    const i = Math.min(nT - 1, Math.floor(t));
    return lerp(trunkPts[i].x, trunkPts[i + 1].x, t - i);
  };
  // trunk radius at s mm along its length: taper, root flare, and a widening towards the crotch
  const trunkR = (sMm: number) => {
    const s = clamp(sMm / trunkLen, 0, 1);
    let r = lerp(r0, rFork, Math.pow(s, 0.8));
    r *= 1 + 0.35 * Math.exp(-sMm / (r0 * 2.5));
    if (p.trunkOnly) r *= 1 + p.topFlare * Math.exp(-(trunkLen - sMm) / 380);
    return r;
  };
  const rAtY = (y: number) => trunkR(y + r0);
  const lobePhase = rand() * 6.28;
  const lumps = (a: number, sMm: number) => {
    if (p.rootLumps <= 0) return 1;
    const fade = Math.exp(-Math.max(0, sMm - r0) / 260); // swellings stay close to the floor
    const g = 0.5 + 0.5 * Math.cos(5 * a + lobePhase);
    const n = noise(Math.cos(a) * 1.3, Math.sin(a) * 1.3, sMm / 140) * 0.5 + 0.5;
    return 1 + p.rootLumps * fade * (0.25 + 0.75 * g * g) * (0.6 + 0.8 * n);
  };

  // ---- features carved into the trunk ------------------------------------
  const pockets: Pocket[] = [];
  const zc = (y: number) => k * rAtY(y);
  if (p.cave) {
    const sill = 12;
    const cx = xAtY(sill + p.caveHeight / 2);
    const rr = rAtY(sill + p.caveHeight / 2);
    const zs = zc(sill + p.caveHeight / 2) + rr * (1.15 + p.rootLumps);
    const zb = Math.max(2, p.caveBack);
    pockets.push(pocket(cx, sill, zs, zb, outline(p.caveWidth, p.caveHeight, false), Math.max(1.01, p.caveWiden), 'Carving the hollow'));
  }
  const nWin = Math.round(p.windows);
  const caveTop = p.cave ? 12 + p.caveHeight * p.caveWiden + 140 : 250;
  const winLo = Math.max(caveTop, 450), winHi = yTop - Math.max(500, p.windowHeight + 300);
  const winYs: { y: number; dx: number }[] = [];
  for (let i = 0; i < nWin && winHi > winLo; i++) {
    const y = lerp(winLo, winHi, (i + 0.5) / nWin) + (rand() - 0.5) * 0.3 * ((winHi - winLo) / nWin);
    const rr = rAtY(y);
    winYs.push({ y, dx: (rand() - 0.5) * 0.6 * rr });
  }
  for (const w of winYs) {
    const rr = rAtY(w.y);
    const zfront = zc(w.y) + Math.sqrt(Math.max(0, rr * rr - w.dx * w.dx));
    const sill = w.y - p.windowHeight / 2;
    pockets.push(
      pocket(xAtY(w.y) + w.dx, sill, zfront + 6, zfront - p.windowDepth, outline(p.windowWidth, p.windowHeight, p.windowRound), 1, 'Carving windows'),
    );
  }
  pockets.sort((a, b) => a.yMin - b.yMin);

  // ---- tubes ---------------------------------------------------------------
  const trunk: Branch = { pts: trunkPts, modes: trunkPts.map(() => 'wall' as Mode), r0, r1: rFork, length: trunkLen };
  await addTube(trunk, 'Growing the trunk', {
    radius: (s) => trunkR(s * trunkLen),
    radialMod: p.rootLumps > 0 ? lumps : undefined,
  });

  // old sawn-off branches on the trunk
  const stubYs: number[] = [];
  const taken = pockets.map((q) => [q.yMin - 90, q.yMax + 90] as [number, number]);
  for (let i = 0; i < Math.round(p.stubs); i++) {
    for (let tries = 0; tries < 30; tries++) {
      const y = lerp(r0 * 1.2 + 150, yTop - 350, rand());
      if (taken.some(([a, b]) => y > a && y < b) || stubYs.some((u) => Math.abs(u - y) < 160)) continue;
      stubYs.push(y);
      const side = rand() < 0.5 ? -1 : 1;
      const rt = rAtY(y);
      const phi = THREE.MathUtils.degToRad(8 + rand() * 32);
      const dir = new THREE.Vector3(side * Math.cos(phi), Math.sin(phi), 0.15 * rand()).normalize();
      const start = new THREE.Vector3(xAtY(y) + side * rt * 0.35, y, 0);
      const len = rt * 0.65 + p.stubLength * (0.7 + 0.6 * rand());
      const mid = start.clone().addScaledVector(dir, len * 0.5);
      const end = start.clone().addScaledVector(dir, len);
      const rs = (p.stubThickness / 2) * (0.8 + 0.4 * rand());
      await addTube(
        { pts: [start, mid, end], modes: ['wall', 'wall', 'wall'], r0: rs, r1: rs * 0.85, length: len },
        'Sawing off old branches',
        { endTilt: (rand() < 0.5 ? -1 : 1) * (0.25 + 0.4 * rand()) },
      );
      break;
    }
  }

  // main branches
  const mains: Branch[] = [];
  const nM = Math.max(1, Math.round(p.mainBranches));
  const spread = THREE.MathUtils.degToRad(p.spreadAngle);
  for (let i = 0; i < nM; i++) {
    const side = nM === 1 ? 0 : (2 * (i + 0.5)) / nM - 1;
    const len = p.mainLength * (0.85 + 0.3 * rand());
    let b: Branch;
    if (p.trunkOnly) {
      // leave the trunk at a slant in the wall plane, then bend onto the ceiling
      const y = H - rFork * k - p.crotch * (0.45 + 0.55 * rand());
      const heading = clamp(spread * 0.8, 0, 0.95) * side + (rand() - 0.5) * 0.15;
      const rb = rAtY(y) * (nM > 2 ? 0.5 : 0.68);
      b = grow(p, rand, new THREE.Vector3(xAtY(y), y, 0), 'wall', heading, len, rb, rb * 0.3, p.curl, 0.25);
    } else {
      const heading = spread * side + (rand() - 0.5) * 0.15;
      const f = 0.82 + 0.18 * rand();
      const start = trunkPts[Math.min(trunkPts.length - 1, Math.round(f * (trunkPts.length - 1)))];
      const rb = rFork * (nM > 2 ? 0.92 : 1);
      b = grow(p, rand, new THREE.Vector3(start.x, start.y, 0), 'wall', heading, len, rb, rb * 0.35, p.curl, 0.25);
    }
    mains.push(b);
    await addTube(b, 'Growing branches');
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
        await addTube(b, 'Growing twigs');
      }
    }
    parents = next;
  }

  // ---- cut flat, then carve ---------------------------------------------
  const out: Float32Array[] = [];
  const flat = sub(progress, 0.5, 0.75);
  const carveP = sub(progress, 0.75, 1);
  for (let i = 0; i < shellsRaw.length; i++) {
    const t = clipAll(shellsRaw[i], planes);
    if (i === 0) shellsRaw[0] = t;
    else if (t.length) out.push(t);
    await flat((i + 1) / shellsRaw.length, 'Cutting the back flat');
  }
  let rest = shellsRaw[0];
  for (let i = 0; i < pockets.length; i++) {
    const pk = pockets[i];
    const next = pockets[i + 1];
    const yb = next ? (pk.yMax + next.yMin) / 2 : pk.yMax + 60;
    const slab = clip(rest, { axis: 1, sign: 1, pos: yb });
    rest = clip(rest, { axis: 1, sign: -1, pos: yb });
    out.push(...(await carve(slab, pk, sub(carveP, i / pockets.length, (i + 1) / pockets.length))));
  }
  if (rest.length) out.push(rest);
  await carveP(1, 'Done');
  return out;
}

/** Flat back on the wall (z = 0), flat top on the ceiling, flat bottom on the floor. */
export function roomPlanes(p: TreeParams): Plane[] {
  return [
    { axis: 2, sign: -1, pos: 0 },
    { axis: 1, sign: 1, pos: p.roomHeight },
    { axis: 1, sign: -1, pos: 0 },
  ];
}

export interface Part {
  /** 'wall' parts are tiled in x/y and print on their flat back; 'ceiling' parts are tiled in x/z and print on their flat ceiling face. */
  zone: 'wall' | 'ceiling';
  i: number;
  j: number;
  /** Triangle soup in tree coordinates (mm). */
  tris: Float32Array;
}

async function tile(
  shells: Float32Array[], zone: Part['zone'], au: 0 | 1 | 2, av: 0 | 1 | 2,
  offU: number, sizeU: number, sizeV: number, progress: Progress,
): Promise<Part[]> {
  const tiles = new Map<string, Float32Array[]>();
  const add = (i: number, j: number, t: Float32Array) => {
    if (t.length === 0) return;
    const key = `${i},${j}`;
    tiles.set(key, [...(tiles.get(key) ?? []), t]);
  };
  for (let n = 0; n < shells.length; n++) {
    const sh = shells[n];
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
    await progress((n + 1) / shells.length, zone === 'wall' ? 'Cutting wall parts' : 'Cutting ceiling parts');
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
export async function splitIntoParts(shells: Float32Array[], p: TreeParams, progress: Progress = noProgress): Promise<Part[]> {
  const yCut = p.roomHeight - p.ceilingBand;
  const wall: Float32Array[] = [];
  const ceil: Float32Array[] = [];
  for (const sh of shells) {
    const w = clip(sh, { axis: 1, sign: 1, pos: yCut });
    const c = clip(sh, { axis: 1, sign: -1, pos: yCut });
    if (w.length) wall.push(w);
    if (c.length) ceil.push(c);
  }
  const wallParts = await tile(wall, 'wall', 0, 1, p.gridOffsetX, p.bedX, p.bedY, sub(progress, 0, 0.8));
  const ceilParts = await tile(ceil, 'ceiling', 0, 2, p.gridOffsetX, p.bedX, p.bedY, sub(progress, 0.8, 1));
  return [...wallParts, ...ceilParts];
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
