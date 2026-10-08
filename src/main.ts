import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { buildTree, defaultParams, partName, printOrientation, splitIntoParts, type Part, type Progress, type TreeParams } from './treegen';
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
const view = { mode: 'Assembled', partGap: 30, showRoom: true };
const wallMat = new THREE.MeshStandardMaterial({ color: 0x2b313c, side: THREE.DoubleSide });
const ceilMat = new THREE.MeshBasicMaterial({ color: 0x20252e, side: THREE.DoubleSide });
const woods = [new THREE.MeshStandardMaterial({ color: 0x8a5f3c, flatShading: true }), new THREE.MeshStandardMaterial({ color: 0x6b7f4a, flatShading: true })];
const room = new THREE.Group();
scene.add(room);
room.visible = view.showRoom;
let treeGroup = new THREE.Group();
scene.add(treeGroup);
let shells: Float32Array[] = [];
let parts: Part[] | null = null; // the tree cut into printable parts, made on demand
let builtSeconds = 0;

// ---- loading screen --------------------------------------------------------
const loading = document.getElementById('loading')!;
const loadingBar = document.getElementById('loading-bar')!;
const loadingLabel = document.getElementById('loading-label')!;
const loadingPct = document.getElementById('loading-pct')!;
const loadingTitle = document.getElementById('loading-title')!;
const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));
class Cancelled extends Error {}
let job = 0; // a newer request cancels the one in flight

/** Shows the loading screen while `work` runs. A newer job cancels this one at its next progress report. */
async function withLoading<T>(title: string, work: (progress: Progress) => Promise<T>): Promise<T | undefined> {
  const mine = ++job;
  loadingTitle.textContent = title;
  loading.hidden = false;
  let last = performance.now();
  const progress: Progress = async (f, label) => {
    const pct = Math.round(Math.min(1, Math.max(0, f)) * 100);
    loadingBar.style.width = `${pct}%`;
    loadingPct.textContent = `${pct}%`;
    loadingLabel.textContent = label;
    if (performance.now() - last > 40) {
      await nextFrame(); // let the browser paint and handle input
      last = performance.now();
    }
    if (mine !== job) throw new Cancelled();
  };
  try {
    await progress(0, 'Starting');
    return await work(progress);
  } catch (e) {
    if (e instanceof Cancelled) return undefined;
    throw e;
  } finally {
    if (mine === job) loading.hidden = true;
  }
}

// ---- scene -------------------------------------------------------------------
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

function placeParts() {
  const g = view.partGap;
  for (const m of treeGroup.children) {
    const p = m.userData.part as Part | undefined;
    if (!p) continue;
    if (p.zone === 'wall') m.position.set(p.i * g, p.j * g, 0);
    else m.position.set(p.i * g, g, p.j * g);
  }
}

