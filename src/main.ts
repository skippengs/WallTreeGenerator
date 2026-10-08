import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import GUI from 'lil-gui';
import { buildTree, defaultParams, type TreeParams } from './tree';

const container = document.getElementById('view')!;
const info = document.getElementById('info')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1f27);
const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
camera.position.set(150, 150, 350);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(200, 300, 400);
scene.add(sun);

// wall (the flat back sits on z = 0)
const wall = new THREE.Mesh(
  new THREE.PlaneGeometry(1000, 1000),
  new THREE.MeshStandardMaterial({ color: 0x2b313c, side: THREE.DoubleSide }),
);
wall.position.z = -0.05;
scene.add(wall);

const material = new THREE.MeshStandardMaterial({ color: 0x2f9e5b, roughness: 0.7 });
let treeGroup: THREE.Group | null = null;
const params: TreeParams = { ...defaultParams };

function rebuild() {
  if (treeGroup) {
    treeGroup.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    scene.remove(treeGroup);
  }
  const t0 = performance.now();
  treeGroup = buildTree(params);
  treeGroup.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = material;
  });
  scene.add(treeGroup);
  controls.target.set(0, params.height / 2, 0);
  const ms = Math.round(performance.now() - t0);
  info.textContent = `${params.height} mm tall · ${Math.round(params.circumference)} mm circumference · built in ${ms} ms`;
}

let timer: number | undefined;
const schedule = () => {
  clearTimeout(timer);
  timer = window.setTimeout(rebuild, 120);
};

function exportSTL() {
  if (!treeGroup) return;
  const data = new STLExporter().parse(treeGroup, { binary: true }) as unknown as DataView;
  const blob = new Blob([data.buffer as ArrayBuffer], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'wall-tree.stl';
  a.click();
  URL.revokeObjectURL(a.href);
}

const gui = new GUI({ title: 'Wall Tree' });
gui.add(params, 'height', 40, 400, 1).name('Height (mm)').onChange(schedule);
gui.add(params, 'circumference', 40, 800, 1).name('Circumference (mm)').onChange(schedule);
gui.add(params, 'levels', 1, 30, 1).name('Branch rows').onChange(schedule);
gui.add(params, 'branchesPerLevel', 1, 15, 1).name('Branches per row').onChange(schedule);
gui.add(params, 'branchAngle', 0, 90, 1).name('Branch angle (°)').onChange(schedule);
gui.add(params, 'droop').name('Branches point down').onChange(schedule);
gui.add(params, 'branchThickness', 1, 20, 0.5).name('Branch thickness').onChange(schedule);
gui.add(params, 'trunkHeight', 0, 80, 1).name('Trunk height').onChange(schedule);
gui.add(params, 'trunkRadius', 1, 30, 0.5).name('Trunk radius').onChange(schedule);
gui.add({ exportSTL }, 'exportSTL').name('Download STL');

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
rebuild();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
