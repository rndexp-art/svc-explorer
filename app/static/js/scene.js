// Three.js scene: renderer, camera, OrbitControls, layouts, undulation,
// per-frame raycast targeting on nodes. The polygon overlay layer lives in
// polygons.js and reads camera/world from here.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { get, subscribe } from "./store.js";

const RADIUS = 140;
const BALL_R = 4.0;
const AMP = 6.5;
const FREQ = 0.45;

const canvas = document.getElementById("scene");

export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
camera.position.set(0, 0, 320);

export const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.45;
controls.zoomSpeed = 0.6;
controls.enablePan = false;
controls.minDistance = 40;
controls.maxDistance = 800;

scene.add(new THREE.AmbientLight(0x223355, 0.85));
const key = new THREE.DirectionalLight(0xa0c8ff, 0.9);
key.position.set(150, 220, 180);
scene.add(key);

// Faint starfield for the "floating in space" feel. Slow rotation hooked
// up via `starsRef` so tickWorld() can spin it without exposing the Points
// instance globally.
const starsRef = { value: null };
{
  const starCount = 600;
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 1100 + Math.random() * 300;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    pos[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i * 3 + 2] = r * Math.cos(phi);
  }
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(
    geom,
    new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, color: 0x6688aa, transparent: true, opacity: 0.55 }),
  );
  scene.add(stars);
  // Slowly rotate the starfield so the void doesn't feel static.
  starsRef.value = stars;
}

const ballGeom = new THREE.SphereGeometry(1, 16, 12);

function colorForLabels(labels) {
  if (labels.includes("agent")) return 0xffd075;
  if (labels.includes("source")) return 0x66e6ff;
  if (labels.includes("provider")) return 0xc28cff;
  if (labels.includes("identity")) return 0x8effc8;
  return 0x6db4ff;
}

const matCache = new Map();
function ballMat(color) {
  if (!matCache.has(color)) {
    matCache.set(color, new THREE.MeshStandardMaterial({
      color, emissive: new THREE.Color(color).multiplyScalar(0.18),
      roughness: 0.45, metalness: 0.25,
    }));
  }
  return matCache.get(color);
}
const ballMatHi = new THREE.MeshStandardMaterial({
  color: 0xfff2a8, emissive: 0x6a4f00, roughness: 0.35, metalness: 0.3,
});

const edgeMatFree = new THREE.LineBasicMaterial({
  color: 0x6da0ff, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending,
});
const edgeMatActivated = new THREE.LineBasicMaterial({
  color: 0xb29cff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
});
const edgeMatAimed = new THREE.LineBasicMaterial({
  color: 0xffd84a, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending,
});

export const world = new THREE.Group();
scene.add(world);

export const sceneNodes = []; // { id, label, labels, summary, base, mesh, mat, seed, hover }
export const sceneEdges = []; // { a, b, line, positions, attr }
export const nodeMeshById = new Map();

let targeted = null;

function fibonacciSphere(n) {
  const pts = new Array(n);
  const phi = Math.PI * (Math.sqrt(5) - 1);
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = phi * i;
    pts[i] = new THREE.Vector3(Math.cos(t) * r, y, Math.sin(t) * r);
  }
  return pts;
}

