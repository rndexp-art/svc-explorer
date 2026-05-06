// Polygonal eggshell — cracked-glass band of cells around the central
// graph void.
//
// The band is populated from the moment the page loads: walking clockwise
// from the top-left corner along the outer green frame, we lay down N
// quadrilateral cells (varying sizes), each sharing edges with its
// neighbours. The inner edges, taken together, form the irregular purple
// contour separating the band from the live graph window.
//
// A handful of cells are *anchor cells* — they host real chrome (search,
// composer, dashboard counters, control sliders). The rest are *decorative
// cells* that render data-derived placeholder content (mini-sparkline, edge
// chips, icon row, etc.) so the band looks alive even with zero
// activations.
//
// When the user activates a graph polygon, we promote it into the band by
// taking over one of the decorative cells nearest the polygon's screen
// angle.

import * as THREE from "three";
import { camera, scene } from "./scene.js";
import { get, subscribe, deactivatePolygon } from "./store.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

// ----- Frame / contour element handles ----------------------------------
const frameRect = document.getElementById("frame-rect");
const frameAnchors = {
  tl: document.getElementById("anchor-tl"),
  tr: document.getElementById("anchor-tr"),
  bl: document.getElementById("anchor-bl"),
  br: document.getElementById("anchor-br"),
};
const contourPath = document.getElementById("frame-contour");
const shellLayer = document.getElementById("shell-layer");

// ----- Tunables ---------------------------------------------------------
const FRAME_INSET = 4;           // px the green frame is pulled in from the viewport
const SHELL_THICKNESS = 130;     // px of band thickness (cell depth toward center)
const TARGET_CELL_PERIM = 140;   // each cell ≈ this much outer-edge perimeter
const MIN_CELLS = 18;            // never fewer than this so the band reads as cracked
const MAX_CELLS = 36;            // upper bound to keep DOM small
const INNER_JITTER = 0.35;       // 0 → smooth ring; 1 → very cracked

// ----- Data -------------------------------------------------------------
let outerRect = { x: 0, y: 0, w: 0, h: 0 };
let cells = []; // { id, role, slot, vertices[{x,y}], outer:[2 pts], inner:[2 pts] }
let cellElByRole = new Map();   // role -> { g, fo, content }; for fast lookup
let teleportSlots = new Map();  // role -> DOM container we teleported chrome into
const _v3 = new THREE.Vector3();

// ----- Tether lines (Three.js) ------------------------------------------
const tetherGroup = new THREE.Group();
scene.add(tetherGroup);
const tetherMaterial = new THREE.LineBasicMaterial({
  color: 0xb29cff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
});
const tetherByPolygon = new Map();

// =========================================================================
//  Eggshell layout
// =========================================================================

function recomputeOuterRect() {
  // The eggshell band fills the entire viewport perimeter — the rectangular
  // CSS panels are gone, so the outer rect is the viewport with just a few
  // pixels of inset to keep the green frame stroke crisp.
  const W = window.innerWidth;
  const H = window.innerHeight;
  outerRect = {
    x: FRAME_INSET,
    y: FRAME_INSET,
    w: Math.max(80, W - FRAME_INSET * 2),
    h: Math.max(80, H - FRAME_INSET * 2),
  };
  if (frameRect) {
    frameRect.setAttribute("x", outerRect.x + 0.5);
    frameRect.setAttribute("y", outerRect.y + 0.5);
    frameRect.setAttribute("width", Math.max(0, outerRect.w - 1));
    frameRect.setAttribute("height", Math.max(0, outerRect.h - 1));
  }
  const corners = {
    tl: [outerRect.x, outerRect.y],
    tr: [outerRect.x + outerRect.w, outerRect.y],
    bl: [outerRect.x, outerRect.y + outerRect.h],
    br: [outerRect.x + outerRect.w, outerRect.y + outerRect.h],
  };
  for (const [k, [x, y]] of Object.entries(corners)) {
    if (frameAnchors[k]) {
      frameAnchors[k].setAttribute("cx", x);
      frameAnchors[k].setAttribute("cy", y);
    }
  }
}

