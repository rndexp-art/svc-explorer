// Entry point. Wires modules together, owns the rAF loop, handles boot.

import * as THREE from "three";
import { renderer, scene, camera, controls, sceneNodes, buildScene, tickWorld, pickNode, setTargetedNode } from "./scene.js";
import { tickPolygons } from "./polygons.js";
import { tickShell } from "./shell.js";
import { tickHud, refreshGraph } from "./panels.js";
import { get, subscribe, setStatus } from "./store.js";

// Keep the WebGL renderer in lockstep with the layout swap from the right
// panel: when a new graph payload lands, build the scene with the current
// layout mode.
subscribe("graph", () => {
  const layout = get("panels").control.layoutMode || "sphere";
  buildScene({ nodes: get("graph").nodes, edges: get("graph").edges }, layout);
  get("viewport").layoutMode = layout;
});

// Search → "fly the camera target to this node".
window.addEventListener("explorer:fly-to", (ev) => {
  const id = ev.detail?.id;
  const node = sceneNodes.find(n => n.id === id);
  if (!node) return;
  // Ease the OrbitControls target. We do a simple linear tween over 400 ms.
  const start = controls.target.clone();
  const end = node.mesh.position.clone();
  const startPos = camera.position.clone();
  const camDir = camera.position.clone().sub(controls.target).normalize();
  const desiredDist = 90;
  const endPos = end.clone().add(camDir.multiplyScalar(desiredDist));
  const t0 = performance.now();
  const DURATION = 400;
  function step() {
    const t = Math.min(1, (performance.now() - t0) / DURATION);
    const e = 1 - Math.pow(1 - t, 3);
    controls.target.lerpVectors(start, end, e);
    camera.position.lerpVectors(startPos, endPos, e);
    if (t < 1) requestAnimationFrame(step);
  }
  step();
});

const clock = new THREE.Clock();

function tick() {
  const t = clock.getElapsedTime();
  tickWorld(t);

  // Node hover wins over polygon aim — pick the node first.
  const node = pickNode();
  setTargetedNode(node);
  tickHud();

  tickPolygons();
  tickShell();

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

(async function boot() {
  try {
    await refreshGraph();
    requestAnimationFrame(tick);
  } catch (e) {
    console.error(e);
    setStatus(String(e.message || e), "error");
  }
})();