// Cheap force-directed placement: a few iterations of Fruchterman-Reingold
// in 3D, seeded from the Fibonacci layout so the result is reproducible.
// Polygon detection (Delaunay-on-projection) reads more meaningfully on a
// force layout because near-coplanar faces correspond to real cycles.
function forceDirected3D(payload) {
  const n = payload.nodes.length;
  const positions = fibonacciSphere(n).map(p => p.multiplyScalar(RADIUS));
  if (n < 2) return positions;

  const idIndex = new Map();
  payload.nodes.forEach((nd, i) => idIndex.set(nd.id, i));
  const adj = payload.edges
    .map(e => [idIndex.get(e.src), idIndex.get(e.dst)])
    .filter(([a, b]) => a !== undefined && b !== undefined && a !== b);

  const k = RADIUS * Math.cbrt(1 / Math.max(1, n)); // ideal edge length
  const ITER = 60;
  const disp = positions.map(() => new THREE.Vector3());

  for (let it = 0; it < ITER; it++) {
    for (const d of disp) d.set(0, 0, 0);
    // Repulsion (sampled — full O(n²) is fine at n ≤ 256 but this stays
    // cheap and looks identical for our purposes).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = positions[i].x - positions[j].x;
        const dy = positions[i].y - positions[j].y;
        const dz = positions[i].z - positions[j].z;
        let dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const fz = (dz / dist) * force;
        disp[i].x += fx; disp[i].y += fy; disp[i].z += fz;
        disp[j].x -= fx; disp[j].y -= fy; disp[j].z -= fz;
      }
    }
    // Attraction along edges.
    for (const [a, b] of adj) {
      const dx = positions[a].x - positions[b].x;
      const dy = positions[a].y - positions[b].y;
      const dz = positions[a].z - positions[b].z;
      let dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const fz = (dz / dist) * force;
      disp[a].x -= fx; disp[a].y -= fy; disp[a].z -= fz;
      disp[b].x += fx; disp[b].y += fy; disp[b].z += fz;
    }
    // Cool down + apply.
    const t = RADIUS * (1 - it / ITER) * 0.05;
    for (let i = 0; i < n; i++) {
      const m = Math.sqrt(disp[i].x ** 2 + disp[i].y ** 2 + disp[i].z ** 2) || 1;
      const cap = Math.min(m, t);
      positions[i].x += (disp[i].x / m) * cap;
      positions[i].y += (disp[i].y / m) * cap;
      positions[i].z += (disp[i].z / m) * cap;
    }
  }
  // Re-center and re-normalize so the cloud still fits the same volume.
  const center = positions.reduce(
    (acc, p) => { acc.x += p.x; acc.y += p.y; acc.z += p.z; return acc; },
    { x: 0, y: 0, z: 0 },
  );
  center.x /= n; center.y /= n; center.z /= n;
  for (const p of positions) { p.x -= center.x; p.y -= center.y; p.z -= center.z; }
  const maxR = positions.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y, p.z)), 0) || 1;
  const scale = RADIUS / maxR;
  for (const p of positions) { p.x *= scale; p.y *= scale; p.z *= scale; }
  return positions;
}

function placeNodes(payload, mode) {
  if (mode === "force3d") return forceDirected3D(payload);
  return fibonacciSphere(payload.nodes.length).map(p => p.multiplyScalar(RADIUS));
}

export function buildScene(payload, mode = "sphere") {
  for (const n of sceneNodes) world.remove(n.mesh);
  for (const e of sceneEdges) world.remove(e.line);
  sceneNodes.length = 0;
  sceneEdges.length = 0;
  nodeMeshById.clear();
  if (targeted) { targeted = null; }

  const positions = placeNodes(payload, mode);
  payload.nodes.forEach((nd, i) => {
    const base = positions[i].clone ? positions[i].clone() : new THREE.Vector3(positions[i].x, positions[i].y, positions[i].z);
    const mat = ballMat(colorForLabels(nd.labels || []));
    const mesh = new THREE.Mesh(ballGeom, mat);
    mesh.position.copy(base);
    mesh.scale.setScalar(BALL_R);
    const seed = i * 0.137;
    const node = { ...nd, base, mesh, mat, seed, hover: false };
    mesh.userData.node = node;
    world.add(mesh);
    sceneNodes.push(node);
    nodeMeshById.set(nd.id, node);
  });

  const nodeById = new Map(sceneNodes.map(n => [n.id, n]));
  for (const ed of payload.edges) {
    const a = nodeById.get(ed.src);
    const b = nodeById.get(ed.dst);
    if (!a || !b) continue;
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(6);
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const line = new THREE.Line(geom, edgeMatFree);
    world.add(line);
    sceneEdges.push({ a, b, line, positions, attr: geom.attributes.position, srcId: ed.src, dstId: ed.dst, type: ed.type, state: "free" });
  }
}