function renderScene() {
  disposeGroup(treeGroup);
  disposeGroup(room);
  let note = '';
  if (view.mode === 'Parts (exploded)' && parts) {
    for (const p of parts) {
      const m = new THREE.Mesh(geometry(p.tris), woods[(p.i + p.j + (p.zone === 'wall' ? 0 : 1)) & 1 ? 1 : 0]);
      m.userData.part = p;
      treeGroup.add(m);
    }
    placeParts();
    note = ` · ${parts.length} parts`;
  } else {
    const all = new Float32Array(shells.reduce((s, a) => s + a.length, 0));
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
  const floorGrid = new THREE.GridHelper(6000, 24, 0x445, 0x334);
  floorGrid.position.set(0, -0.5, 1500);
  room.add(wall, ceil, floorGrid);
  info.textContent = `${(H / 1000).toFixed(2)} m room${note} · tree built in ${builtSeconds.toFixed(1)} s`;
}

/** Grows the tree again (and cuts the parts if the parts view is showing). */
async function rebuild() {
  const t0 = performance.now();
  const wantParts = view.mode === 'Parts (exploded)';
  const result = await withLoading('Growing your tree', async (progress) => {
    const built = await buildTree(params, (f, l) => progress(f * (wantParts ? 0.7 : 1), l));
    const cut = wantParts ? await splitIntoParts(built, params, (f, l) => progress(0.7 + f * 0.3, l)) : null;
    return { built, cut };
  });
  if (!result) return;
  shells = result.built;
  parts = result.cut;
  builtSeconds = (performance.now() - t0) / 1000;
  controls.target.set(0, params.roomHeight * 0.55, 500);
  renderScene();
}

/** The tree is unchanged, only the way it is cut or shown changed. */
async function refreshParts() {
  parts = null;
  if (view.mode === 'Parts (exploded)') {
    const cut = await withLoading('Cutting the tree into parts', (progress) => splitIntoParts(shells, params, progress));
    if (!cut) return;
    parts = cut;
  }
  renderScene();
}

let timer: number | undefined;
const later = (fn: () => void) => {
  clearTimeout(timer);
  timer = window.setTimeout(fn, 400);
};

// ---- export -----------------------------------------------------------------------
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

async function exportParts() {
  const files = await withLoading('Preparing parts', async (progress) => {
    const cut = parts ?? (await splitIntoParts(shells, params, (f, l) => progress(f * 0.9, l)));
    await progress(0.9, 'Writing STL files');
    return cut.map((p) => ({ name: `${partName(p)}.stl`, data: toStl(printOrientation(p, params)) }));
  });
  if (files) download(zip(files), 'wall-tree-parts.zip');
}

// ---- controls ---------------------------------------------------------------------
const gui = new GUI({ title: 'Wall Tree (mm)' });
type Num = { [K in keyof TreeParams]: TreeParams[K] extends number ? K : never }[keyof TreeParams];
type Flag = { [K in keyof TreeParams]: TreeParams[K] extends boolean ? K : never }[keyof TreeParams];
/** Sliders that reshape the tree regrow it; bed settings only re-cut the parts. */
const num = (f: GUI, key: Num, min: number, max: number, step: number, name: string, cutOnly = false) =>
  f.add(params, key, min, max, step).name(name).onChange(() => later(cutOnly ? refreshParts : rebuild));
const flag = (f: GUI, key: Flag, name: string) => f.add(params, key).name(name).onChange(() => later(rebuild));

gui.add(view, 'mode', ['Assembled', 'Parts (exploded)']).name('View').onChange(() => void refreshParts());
gui.add(view, 'partGap', 0, 150, 1).name('Part gap (parts view)').onChange(placeParts);
gui.add(view, 'showRoom').name('Show room (wall, ceiling, floor)').onChange((v: boolean) => (room.visible = v));

const trunk = gui.addFolder('Room & trunk');
num(trunk, 'roomHeight', 1800, 4000, 10, 'Room height');
num(trunk, 'trunkDiameter', 80, 600, 5, 'Trunk diameter');
num(trunk, 'protrusion', 0.55, 1, 0.01, 'Depth (0.5 = half round)');
num(trunk, 'rootLumps', 0, 0.6, 0.01, 'Lumpy foot');
flag(trunk, 'trunkOnly', 'Only trunk on the wall');
num(trunk, 'crotch', 150, 900, 10, 'Crotch slope height');
num(trunk, 'topFlare', 0, 1.2, 0.01, 'Trunk widening at the top');
num(trunk, 'forkHeight', 0.25, 0.8, 0.01, 'Fork height (branches on wall)');

const br = gui.addFolder('Branches');
num(br, 'mainBranches', 1, 8, 1, 'Main branches');
num(br, 'spreadAngle', 0, 90, 1, 'Spread angle (°)');
num(br, 'mainLength', 400, 3000, 10, 'Main branch length');
num(br, 'curl', 0, 1, 0.01, 'Curl towards ceiling');
num(br, 'subBranches', 0, 6, 1, 'Sub-branches each');
num(br, 'generations', 0, 3, 1, 'Sub-branch levels');
num(br, 'seed', 1, 999, 1, 'Random seed');

const old = gui.addFolder('Old sawn-off branches');
num(old, 'stubs', 0, 14, 1, 'Count');
num(old, 'stubLength', 40, 300, 5, 'Length');
num(old, 'stubThickness', 20, 120, 1, 'Thickness');

const cave = gui.addFolder('Hollow at the foot');
flag(cave, 'cave', 'Arched hollow');
num(cave, 'caveWidth', 50, 220, 1, 'Opening width');
num(cave, 'caveHeight', 80, 300, 1, 'Opening height');
num(cave, 'caveWiden', 1, 2.4, 0.01, 'Chamber widening');
num(cave, 'caveBack', 5, 80, 1, 'Back wall distance from wall');

const win = gui.addFolder('Windows');
num(win, 'windows', 0, 10, 1, 'Count');
num(win, 'windowWidth', 25, 120, 1, 'Width');
num(win, 'windowHeight', 30, 160, 1, 'Height');
num(win, 'windowDepth', 10, 80, 1, 'Depth');
flag(win, 'windowRound', 'Round instead of arched');

const bk = gui.addFolder('Bark');
num(bk, 'barkDepth', 0, 20, 0.5, 'Bark depth');
num(bk, 'barkScale', 8, 40, 1, 'Bark feature size');

const pr = gui.addFolder('Printing');
num(pr, 'bedX', 100, 600, 1, 'Bed width', true);
num(pr, 'bedY', 100, 600, 1, 'Bed depth', true);
num(pr, 'bedZ', 50, 600, 1, 'Max part height', true);
num(pr, 'ceilingBand', 100, 600, 1, 'Ceiling zone height', true);
num(pr, 'gridOffsetX', 0, 600, 1, 'Cut grid shift X', true);
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
(window as unknown as { __app: unknown }).__app = { camera, controls };
void rebuild();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
