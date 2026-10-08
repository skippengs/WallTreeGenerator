import * as THREE from 'three';
import type { NoiseFunction3D } from 'simplex-noise';

export interface TubeOpts {
  /** Centerline control points (wall branches keep z = 0, ceiling branches run into the room). */
  pts: THREE.Vector3[];
  /** Radius (mm) along the tube, s in 0..1. */
  radius: (s: number) => number;
  /** Fraction of the tube diameter that stands out from the wall / hangs from the ceiling when cut flat (0.5 = half round). */
  protrusion: number;
  ceilingY: number;
  barkDepth: number;
  /** Size of one bark feature in mm; also sets the mesh density. */
  barkScale: number;
  noise: NoiseFunction3D;
  noiseOffset: number;
}

/** Closed tube (flat end caps) with ridged bark displacement, as a triangle soup. */
export function buildTube(o: TubeOpts): Float32Array {
  const curve = new THREE.CatmullRomCurve3(o.pts, false, 'centripetal');
  const length = curve.getLength();
  let rMax = 0;
  for (let i = 0; i <= 20; i++) rMax = Math.max(rMax, o.radius(i / 20));
  const rows = Math.max(6, Math.ceil(length / (o.barkScale / 3)));
  const cols = Math.min(96, Math.max(10, Math.ceil((2 * Math.PI * rMax) / (o.barkScale / 3))));

  const ring: THREE.Vector3[][] = [];
  const centers: THREE.Vector3[] = [];
  let normal = new THREE.Vector3();
  let prevT = new THREE.Vector3();
  let N = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const verts: THREE.Vector3[][] = [];

  for (let i = 0; i <= rows; i++) {
    const u = i / rows;
    const P = curve.getPointAt(u);
    const T = curve.getTangentAt(u).normalize();
    if (i === 0) {
      N = new THREE.Vector3().crossVectors(T, Math.abs(T.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : zAxis).normalize();
    } else {
      // parallel transport keeps the frame free of twist
      const axis = new THREE.Vector3().crossVectors(prevT, T);
      const len = axis.length();
      if (len > 1e-9) {
        axis.divideScalar(len);
        N.applyAxisAngle(axis, Math.asin(Math.min(1, len)));
      }
    }
    prevT = T;
    const B = new THREE.Vector3().crossVectors(T, N).normalize();
    normal = N;
    const r = o.radius(u);
    const s = u * length;
    const c = P.clone();
    const k = r * (2 * o.protrusion - 1);
    c.z = Math.max(c.z, k);
    c.y = Math.min(c.y, o.ceilingY - k);
    centers.push(c);
    const row: THREE.Vector3[] = [];
    const amp = Math.min(o.barkDepth, r * 0.3);
    for (let j = 0; j < cols; j++) {
      const a = (j / cols) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const k = r / o.barkScale;
      const f1 = o.noise(ca * k + o.noiseOffset, sa * k, s / (o.barkScale * 5));
      const f2 = o.noise(ca * k * 2.7, sa * k * 2.7 + o.noiseOffset, s / (o.barkScale * 1.6));
      const ridge = 1 - Math.abs(f1);
      const h = 0.75 * ridge * ridge + 0.25 * (f2 * 0.5 + 0.5) - 0.5;
      const rr = r + amp * h * 2;
      row.push(new THREE.Vector3().copy(c).addScaledVector(N, ca * rr).addScaledVector(B, sa * rr));
    }
    verts.push(row);
    ring.push(row);
  }
  void normal;

  const out: number[] = [];
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) =>
    out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const j2 = (j + 1) % cols;
      const a = verts[i][j], b = verts[i][j2], c = verts[i + 1][j2], d = verts[i + 1][j];
      // angle runs from N towards B; with T = N x B-handedness this winds outwards
      push(a, c, d);
      push(a, b, c);
    }
  }
  const first = centers[0], last = centers[rows];
  for (let j = 0; j < cols; j++) {
    const j2 = (j + 1) % cols;
    push(first, verts[0][j2], verts[0][j]);
    push(last, verts[rows][j], verts[rows][j2]);
  }
  void ring;
  return Float32Array.from(out);
}

/** Signed volume of a triangle soup; positive when faces point outwards. */
export function volume(tris: Float32Array): number {
  let v = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}
