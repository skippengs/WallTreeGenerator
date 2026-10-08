import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { buildTree, defaultParams, partName, printOrientation, splitIntoParts, type TreeParams } from './treegen';
import { toStl, zip } from './export';

const container = document.getElementById('view')!;
const info = document.getElementById('info')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1f27);
const camera = new THREE.PerspectiveCamera(40, 1, 50, 30000);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-1500, 3000, 4000);
scene.add(sun);

const params: TreeParams = { ...defaultParams };
const view = { mode: 'Assembled', partGap: 30 };
const wallMat = new THREE.MeshStandardMaterial({ color: 0x2b313c, side: THREE.DoubleSide });
const ceilMat = new THREE.MeshBasicMaterial({ color: 0x20252e, side: THREE.DoubleSide });
const woods = [new THREE.MeshStandardMaterial({ color: 0x8a5f3c, flatShading: true }), new THREE.MeshStandardMaterial({ color: 0x6b7f4a, flatShading: true })];
const room = new THREE.Group();
scene.add(room);
let treeGroup = new THREE.Group();
scene.add(treeGroup);
let shells: Float32Array[] = [];

function geometry(tris: Float32Array) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
  g.computeVertexNormals();
  return g;
}

function disposeGroup(g: THREE.Group) {
  g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  g.clear();
}

function rebuild() {
  const t0 = performance.now();
  disposeGroup(treeGroup);
  disposeGroup(room);
  shells = buildTree(params);
  let note = '';
  if (view.mode === 'Parts (exploded)') {
    const parts = splitIntoParts(shells, params);
    for (const p of parts) {
      const m = new THREE.Mesh(geometry(p.tris), woods[(p.i + p.j + (p.zone === 'wall' ? 0 : 1)) & 1 ? 1 : 0]);
      const g = view.partGap;
      if (p.zone === 'wall') m.position.set(p.i * g, p.j * g, 0);
      else m.position.set(p.i * g, g, p.j * g);
      treeGroup.add(m);
    }
    note = ` · ${parts.length} parts`;
  } else {
    const total = shells.reduce((s, a) => s + a.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const s of shells) {
      all.set(s, o);
      o += s.length;
    }
    treeGroup.add(new THREE.Mesh(geometry(all), woods[0]));
  }
  const H = params.roomHeight;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(6000, H), wallMat);
  wall.position.set(0, H / 2, -0.5);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(6000, 3000), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, H + 0.5, 1500);
  room.add(wall, ceil, new THREE.GridHelper(6000, 24, 0x445, 0x334));
  const grid = room.children[2];
  grid.position.set(0, -0.5, 1500);
  controls.target.set(0, H * 0.55, 500);
  const ms = Math.round(performance.now() - t0);
  info.textContent = `${(H / 1000).toFixed(2)} m room${note} · built in ${ms} ms`;
}

let timer: number | undefined;
const schedule = () => {
  clearTimeout(timer);
  timer = window.setTimeout(rebuild, 300);
};

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportAssembled() {
  const all = new Float32Array(shells.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const s of shells) {
    all.set(s, o);
    o += s.length;
  }
  download(new Blob([toStl(all) as BlobPart], { type: 'model/stl' }), 'wall-tree-assembled.stl');
}

function exportParts() {
  const parts = splitIntoParts(shells, params);
  const files = parts.map((p) => ({ name: `${partName(p)}.stl`, data: toStl(printOrientation(p, params)) }));
  download(zip(files), 'wall-tree-parts.zip');
}

const gui = new GUI({ title: 'Wall Tree (mm)' });
const add = (folder: GUI, key: keyof TreeParams, min: number, max: number, step: number, name: string) =>
  folder.add(params, key, min, max, step).name(name).onChange(schedule);
gui.add(view, 'mode', ['Assembled', 'Parts (exploded)']).name('View').onChange(schedule);
gui.add(view, 'partGap', 0, 150, 1).name('Part gap (parts view)').onChange(schedule);
const room_ = gui.addFolder('Room & trunk');
add(room_, 'roomHeight', 1800, 4000, 10, 'Room height');
add(room_, 'trunkDiameter', 80, 600, 5, 'Trunk diameter');
add(room_, 'forkHeight', 0.25, 0.8, 0.01, 'Fork height (branches on wall)');
add(room_, 'protrusion', 0.55, 1, 0.01, 'Depth (0.5 = half round)');
room_.add(params, 'trunkOnly').name('Only trunk on the wall').onChange(schedule);
const br = gui.addFolder('Branches');
add(br, 'mainBranches', 1, 8, 1, 'Main branches');
add(br, 'spreadAngle', 0, 90, 1, 'Spread angle (°)');
add(br, 'mainLength', 400, 3000, 10, 'Main branch length');
add(br, 'curl', 0, 1, 0.01, 'Curl towards ceiling');
add(br, 'subBranches', 0, 6, 1, 'Sub-branches each');
add(br, 'generations', 0, 3, 1, 'Sub-branch levels');
add(br, 'seed', 1, 999, 1, 'Random seed');
const bk = gui.addFolder('Bark');
add(bk, 'barkDepth', 0, 20, 0.5, 'Bark depth');
add(bk, 'barkScale', 8, 40, 1, 'Bark feature size');
const pr = gui.addFolder('Printing');
add(pr, 'bedX', 100, 600, 1, 'Bed width');
add(pr, 'bedY', 100, 600, 1, 'Bed depth');
add(pr, 'bedZ', 50, 600, 1, 'Max part height');
add(pr, 'ceilingBand', 100, 600, 1, 'Ceiling zone height');
add(pr, 'gridOffsetX', 0, 600, 1, 'Cut grid shift X');
pr.add({ exportParts }, 'exportParts').name('Download parts (.zip)');
pr.add({ exportAssembled }, 'exportAssembled').name('Download assembled (.stl)');
if (window.innerWidth < 600) gui.close();

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
camera.position.set(3200, 900, 6200);
rebuild();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
