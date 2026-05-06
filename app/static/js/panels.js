// Four peripheral panels (search / control / input / dashboard) and the
// node-HUD that snaps over a hovered ball. The HUD itself is the original
// implementation — preserved so node hover behavior is unchanged from the
// pre-redesign UI.

import { get, subscribe, patch, setStatus, ingestGraphPayload, deactivatePolygon } from "./store.js";
import { camera, getTargetedNode } from "./scene.js";
import { fetchGraph, postNote } from "./api.js";

// --- Status line ---------------------------------------------------------
const statusEl = document.getElementById("status");
subscribe("status", (s) => {
  statusEl.textContent = s.text;
  statusEl.classList.remove("error", "success");
  if (s.kind) statusEl.classList.add(s.kind);
});

// --- Top: Search panel ---------------------------------------------------
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  patch("panels", { search: { ...get("panels").search, query: q } });
  renderSearchResults(q);
});
window.addEventListener("keydown", (ev) => {
  if (ev.key === "/" && document.activeElement !== searchInput && !ev.metaKey && !ev.ctrlKey) {
    ev.preventDefault();
    searchInput.focus();
  }
});

function parseQuery(q) {
  // `label:foo` filters on labels; `content:bar` matches summary; bare
  // tokens match the label. Cypher-lite per design §3.
  const label = (q.match(/label:([\w.:]+)/) || [])[1];
  const content = (q.match(/content:(\S+)/) || [])[1];
  const bare = q.replace(/(label|content):\S+/g, "").trim();
  return { label, content, bare };
}

function renderSearchResults(q) {
  searchResults.innerHTML = "";
  if (!q) return;
  const { label, content, bare } = parseQuery(q);
  const items = get("graph").nodes.filter(n => {
    if (label && !(n.labels || []).includes(label)) return false;
    if (content && !(n.summary || "").toLowerCase().includes(content.toLowerCase())) return false;
    if (bare && !(n.label || "").toLowerCase().includes(bare)) return false;
    return true;
  }).slice(0, 12);
  for (const n of items) {
    const li = document.createElement("li");
    li.className = "search-result";
    li.innerHTML = `<span class="result-label">${escapeHtml(n.label)}</span><span class="result-kind">${escapeHtml((n.labels || []).join("·"))}</span>`;
    li.addEventListener("click", () => {
      // Focus camera on this node by setting the OrbitControls target.
      // The node's mesh position is what we want. We do it by dispatching
      // a custom event — the scene module owns the camera.
      window.dispatchEvent(new CustomEvent("explorer:focus-node", { detail: { id: n.id } }));
    });
    searchResults.appendChild(li);
  }
}

// --- Right: Control panel ------------------------------------------------
const controlPanel = document.getElementById("control-panel-host");
controlPanel.innerHTML = `
  <div class="panel-title">control</div>
  <label class="control-row">
    <span>layout</span>
    <select id="ctl-layout">
      <option value="sphere">sphere</option>
      <option value="force3d">force-directed</option>
    </select>
  </label>
  <label class="control-row">
    <span>polygons</span>
    <select id="ctl-polygons">
      <option value="delaunay">delaunay (triangles)</option>
    </select>
  </label>
  <label class="control-row">
    <span>density</span>
    <input id="ctl-density" type="range" min="0" max="1" step="0.05" value="1" />
  </label>
  <button id="ctl-deactivate-all" class="control-btn">deactivate all</button>
  <div class="panel-tail">
    <div class="kbd">/</div>focus search<br/>
    <div class="kbd">esc</div>cancel aim<br/>
    <div class="kbd">enter</div>activate aimed<br/>
    <div class="kbd">⌘↵</div>send note
  </div>
`;
document.getElementById("ctl-layout").addEventListener("change", (ev) => {
  patch("panels", { control: { ...get("panels").control, layoutMode: ev.target.value } });
});
document.getElementById("ctl-density").addEventListener("input", (ev) => {
  patch("panels", { control: { ...get("panels").control, density: parseFloat(ev.target.value) } });
  // Density is a hint for the future cycle-enumeration knob; today it's
  // accepted but not consumed.
});
document.getElementById("ctl-deactivate-all").addEventListener("click", () => {
  for (const id of [...get("polygons").activated.keys()]) deactivatePolygon(id);
});

// --- Bottom: Input panel (composer) --------------------------------------
const composer = document.getElementById("composer");
const composerInput = composer.querySelector("textarea");
const composerBtn = composer.querySelector("button");

function autosizeTextarea() {
  composerInput.style.height = "auto";
  composerInput.style.height = Math.min(composerInput.scrollHeight, window.innerHeight * 0.3) + "px";
}
composerInput.addEventListener("input", autosizeTextarea);
composerInput.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
    ev.preventDefault();
    composer.requestSubmit();
  }
});
composer.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const content = composerInput.value.trim();
  if (!content) return;
  composerBtn.disabled = true;
  setStatus("saving note…");
  try {
    await postNote(content);
    composerInput.value = "";
    autosizeTextarea();
    setStatus("note saved · refreshing graph…", "success");
    await refreshGraph();
  } catch (e) {
    console.error(e);
    setStatus(String(e.message || e), "error");
  } finally {
    composerBtn.disabled = false;
    composerInput.focus();
  }
});