// Walk the outer rectangle perimeter. t in [0, 1) clockwise from top-left.
function pointOnOuter(t) {
  const r = outerRect;
  t = ((t % 1) + 1) % 1;
  const W = r.w, H = r.h;
  const perim = 2 * (W + H);
  let d = t * perim;
  if (d <= W) return { x: r.x + d, y: r.y, side: "top" };
  d -= W;
  if (d <= H) return { x: r.x + W, y: r.y + d, side: "right" };
  d -= H;
  if (d <= W) return { x: r.x + W - d, y: r.y + H, side: "bottom" };
  d -= H;
  return { x: r.x, y: r.y + H - d, side: "left" };
}

// Map an outer-perimeter t to its inward normal (unit vector pointing toward
// the band's interior). Used to project the inner edge.
function inwardNormal(t) {
  const r = outerRect;
  t = ((t % 1) + 1) % 1;
  const W = r.w, H = r.h;
  const perim = 2 * (W + H);
  let d = t * perim;
  if (d <= W) return { x: 0, y: 1 };       // top → down
  d -= W;
  if (d <= H) return { x: -1, y: 0 };      // right → left
  d -= H;
  if (d <= W) return { x: 0, y: -1 };      // bottom → up
  return { x: 1, y: 0 };                   // left → right
}

// Side of the outer rectangle at parametric t.
function sideAtT(t) {
  return pointOnOuter(t).side;
}

