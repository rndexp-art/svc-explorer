// Tiny event-emitter store. The whole client treats this as the single source
// of truth — `subscribe(key, fn)` to react to changes, `set(key, value)` to
// write. Flat by design; no Redux, no signals library. The original explorer
// already rebuilt scene state from a payload on each refresh, so we extend
// that pattern rather than introducing reactivity.

const subscribers = new Map(); // key -> Set<fn>
const state = {
  viewer: null,                // { sub, email, name }
  graph: {
    nodes: [],                 // { id, label, labels, summary, created_at?, kind? }
    edges: [],                 // { id, src, dst, type }
    nodeById: new Map(),
    edgeKey: new Set(),        // "minId|maxId" — undirected lookup
    note_count: 0,
  },
  polygons: {
    all: [],                   // Polygon[]
    aimedId: null,
    activated: new Map(),      // polygonId -> ShellScreen
  },
  viewport: {
    layoutMode: "sphere",      // 'sphere' | 'force3d'
    width: 0,
    height: 0,
  },
  panels: {
    search: { query: "", results: [] },
    control: { polygonMode: "delaunay", density: 1.0, layoutMode: "sphere" },
    input: { value: "", submitting: false },
    dashboard: { counters: {}, recent: [] },
  },
  status: { text: "loading…", kind: "" },
};

export function get(key) {
  return key ? state[key] : state;
}

export function set(key, value) {
  state[key] = value;
  emit(key);
}

export function patch(key, partial) {
  state[key] = { ...state[key], ...partial };
  emit(key);
}

export function subscribe(key, fn) {
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key).add(fn);
  return () => subscribers.get(key).delete(fn);
}

export function emit(key) {
  const set_ = subscribers.get(key);
  if (set_) for (const fn of set_) fn(state[key]);
}

// Helpers for the things the rest of the app reaches for repeatedly.
export function ingestGraphPayload(payload) {
  const nodeById = new Map();
  for (const n of payload.nodes) nodeById.set(n.id, n);
  const edgeKey = new Set();
  for (const e of payload.edges) {
    const k = e.src < e.dst ? `${e.src}|${e.dst}` : `${e.dst}|${e.src}`;
    edgeKey.add(k);
  }
  state.graph = {
    nodes: payload.nodes,
    edges: payload.edges,
    nodeById,
    edgeKey,
    note_count: payload.note_count ?? 0,
  };
  if (payload.viewer) state.viewer = payload.viewer;
  emit("graph");
  emit("viewer");
}

export function hasEdge(idA, idB) {
  const k = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
  return state.graph.edgeKey.has(k);
}

export function aimPolygon(polygonId) {
  if (state.polygons.aimedId === polygonId) return;
  state.polygons.aimedId = polygonId;
  emit("polygons");
}

export function activatePolygon(polygon) {
  if (state.polygons.activated.has(polygon.id)) return;
  state.polygons.activated.set(polygon.id, {
    polygonId: polygon.id,
    polygon,
    wedgeIndex: state.polygons.activated.size,
    activatedAt: performance.now(),
  });
  if (state.polygons.aimedId === polygon.id) state.polygons.aimedId = null;
  emit("polygons");
}

export function deactivatePolygon(polygonId) {
  if (!state.polygons.activated.delete(polygonId)) return;
  // Re-index wedge positions so they remain dense.
  let i = 0;
  for (const screen of state.polygons.activated.values()) screen.wedgeIndex = i++;
  emit("polygons");
}

export function setStatus(text, kind = "") {
  state.status = { text, kind };
  emit("status");
}