// --- Left: Dashboard panel ----------------------------------------------
const dashboardPanel = document.getElementById("dashboard-panel-host");

function renderDashboard() {
  const nodes = get("graph").nodes;
  const counts = {};
  for (const n of nodes) {
    for (const l of n.labels || []) counts[l] = (counts[l] || 0) + 1;
  }
  const noteNodes = nodes.filter(n => (n.labels || []).includes("note") && n.created_at);
  noteNodes.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  const recent = noteNodes.slice(0, 5);
  const activatedCount = get("polygons").activated.size;

  const order = ["agent", "identity", "provider", "source", "note"];
  const counterRows = order
    .filter(k => counts[k])
    .map(k => `<li><span class="dash-count">${counts[k]}</span><span class="dash-kind">${k}</span></li>`)
    .join("");

  const recentRows = recent
    .map(n => `<li title="${escapeHtml(n.summary || "")}"><span>${escapeHtml(n.label || "(empty)")}</span><time>${formatRelative(n.created_at)}</time></li>`)
    .join("") || `<li class="muted">no notes yet</li>`;

  // Mini sparkline of notes per day over the last 14 days.
  const sparkline = makeSparkline(noteNodes);

  dashboardPanel.innerHTML = `
    <div class="panel-title">dashboard</div>
    <ul class="dash-counters">${counterRows || `<li class="muted">empty graph</li>`}</ul>
    <div class="dash-section-title">activated</div>
    <div class="dash-activated">${activatedCount} polygon${activatedCount === 1 ? "" : "s"} pinned</div>
    <div class="dash-section-title">recent notes</div>
    <ul class="dash-recent">${recentRows}</ul>
    <div class="dash-section-title">notes / day</div>
    ${sparkline}
  `;
}

function makeSparkline(noteNodes) {
  const DAYS = 14;
  const now = Date.now();
  const buckets = new Array(DAYS).fill(0);
  for (const n of noteNodes) {
    const ageDays = Math.floor((now - +new Date(n.created_at)) / 86_400_000);
    if (ageDays >= 0 && ageDays < DAYS) buckets[DAYS - 1 - ageDays]++;
  }
  const max = Math.max(1, ...buckets);
  const W = 160; const H = 30; const step = W / DAYS;
  let path = "";
  for (let i = 0; i < DAYS; i++) {
    const x = i * step + step / 2;
    const y = H - (buckets[i] / max) * (H - 2);
    path += (i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return `<svg class="dash-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${path}" /></svg>`;
}

function formatRelative(iso) {
  const t = +new Date(iso);
  if (!t) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

subscribe("graph", renderDashboard);
subscribe("polygons", renderDashboard);

// --- Node HUD (preserved from pre-redesign) ------------------------------
const hud = document.getElementById("hud");
const hudLabel = hud.querySelector(".label");
const hudLabels = hud.querySelector(".labels");
const hudSummary = hud.querySelector(".summary");

export function showHud(node) {
  const v = node.mesh.position.clone().project(camera);
  const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
  hud.style.left = sx + "px";
  hud.style.top = sy + "px";
  hud.classList.add("visible");
  hud.setAttribute("aria-hidden", "false");
  hudLabel.textContent = node.label || "(unnamed)";
  hudLabels.textContent = (node.labels || []).join(" · ");
  hudSummary.textContent = node.summary || "(no summary)";
}
export function hideHud() {
  hud.classList.remove("visible");
  hud.setAttribute("aria-hidden", "true");
}

export function tickHud() {
  // Node hover wins over polygon aim per design §7. We pick the node first
  // in main.js and apply the hover state there; this just refreshes the
  // HUD position when a node is targeted.
  const t = getTargetedNode();
  if (t) showHud(t);
  else hideHud();
}

// --- Focus a node from search ------------------------------------------
window.addEventListener("explorer:focus-node", (ev) => {
  const { id } = ev.detail;
  const node = get("graph").nodes.find(n => n.id === id);
  if (!node) return;
  // Ask scene to fly the camera target. We don't import controls here to
  // avoid a circular dep — emit another event.
  window.dispatchEvent(new CustomEvent("explorer:fly-to", { detail: { id } }));
});

// --- Boot helpers consumed by main.js ----------------------------------
export async function refreshGraph() {
  const payload = await fetchGraph();
  ingestGraphPayload(payload);
  setStatus(
    `${payload.nodes.length} nodes · ${payload.edges.length} edges · ${payload.note_count ?? 0} notes`,
    "",
  );
  return payload;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