// Stable jitter per t (so resize doesn't re-randomize the eggshell).
function seedRand(seedKey) {
  let h = 2166136261;
  for (let i = 0; i < seedKey.length; i++) {
    h ^= seedKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCells() {
  const r = outerRect;
  const perim = 2 * (r.w + r.h);
  const rawCount = Math.round(perim / TARGET_CELL_PERIM);
  const N = Math.max(MIN_CELLS, Math.min(MAX_CELLS, rawCount));

  // Cell boundary t-values. Always include the four side-center anchors so
  // we can reserve those cells for functional widgets, and the four corners
  // so cell edges land cleanly on them (each cell stays on one side of the
  // rect).
  const tCornerTR = r.w / perim;
  const tCornerBR = (r.w + r.h) / perim;
  const tCornerBL = (r.w + r.h + r.w) / perim;
  const tCenterTop = (r.w / 2) / perim;
  const tCenterRight = (r.w + r.h / 2) / perim;
  const tCenterBottom = (r.w + r.h + r.w / 2) / perim;
  const tCenterLeft = (r.w + r.h + r.w + r.h / 2) / perim;

  const anchorTs = new Map([
    [tCenterTop, "search"],
    [tCenterRight, "control"],
    [tCenterBottom, "composer"],
    [tCenterLeft, "dashboard"],
  ]);

  // Cell boundaries: four corners + two cuts straddling each anchor center
  // so the anchor cell ends up wide enough to host a real widget. The cuts
  // sit ~3% on either side of the anchor's t.
  const ANCHOR_HALF_WIDTH = 0.04;
  const tValues = new Set([0, tCornerTR, tCornerBR, tCornerBL]);
  for (const t of anchorTs.keys()) {
    tValues.add(((t - ANCHOR_HALF_WIDTH) + 1) % 1);
    tValues.add(((t + ANCHOR_HALF_WIDTH) + 1) % 1);
  }
  const sorted = [...tValues].sort((a, b) => a - b);
  // Walk gaps and subdivide if they're > TARGET_CELL_PERIM / perim.
  const gapTarget = TARGET_CELL_PERIM / perim;
  const expanded = [];
  for (let i = 0; i < sorted.length; i++) {
    expanded.push(sorted[i]);
    const next = sorted[(i + 1) % sorted.length];
    let gap = next - sorted[i];
    if (i === sorted.length - 1) gap = (1 - sorted[i]) + sorted[0];
    if (gap > gapTarget * 1.6) {
      const sub = Math.max(1, Math.floor(gap / gapTarget) - 1);
      for (let s = 1; s <= sub; s++) {
        const t = sorted[i] + (gap * s) / (sub + 1);
        expanded.push(((t % 1) + 1) % 1);
      }
    }
  }
  expanded.sort((a, b) => a - b);
  // Append the wrap-around terminator.
  const finalTs = [...new Set(expanded.map(t => +t.toFixed(5)))];
  finalTs.push(finalTs[0] + 1);

  cells = [];
  for (let i = 0; i < finalTs.length - 1; i++) {
    const tA = finalTs[i];
    const tB = finalTs[i + 1];
    const tMid = (tA + tB) / 2;
    const outerPts = outerWalk(tA, tB);

    // Shared inner endpoints — adjacent cells must hit the same inner point
    // at a shared boundary t, otherwise the contour and cell-pair share-edge
    // both break. Seed by t only.
    const innerStart = innerPoint(tA);
    const innerEnd = innerPoint(tB);
    // Mid waypoint adds the cracked feel without breaking sharing.
    const innerMid = (tB - tA) > 0.012 ? innerPointMid(tMid) : null;

    const innerEdge = innerMid
      ? [innerEnd, innerMid, innerStart]
      : [innerEnd, innerStart];
    const vertices = [...outerPts, ...innerEdge];

    cells.push({
      id: `cell-${i}`,
      role: "deco",
      slot: `deco-${i}`,
      vertices,
      outerStart: outerPts[0],
      outerEnd: outerPts[outerPts.length - 1],
      innerStart, innerEnd, innerMid,
      tStart: tA, tEnd: tB,
      tMid,
      side: sideAtT(tMid),
    });
  }

  // Assign each anchor role to the single cell whose midpoint is closest to
  // the anchor's t (with wrap-around). Guarantees one cell per role.
  for (const [t, role] of anchorTs) {
    let best = null, bestD = Infinity;
    for (const c of cells) {
      const d = Math.min(Math.abs(c.tMid - t), 1 - Math.abs(c.tMid - t));
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) { best.role = role; best.slot = null; }
  }
}

function outerWalk(tStart, tEnd) {
  const pts = [pointOnOuter(tStart)];
  const r = outerRect;
  const perim = 2 * (r.w + r.h);
  // t-positions of corners (after top-left at 0):
  const corners = [r.w / perim, (r.w + r.h) / perim, (r.w + r.h + r.w) / perim, 1];
  for (const cT of corners) {
    if (cT > tStart + 1e-6 && cT < tEnd - 1e-6) {
      pts.push(pointOnOuter(cT));
    }
    if (cT - 1 > tStart + 1e-6 && cT - 1 < tEnd - 1e-6) {
      pts.push(pointOnOuter(cT - 1));
    }
  }
  pts.push(pointOnOuter(tEnd));
  return pts;
}

function innerPoint(t) {
  // Endpoint shared between adjacent cells — seed by t alone so both cells
  // compute the same point.
  const outer = pointOnOuter(t);
  const n = inwardNormal(t);
  const rng = seedRand(`endpt|${t.toFixed(5)}`);
  const offset = SHELL_THICKNESS * (1 + (rng() - 0.5) * INNER_JITTER);
  return { x: outer.x + n.x * offset, y: outer.y + n.y * offset };
}

function innerPointMid(t) {
  // Per-cell mid waypoint — different jitter is fine here, only this cell
  // sees this point.
  const outer = pointOnOuter(t);
  const n = inwardNormal(t);
  const rng = seedRand(`mid|${t.toFixed(5)}`);
  const offset = SHELL_THICKNESS * (1 + (rng() - 0.5) * INNER_JITTER);
  return { x: outer.x + n.x * offset, y: outer.y + n.y * offset };
}

// =========================================================================
//  DOM rendering
// =========================================================================

function pointsAttr(points) {
  return points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function ensureCellEl(cell) {
  let el = cellElByRole.get(cell.id);
  if (el) return el;
  const g = document.createElementNS(SVG_NS, "g");
  g.classList.add("eggshell-cell");
  g.dataset.role = cell.role;
  g.dataset.id = cell.id;

  const fill = document.createElementNS(SVG_NS, "polygon");
  fill.classList.add("eggshell-fill");
  g.appendChild(fill);

  const stroke = document.createElementNS(SVG_NS, "polygon");
  stroke.classList.add("eggshell-stroke");
  g.appendChild(stroke);

  const fo = document.createElementNS(SVG_NS, "foreignObject");
  fo.classList.add("eggshell-fo");
  const div = document.createElementNS(XHTML_NS, "div");
  div.classList.add("eggshell-content");
  div.dataset.role = cell.role;
  fo.appendChild(div);
  g.appendChild(fo);

  shellLayer.appendChild(g);
  el = { g, fill, stroke, fo, content: div };
  cellElByRole.set(cell.id, el);
  return el;
}

// Place the foreignObject inside the cell's bounding box, inset slightly so
// content doesn't kiss the stroke. Triangular cells get less inset since
// they're already small.
function fitFo(fo, vertices) {
  const xs = vertices.map(p => p.x);
  const ys = vertices.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const PAD = 6;
  fo.setAttribute("x", minX + PAD);
  fo.setAttribute("y", minY + PAD);
  fo.setAttribute("width", Math.max(0, maxX - minX - PAD * 2));
  fo.setAttribute("height", Math.max(0, maxY - minY - PAD * 2));
}

function renderCells() {
  const seenIds = new Set();
  for (const cell of cells) {
    seenIds.add(cell.id);
    const el = ensureCellEl(cell);
    el.g.dataset.role = cell.role;
    el.g.dataset.side = cell.side;
    el.g.classList.toggle("anchor", isAnchorRole(cell.role));
    el.g.classList.toggle("activated", cell.role.startsWith("activated:"));
    const points = pointsAttr(cell.vertices);
    el.fill.setAttribute("points", points);
    el.stroke.setAttribute("points", points);
    fitFo(el.fo, cell.vertices);
    renderCellContent(cell, el);
  }
  // Drop cells that are no longer in the layout.
  for (const [id, el] of cellElByRole) {
    if (!seenIds.has(id)) {
      el.g.remove();
      cellElByRole.delete(id);
    }
  }
}

function isAnchorRole(role) {
  return ["search", "composer", "dashboard", "control"].includes(role);
}

// ---- Per-role content rendering ---------------------------------------

function renderCellContent(cell, el) {
  const role = cell.role;
  if (isAnchorRole(role)) {
    // Move the chrome's host element inside the cell's foreignObject (and
    // avoid duplicate moves on subsequent renders).
    const hostId = `${role}-panel-host`;
    const host = document.getElementById(hostId);
    if (host && host.parentElement !== el.content) {
      el.content.innerHTML = "";
      el.content.appendChild(host);
      host.classList.add("teleported");
    }
    teleportSlots.set(role, el.content);
    return;
  }
  if (role.startsWith("activated:")) {
    const polygonId = role.slice("activated:".length);
    const screen = get("polygons").activated.get(polygonId);
    if (!screen) { el.content.innerHTML = "<div class=\"placeholder\">…</div>"; return; }
    el.content.innerHTML = activatedCellHtml(screen);
    return;
  }
  // Decorative cells: deterministic content from the slot id so it's
  // stable across re-renders.
  el.content.innerHTML = decorativeHtml(cell);
}

function decorativeHtml(cell) {
  const rng = seedRand(cell.slot || cell.id);
  const kinds = ["sparkline", "hexes", "slider", "chiprow", "donut", "icons", "labelpair"];
  const kind = kinds[Math.floor(rng() * kinds.length)];
  switch (kind) {
    case "sparkline": return decoSparkline(rng);
    case "hexes":     return decoHexes(rng);
    case "slider":    return decoSlider(rng);
    case "chiprow":   return decoChipRow(rng);
    case "donut":     return decoDonut(rng);
    case "icons":     return decoIcons(rng);
    case "labelpair": return decoLabelPair(rng);
  }
  return "";
}

function decoSparkline(rng) {
  const N = 14, W = 80, H = 24;
  const ys = Array.from({ length: N }, () => rng());
  const max = Math.max(...ys);
  let path = "";
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * W;
    const y = H - (ys[i] / max) * (H - 2);
    path += (i === 0 ? "M" : " L") + x.toFixed(1) + "," + y.toFixed(1);
  }
  return `<svg class="deco-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${path}" /></svg>
          <div class="deco-label">${randomKey(rng)}</div>`;
}

function decoHexes(rng) {
  const cells = [];
  for (let i = 0; i < 6; i++) {
    const lit = rng() > 0.55;
    cells.push(`<span class="hex ${lit ? "lit" : ""}"></span>`);
  }
  return `<div class="deco-hex-grid">${cells.join("")}</div><div class="deco-label">${randomKey(rng)}</div>`;
}

function decoSlider(rng) {
  const v = Math.round(rng() * 100);
  return `<div class="deco-slider">
            <span class="bar"><span style="width:${v}%"></span></span>
            <span class="val">${v}</span>
          </div>
          <div class="deco-label">${randomKey(rng)}</div>`;
}

function decoChipRow(rng) {
  const types = ["agent", "source", "note", "identity", "provider", "chained", "owner", "author"];
  const out = [];
  for (let i = 0; i < 3; i++) out.push(`<span class="chip">${types[Math.floor(rng() * types.length)]}</span>`);
  return `<div class="deco-chips">${out.join("")}</div>`;
}

function decoDonut(rng) {
  const pct = Math.round(rng() * 100);
  const c = 2 * Math.PI * 10;
  return `<svg class="deco-svg deco-donut" viewBox="0 0 28 28">
            <circle cx="14" cy="14" r="10" class="bg" />
            <circle cx="14" cy="14" r="10" class="fg" stroke-dasharray="${(c * pct / 100).toFixed(1)} ${c.toFixed(1)}" />
          </svg>
          <div class="deco-label">${pct}%</div>`;
}

function decoIcons(rng) {
  const glyphs = ["◆", "◇", "▲", "△", "▼", "○", "◉", "◐", "◑"];
  const row = [];
  for (let i = 0; i < 5; i++) row.push(`<span class="ic">${glyphs[Math.floor(rng() * glyphs.length)]}</span>`);
  return `<div class="deco-icons">${row.join("")}</div>`;
}

function decoLabelPair(rng) {
  const keys = ["uplink", "checksum", "drift", "phase", "epoch", "stride", "vert", "lattice"];
  const k = keys[Math.floor(rng() * keys.length)];
  const v = (rng() * 1000).toFixed(0);
  return `<div class="deco-kv"><span>${k}</span><b>${v}</b></div>`;
}

function randomKey(rng) {
  const choices = ["nodes", "edges", "phase", "drift", "epoch", "uplink", "tick", "freq"];
  return choices[Math.floor(rng() * choices.length)];
}

function activatedCellHtml(screen) {
  const p = screen.polygon;
  const labels = p.vertices.map(v => v.label || "(unnamed)");
  const tag = inferTag(p);
  const noteVerts = p.vertices.filter(v => (v.labels || []).includes("note") && v.created_at);
  let timebar = "";
  if (noteVerts.length >= 2) {
    const ts = noteVerts.map(v => new Date(v.created_at).getTime()).sort((a, b) => a - b);
    const span = ts[ts.length - 1] - ts[0];
    timebar = `<div class="shell-time">∞ ${formatSpan(span)}</div>`;
  }
  const edgeChips = uniqueEdgeTypes(p).map(t => `<span class="chip">${escapeHtml(t)}</span>`).join("");
  return `
    <div class="shell-head">
      <span class="shell-tag">${escapeHtml(tag)}</span>
      <button class="shell-close" data-polygon-id="${escapeHtml(p.id)}" aria-label="deactivate">×</button>
    </div>
    <ul class="shell-vertices">${labels.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
    <div class="shell-edges">${edgeChips}</div>
    ${timebar}
  `;
}

function inferTag(p) {
  const sets = p.vertices.map(v => new Set(v.labels || []));
  const intersect = [...sets[0]].filter(l => sets[1].has(l) && sets[2].has(l));
  if (intersect.length) return intersect.join("·");
  const union = new Set([...sets[0], ...sets[1], ...sets[2]]);
  if (union.has("agent") && union.has("identity") && union.has("provider")) return "ownership";
  if (union.has("source") && union.has("note")) return "writing";
  return "polygon";
}
function uniqueEdgeTypes(p) {
  const edges = get("graph").edges;
  const types = new Set();
  for (const e of edges) {
    const k = e.src < e.dst ? `${e.src}|${e.dst}` : `${e.dst}|${e.src}`;
    if (p.edgeKeys.includes(k)) types.add(e.type);
  }
  return [...types];
}
function formatSpan(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Contour path -----------------------------------------------------

function buildContour() {
  // Walk the inner edges of all cells in order.
  if (!cells.length) {
    return `M${outerRect.x},${outerRect.y} L${outerRect.x + outerRect.w},${outerRect.y} L${outerRect.x + outerRect.w},${outerRect.y + outerRect.h} L${outerRect.x},${outerRect.y + outerRect.h} Z`;
  }
  let d = "";
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    // The cell's inner edge (inside-band side) goes from innerStart to
    // (optional innerMid) to innerEnd. We already render it as part of the
    // polygon; here we trace the path that follows the contour clockwise.
    const innerCw = c.innerMid
      ? [c.innerStart, c.innerMid, c.innerEnd]
      : [c.innerStart, c.innerEnd];
    for (let j = 0; j < innerCw.length; j++) {
      const p = innerCw[j];
      if (i === 0 && j === 0) d += `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      else d += ` L${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }
  }
  d += " Z";
  return d;
}

// ---- Activation: promote a polygon into a decorative cell --------------

function applyActivations() {
  // For each activated polygon, find the nearest decorative cell by angle
  // and re-role it. If a polygon was already activated to a cell, keep it.
  const activated = [...get("polygons").activated.values()];
  // Reset all cells to their base role first (decorative or anchor).
  for (const c of cells) {
    if (c.role.startsWith("activated:")) {
      c.role = c.baseRole || "deco";
    }
  }
  for (const screen of activated) {
    const c = projectCentroid(screen.polygon);
    const targetT = angleToOuterT(angleFromCenter(c));
    let best = null, bestD = Infinity;
    for (const cell of cells) {
      if (isAnchorRole(cell.role) || cell.role.startsWith("activated:")) continue;
      const cellT = (cell.tStart + cell.tEnd) / 2;
      const d = wrapDist(cellT, targetT);
      if (d < bestD) { bestD = d; best = cell; }
    }
    if (best) {
      best.baseRole = best.baseRole || best.role;
      best.role = "activated:" + screen.polygonId;
      best.activatedScreenAnchor = midpoint(best.innerStart, best.innerEnd);
    }
  }
}

function projectCentroid(polygon) {
  const v = polygon.vertices;
  const cx = (v[0].mesh.position.x + v[1].mesh.position.x + v[2].mesh.position.x) / 3;
  const cy = (v[0].mesh.position.y + v[1].mesh.position.y + v[2].mesh.position.y) / 3;
  const cz = (v[0].mesh.position.z + v[1].mesh.position.z + v[2].mesh.position.z) / 3;
  _v3.set(cx, cy, cz).project(camera);
  return {
    x: (_v3.x * 0.5 + 0.5) * window.innerWidth,
    y: (-_v3.y * 0.5 + 0.5) * window.innerHeight,
  };
}

function angleFromCenter(p) {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  return Math.atan2(p.x - cx, -(p.y - cy)); // 0 = up, clockwise
}

// Map angle (0=up, cw) to t on the outer rectangle (0=top-left, cw).
function angleToOuterT(angle) {
  // Project angle onto outer rectangle.
  const dx = Math.sin(angle);
  const dy = -Math.cos(angle);
  // Shoot ray from center; hit the outer rect.
  const r = outerRect;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const tx = dx === 0 ? Infinity : (dx > 0 ? r.w / 2 / dx : -r.w / 2 / dx);
  const ty = dy === 0 ? Infinity : (dy > 0 ? r.h / 2 / dy : -r.h / 2 / dy);
  const tHit = Math.min(Math.abs(tx), Math.abs(ty));
  const hx = cx + dx * tHit;
  const hy = cy + dy * tHit;
  const perim = 2 * (r.w + r.h);
  // Compute t along perimeter.
  if (Math.abs(hy - r.y) < 0.5) return (hx - r.x) / perim;
  if (Math.abs(hx - (r.x + r.w)) < 0.5) return (r.w + (hy - r.y)) / perim;
  if (Math.abs(hy - (r.y + r.h)) < 0.5) return (r.w + r.h + (r.x + r.w - hx)) / perim;
  return (r.w + r.h + r.w + (r.y + r.h - hy)) / perim;
}

function wrapDist(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);
}

function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

// ---- Tether lines (3D) ------------------------------------------------

function syncTethers() {
  const activatedCells = cells.filter(c => c.role.startsWith("activated:"));
  const want = new Set(activatedCells.map(c => c.role.slice("activated:".length)));
  for (const [id, t] of tetherByPolygon) {
    if (!want.has(id)) {
      tetherGroup.remove(t.line);
      t.geom.dispose();
      tetherByPolygon.delete(id);
    }
  }
  for (const c of activatedCells) {
    const polygonId = c.role.slice("activated:".length);
    const screen = get("polygons").activated.get(polygonId);
    if (!screen) continue;
    let entry = tetherByPolygon.get(polygonId);
    if (!entry) {
      const geom = new THREE.BufferGeometry();
      const pos = new Float32Array(6);
      geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const line = new THREE.Line(geom, tetherMaterial);
      tetherGroup.add(line);
      entry = { line, geom };
      tetherByPolygon.set(polygonId, entry);
    }
    entry.polygon = screen.polygon;
    entry.anchor = c.activatedScreenAnchor || midpoint(c.innerStart, c.innerEnd);
  }
}

function unprojectScreenAnchorToWorld(anchor) {
  const ndcX = (anchor.x / window.innerWidth) * 2 - 1;
  const ndcY = -((anchor.y / window.innerHeight) * 2 - 1);
  return new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera);
}

function refreshTetherGeometry() {
  for (const t of tetherByPolygon.values()) {
    if (!t.polygon) continue;
    const v = t.polygon.vertices[0];
    const target = unprojectScreenAnchorToWorld(t.anchor);
    const pos = t.line.geometry.attributes.position.array;
    pos[0] = v.mesh.position.x; pos[1] = v.mesh.position.y; pos[2] = v.mesh.position.z;
    pos[3] = target.x; pos[4] = target.y; pos[5] = target.z;
    t.line.geometry.attributes.position.needsUpdate = true;
  }
}

// =========================================================================
//  Public API + lifecycle
// =========================================================================

let layoutDirty = true;

function fullRender() {
  recomputeOuterRect();
  buildCells();
  applyActivations();
  renderCells();
  contourPath.setAttribute("d", buildContour());
  syncTethers();
  layoutDirty = false;
}

// Click handler for shell-close inside any teleported cell.
shellLayer.addEventListener("click", (ev) => {
  const close = ev.target.closest(".shell-close");
  if (close && close.dataset.polygonId) {
    deactivatePolygon(close.dataset.polygonId);
  }
});

subscribe("polygons", () => {
  layoutDirty = true;
  applyActivations();
  renderCells();
  contourPath.setAttribute("d", buildContour());
  syncTethers();
});
window.addEventListener("resize", () => { layoutDirty = true; fullRender(); });

// Boot: try synchronously now, then once more on the next frame in case any
// stylesheet hasn't laid out yet.
try { fullRender(); } catch (e) { console.error("shell initial render failed", e); }
requestAnimationFrame(() => {
  try { fullRender(); } catch (e) { console.error("shell second render failed", e); }
});

// Per-frame entry from main.js — refresh tether endpoints (cheap).
export function tickShell() {
  refreshTetherGeometry();
}
