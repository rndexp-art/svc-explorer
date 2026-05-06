// Polygon detection + state machine.
//
// Detection is **client-side 2D Delaunay over visible nodes, filtered to
// triangles whose three edges exist in the graph** (per design §5). It runs
// when the camera changes (cheap at N ≤ 256) and emits a stable list of
// canonical Polygon objects. State transitions:
//
//   transparent → aimed     (hover empty area between three connected balls)
//   aimed       → activated (click; 200 ms long-press on touch)
//   activated   → transparent (× on shell screen, handled in shell.js)
//
// The aimed mesh is rendered in-world; activated polygons are removed from
// the in-world list and handed to the shell layer.

import * as THREE from "three";
import { Delaunay } from "https://esm.sh/d3-delaunay@6.0.4";
import {
  camera, world, sceneNodes, raycaster, pointer, pointerState,
  setEdgeStates,
} from "./scene.js";
import { hasEdge, get, aimPolygon, activatePolygon, subscribe } from "./store.js";

const AIM_OPACITY = 0.55;
const PROXY_OPACITY = 0.001; // visible: true so raycaster picks it up

const aimedMaterial = new THREE.MeshBasicMaterial({
  color: 0xffd84a, transparent: true, opacity: AIM_OPACITY,
  side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
});
const proxyMaterial = new THREE.MeshBasicMaterial({
  color: 0xffd84a, transparent: true, opacity: PROXY_OPACITY,
  side: THREE.DoubleSide, depthWrite: false,
});

const polygonsGroup = new THREE.Group();
world.add(polygonsGroup);

const overlayHost = document.getElementById("polygon-overlay-host");

// One mesh per polygon. Created lazily, reused across detection runs when
// the polygonId is unchanged so we don't allocate every frame.
const meshById = new Map(); // polygonId -> { mesh, geom, polygon }

const _v3 = new THREE.Vector3();
const _projVec = new THREE.Vector3();

let lastDetectionCameraSig = "";
let lastDetectionAt = 0;

function projectToScreen(pos3) {
  _projVec.copy(pos3).project(camera);
  return {
    x: (_projVec.x * 0.5 + 0.5) * window.innerWidth,
    y: (-_projVec.y * 0.5 + 0.5) * window.innerHeight,
    z: _projVec.z,
  };
}

function cameraSig() {
  // Camera position + target; cheap to compute, stable across small jitter.
  const p = camera.position;
  return `${p.x.toFixed(1)}|${p.y.toFixed(1)}|${p.z.toFixed(1)}|${camera.fov}|${window.innerWidth}x${window.innerHeight}`;
}

function canonicalPolygonId(ids) {
  return [...ids].sort().join("·");
}