export function setEdgeStates(stateByEdgeKey) {
  // edgeKey = "minId|maxId". Default = free.
  for (const e of sceneEdges) {
    const key = e.srcId < e.dstId ? `${e.srcId}|${e.dstId}` : `${e.dstId}|${e.srcId}`;
    const want = stateByEdgeKey.get(key) || "free";
    if (want === e.state) continue;
    e.state = want;
    e.line.material = want === "aimed" ? edgeMatAimed : want === "activated" ? edgeMatActivated : edgeMatFree;
  }
}

export function undulate(t) {
  for (const n of sceneNodes) {
    const b = n.base;
    const s = n.seed;
    n.mesh.position.x = b.x + AMP * Math.sin(t * FREQ + b.y * 0.05 + s);
    n.mesh.position.y = b.y + AMP * Math.sin(t * FREQ * 1.13 + b.z * 0.05 + s * 1.7);
    n.mesh.position.z = b.z + AMP * Math.sin(t * FREQ * 0.91 + b.x * 0.05 + s * 2.3);
  }
  for (const e of sceneEdges) {
    const p = e.positions;
    const a = e.a.mesh.position, b = e.b.mesh.position;
    p[0] = a.x; p[1] = a.y; p[2] = a.z;
    p[3] = b.x; p[4] = b.y; p[5] = b.z;
    e.attr.needsUpdate = true;
  }
}

// --- Pointer state shared with polygons.js -------------------------------
export const raycaster = new THREE.Raycaster();
raycaster.params.Line = { threshold: 6 };
export const pointer = new THREE.Vector2();
export const pointerState = { active: false, dragging: false, downAt: 0, downX: 0, downY: 0 };

function setPointerFromEvent(ev) {
  // The `#scene` canvas may not cover the panel area; clamp the rect to the
  // visible canvas surface.
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) / rect.width;
  const y = (ev.clientY - rect.top) / rect.height;
  pointer.set(x * 2 - 1, -(y * 2 - 1));
  pointerState.active = true;
}
canvas.addEventListener("pointermove", setPointerFromEvent);
canvas.addEventListener("pointerdown", (ev) => {
  setPointerFromEvent(ev);
  pointerState.downAt = performance.now();
  pointerState.downX = ev.clientX;
  pointerState.downY = ev.clientY;
  pointerState.dragging = false;
});
canvas.addEventListener("pointermove", (ev) => {
  if (pointerState.downAt && !pointerState.dragging) {
    const dx = ev.clientX - pointerState.downX;
    const dy = ev.clientY - pointerState.downY;
    if (dx * dx + dy * dy > 16) pointerState.dragging = true;
  }
});
canvas.addEventListener("pointerup", () => {
  pointerState.downAt = 0;
});
canvas.addEventListener("pointerleave", () => {
  pointerState.active = false;
  pointerState.downAt = 0;
});

export function pickNode() {
  if (!pointerState.active || sceneNodes.length === 0) return null;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(sceneNodes.map(n => n.mesh), false);
  return hits.length ? hits[0].object.userData.node : null;
}

export function setTargetedNode(next) {
  if (next === targeted) return;
  if (targeted) {
    targeted.hover = false;
    targeted.mesh.material = targeted.mat;
    targeted.mesh.scale.setScalar(BALL_R);
  }
  targeted = next;
  if (targeted) {
    targeted.hover = true;
    targeted.mesh.material = ballMatHi;
    targeted.mesh.scale.setScalar(BALL_R * 1.45);
  }
}
export function getTargetedNode() { return targeted; }

// --- Resize ---------------------------------------------------------------
export function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// --- Frame loop hook -----------------------------------------------------
export function tickWorld(t) {
  world.rotation.y = t * 0.04;
  world.rotation.x = Math.sin(t * 0.07) * 0.08;
  if (starsRef.value) starsRef.value.rotation.y = t * 0.005;
  undulate(t);
}

// Allow the right-panel "layout" knob to swap layouts without a full reload.
subscribe("panels", (panels) => {
  const want = panels.control.layoutMode;
  if (!want) return;
  const current = get("viewport").layoutMode;
  if (want !== current) {
    const payload = { nodes: get("graph").nodes, edges: get("graph").edges };
    if (payload.nodes.length) {
      buildScene(payload, want);
      get("viewport").layoutMode = want;
    }
  }
});
