import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';

export interface TreeParams {
  /** Total height in mm, including trunk. */
  height: number;
  /** Circumference (mm) of the widest circle the lowest branches reach. */
  circumference: number;
  /** Rows of branches along the stem. */
  levels: number;
  /** Branches per row on the visible half (0..180 degrees around the stem). */
  branchesPerLevel: number;
  /** Branch angle from horizontal, 0..90 degrees. */
  branchAngle: number;
  /** Point branches down instead of up. */
  droop: boolean;
  /** Branch thickness at the stem (mm). */
  branchThickness: number;
  trunkHeight: number;
  trunkRadius: number;
}

export const defaultParams: TreeParams = {
  height: 150,
  circumference: 220,
  levels: 10,
  branchesPerLevel: 5,
  branchAngle: 30,
  droop: true,
  branchThickness: 5,
  trunkHeight: 15,
  trunkRadius: 6,
};

const UP = new THREE.Vector3(0, 1, 0);
const SEGMENTS = 24;

function part(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): Brush {
  const brush = new Brush(geometry);
  matrix.decompose(brush.position, brush.quaternion, brush.scale);
  brush.updateMatrixWorld(true);
  return brush;
}

/**
 * Builds the tree as closed solids. Coordinates: Y up, flat back on the z = 0
 * plane, tree grows towards +z. Exported as-is, the model lies on its back on
 * the print bed.
 */
export function buildTree(p: TreeParams): THREE.Group {
  const parts: Brush[] = [];
  const stemBottom = p.trunkHeight;
  const stemHeight = Math.max(1, p.height - p.trunkHeight);
  const reach = p.circumference / (2 * Math.PI);
  const stemRadius = Math.max(p.branchThickness * 0.8, p.trunkRadius * 0.6);
  const sign = p.droop ? -1 : 1;
  const theta = THREE.MathUtils.degToRad(p.branchAngle) * sign;

  // trunk
  if (p.trunkHeight > 0) {
    const g = new THREE.CylinderGeometry(p.trunkRadius, p.trunkRadius, p.trunkHeight + 1, SEGMENTS);
    parts.push(part(g, new THREE.Matrix4().makeTranslation(0, (p.trunkHeight + 1) / 2 - 1, 0)));
  }

  // central stem (tapered)
  {
    const g = new THREE.CylinderGeometry(stemRadius * 0.25, stemRadius, stemHeight, SEGMENTS);
    parts.push(part(g, new THREE.Matrix4().makeTranslation(0, stemBottom + stemHeight / 2, 0)));
  }

  // branches
  const n = Math.max(1, Math.round(p.branchesPerLevel));
  const levels = Math.max(1, Math.round(p.levels));
  for (let i = 0; i < levels; i++) {
    // t: 0 at the lowest row, 1 at the top row
    const t = levels === 1 ? 0 : i / (levels - 1);
    const y = stemBottom + (0.08 + 0.85 * t) * stemHeight;
    const length = Math.max(p.branchThickness * 2, reach * (1 - 0.92 * t));
    const radius = p.branchThickness * (1 - 0.5 * t) / 2;
    const staggered = i % 2 === 1;
    for (let j = 0; j < n; j++) {
      // spread over the front half only; the back half is cut away anyway
      const phi = staggered
        ? (Math.PI * (j + 0.5)) / n
        : n > 1 ? (Math.PI * j) / (n - 1) : Math.PI / 2;
      const dir = new THREE.Vector3(
        Math.cos(phi) * Math.cos(theta),
        Math.sin(theta),
        Math.sin(phi) * Math.cos(theta),
      ).normalize();
      const g = new THREE.CylinderGeometry(radius * 0.3, radius, length, 12);
      g.translate(0, length / 2, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
      parts.push(part(g, new THREE.Matrix4().compose(new THREE.Vector3(0, y, 0), q, new THREE.Vector3(1, 1, 1))));
    }
  }

  // Cut everything flat at z = 0.
  const evaluator = new Evaluator();
  evaluator.useGroups = false;
  const size = 10000;
  const cutter = new Brush(new THREE.BoxGeometry(size, size, size));
  cutter.position.set(0, 0, -size / 2);
  cutter.updateMatrixWorld(true);

  const clipped = parts.map((b) => evaluator.evaluate(b, cutter, SUBTRACTION));

  // Parts overlap; slicers union overlapping closed shells on import.
  const group = new THREE.Group();
  clipped.forEach((m) => group.add(m));
  return group;
}