export function detectPolygons() {
  const now = performance.now();
  if (now - lastDetectionAt < 250) return; // throttle: 4 Hz is plenty
  const sig = cameraSig();
  if (sig === lastDetectionCameraSig) return;
  lastDetectionAt = now;
  lastDetectionCameraSig = sig;

  if (sceneNodes.length < 3) {
    syncMeshes([]);
    return;
  }

  // Only consider nodes in front of the camera; behind-camera projections
  // alias and produce phantom triangles.
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const camPos = camera.position;

  const visible = [];
  const screen = [];
  for (const n of sceneNodes) {
    _v3.copy(n.mesh.position).sub(camPos);
    if (_v3.dot(forward) <= 0) continue;
    const s = projectToScreen(n.mesh.position);
    if (s.z < -1 || s.z > 1) continue;
    visible.push(n);
    screen.push([s.x, s.y]);
  }
  if (visible.length < 3) {
    syncMeshes([]);
    return;
  }

  const delaunay = Delaunay.from(screen);
  const tris = delaunay.triangles; // Uint32Array, length 3T

  const polygons = [];
  const seen = new Set();
  for (let i = 0; i < tris.length; i += 3) {
    const a = visible[tris[i]];
    const b = visible[tris[i + 1]];
    const c = visible[tris[i + 2]];
    if (!hasEdge(a.id, b.id) || !hasEdge(b.id, c.id) || !hasEdge(a.id, c.id)) continue;
    const id = canonicalPolygonId([a.id, b.id, c.id]);
    if (seen.has(id)) continue;
    seen.add(id);
    polygons.push({
      id,
      kind: "triangle",
      vertexIds: [a.id, b.id, c.id],
      vertices: [a, b, c],
      edgeKeys: [
        a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`,
        b.id < c.id ? `${b.id}|${c.id}` : `${c.id}|${b.id}`,
        a.id < c.id ? `${a.id}|${c.id}` : `${c.id}|${a.id}`,
      ],
      perimeter:
        a.mesh.position.distanceTo(b.mesh.position) +
        b.mesh.position.distanceTo(c.mesh.position) +
        a.mesh.position.distanceTo(c.mesh.position),
    });
  }

  // Skip polygons that are currently activated (the shell owns them).
  const activated = get("polygons").activated;
  const inWorld = polygons.filter(p => !activated.has(p.id));

  get("polygons").all = polygons;
  syncMeshes(inWorld);
}

function syncMeshes(polygons) {
  const wantIds = new Set(polygons.map(p => p.id));
  // Drop meshes for polygons no longer in the in-world list.
  for (const [id, entry] of meshById) {
    if (!wantIds.has(id)) {
      polygonsGroup.remove(entry.mesh);
      entry.geom.dispose();
      meshById.delete(id);
    }
  }
  // Add or refresh meshes for current polygons.
  for (const p of polygons) {
    let entry = meshById.get(p.id);
    if (!entry) {
      const geom = new THREE.BufferGeometry();
      const pos = new Float32Array(9);
      geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mesh = new THREE.Mesh(geom, proxyMaterial);
      mesh.userData.polygon = p;
      polygonsGroup.add(mesh);
      entry = { mesh, geom, polygon: p };
      meshById.set(p.id, entry);
    }
    entry.polygon = p;
    entry.mesh.userData.polygon = p;
  }
}

function refreshMeshGeometry() {
  // Triangle vertex positions follow the undulating balls — needs a refresh
  // every frame, not just on detection.
  for (const { mesh, polygon } of meshById.values()) {
    const pos = mesh.geometry.attributes.position.array;
    const v = polygon.vertices;
    pos[0] = v[0].mesh.position.x; pos[1] = v[0].mesh.position.y; pos[2] = v[0].mesh.position.z;
    pos[3] = v[1].mesh.position.x; pos[4] = v[1].mesh.position.y; pos[5] = v[1].mesh.position.z;
    pos[6] = v[2].mesh.position.x; pos[7] = v[2].mesh.position.y; pos[8] = v[2].mesh.position.z;
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
  }
}

export function pickPolygon() {
  if (!pointerState.active || meshById.size === 0) return null;
  raycaster.setFromCamera(pointer, camera);
  const meshes = [];
  for (const { mesh } of meshById.values()) meshes.push(mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length ? hits[0].object.userData.polygon : null;
}

export function applyAimedState(aimedId) {
  for (const { mesh, polygon } of meshById.values()) {
    const isAimed = polygon.id === aimedId;
    mesh.material = isAimed ? aimedMaterial : proxyMaterial;
  }
  // Drive edge colors so the three edges of the aimed polygon glow.
  const stateByEdge = new Map();
  if (aimedId) {
    const p = meshById.get(aimedId)?.polygon;
    if (p) for (const k of p.edgeKeys) stateByEdge.set(k, "aimed");
  }
  for (const screen of get("polygons").activated.values()) {
    for (const k of screen.polygon.edgeKeys) {
      if (!stateByEdge.has(k)) stateByEdge.set(k, "activated");
    }
  }
  setEdgeStates(stateByEdge);
}

// --- Aimed overlay (in-world HTML card on the centroid) ------------------
let overlayEl = null;
function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.className = "polygon-overlay aimed";
  overlayEl.setAttribute("role", "tooltip");
  overlayHost.appendChild(overlayEl);
  return overlayEl;
}

function renderOverlayContent(p) {
  const labels = p.vertices.map(v => v.label || "(unnamed)");
  const labelSets = p.vertices.map(v => new Set(v.labels || []));
  const intersect = [...labelSets[0]].filter(l => labelSets[1].has(l) && labelSets[2].has(l));
  const tag = intersect.length ? intersect.join("·") : "polygon";

  const noteVerts = p.vertices.filter(v => (v.labels || []).includes("note") && v.created_at);
  let timeBand = "";
  if (noteVerts.length >= 2) {
    const ts = noteVerts.map(v => new Date(v.created_at).getTime()).sort((a, b) => a - b);
    const span = ts[ts.length - 1] - ts[0];
    timeBand = `<div class="overlay-time">${formatSpan(span)}</div>`;
  }

  const edgeTypes = new Set();
  for (const e of get("graph").edges) {
    const k = e.src < e.dst ? `${e.src}|${e.dst}` : `${e.dst}|${e.src}`;
    if (p.edgeKeys.includes(k)) edgeTypes.add(e.type);
  }

  ensureOverlay().innerHTML = `
    <div class="overlay-tag">${escapeHtml(tag)}</div>
    <div class="overlay-vertices">${labels.map(escapeHtml).map(l => `<span>${l}</span>`).join("")}</div>
    <div class="overlay-edges">${[...edgeTypes].map(escapeHtml).map(t => `<span class="chip">${t}</span>`).join("")}</div>
    ${timeBand}
    <div class="overlay-hint">click to pin · esc to cancel</div>
  `;
}

function formatSpan(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s span`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m span`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h span`;
  return `${Math.round(ms / 86_400_000)}d span`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function positionOverlay(aimedId) {
  if (!overlayEl) return;
  if (!aimedId) {
    overlayEl.classList.remove("visible");
    return;
  }
  const entry = meshById.get(aimedId);
  if (!entry) {
    overlayEl.classList.remove("visible");
    return;
  }
  const v = entry.polygon.vertices;
  const cx = (v[0].mesh.position.x + v[1].mesh.position.x + v[2].mesh.position.x) / 3;
  const cy = (v[0].mesh.position.y + v[1].mesh.position.y + v[2].mesh.position.y) / 3;
  const cz = (v[0].mesh.position.z + v[1].mesh.position.z + v[2].mesh.position.z) / 3;
  const s = projectToScreen(new THREE.Vector3(cx, cy, cz));
  overlayEl.style.left = s.x + "px";
  overlayEl.style.top = s.y + "px";
  overlayEl.classList.add("visible");
}

// --- Per-frame entry points (called from main tick loop) -----------------
export function tickPolygons() {
  detectPolygons();
  refreshMeshGeometry();

  const targetedNodeHit = !!document.querySelector("#hud.visible"); // node win
  let aimedId = null;
  if (!pointerState.dragging && !targetedNodeHit) {
    const p = pickPolygon();
    if (p) aimedId = p.id;
  }

  if (aimedId !== get("polygons").aimedId) {
    aimPolygon(aimedId);
    if (aimedId) renderOverlayContent(meshById.get(aimedId).polygon);
  }
  applyAimedState(aimedId);
  positionOverlay(aimedId);
}

// Click on the aimed polygon → activate.
window.addEventListener("pointerup", (ev) => {
  if (pointerState.dragging) return;
  const aimedId = get("polygons").aimedId;
  if (!aimedId) return;
  // Was the pointer up on the canvas (not on a panel)?
  const target = document.elementFromPoint(ev.clientX, ev.clientY);
  if (!target || target.closest(".hud-panel")) return;
  const entry = meshById.get(aimedId);
  if (!entry) return;
  activatePolygon(entry.polygon);
  // Removed-from-world: drop the in-world mesh; shell.js will pick it up.
  polygonsGroup.remove(entry.mesh);
  entry.geom.dispose();
  meshById.delete(aimedId);
  applyAimedState(null);
  positionOverlay(null);
});

// Esc cancels aim; Enter activates.
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    aimPolygon(null);
    applyAimedState(null);
    positionOverlay(null);
  } else if (ev.key === "Enter") {
    const aimedId = get("polygons").aimedId;
    if (!aimedId) return;
    const entry = meshById.get(aimedId);
    if (!entry) return;
    activatePolygon(entry.polygon);
    polygonsGroup.remove(entry.mesh);
    entry.geom.dispose();
    meshById.delete(aimedId);
    applyAimedState(null);
    positionOverlay(null);
  }
});

// On graph payload swap, drop everything — vertex identities are stable
// across rebuilds in our case but the mesh proxies reference old node
// objects, so a clean slate is simpler.
subscribe("graph", () => {
  for (const [id, entry] of meshById) {
    polygonsGroup.remove(entry.mesh);
    entry.geom.dispose();
    meshById.delete(id);
  }
  lastDetectionCameraSig = "";
});

export function getInWorldPolygonMeshes() { return meshById; }
