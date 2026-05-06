# Polygonal Graph Exploration UI — Design Doc

A redesign of `services/explorer` that promotes graph polygons from invisible side‑effects of layout to first‑class UI surfaces. The goal: turn the existing 3D ball‑sphere into a HUD‑framed exploration cockpit where the polygons formed by graph edges become contextual screens — ephemeral when aimed at, persistent when activated, arranged into a cracked‑eggshell shell around the live graph window.

This document is written against the `rndexp-art/svc-explorer` submodule as it exists today (commit pinned in `services/explorer/`). All file paths below are relative to that submodule unless otherwise noted.

---

## 1. Context — what the explorer is today

The explorer is a FastAPI service (`app/main.py`) plus a single‑file Three.js client (`app/templates/index.html`). It renders the slice of Neo4j the signed‑in user owns, refreshes on note submission, and keeps no persistent client state.

What works today: auth and strict ownership in `app/auth.py:require_user` and `app/graph.py:user_subgraph` (capped at `EXPLORER_MAX_NODES`, default 256, with no caller‑controlled query); idempotent schema bootstrap in `app/graph.py:bootstrap` (agents, identities, providers, sources, the `[:provider]`/`[:agent]`/`[:owner|readable|writeable]` edges, all backed by `_CONSTRAINTS`); note creation via `POST /api/notes` with `[:chained {kind:'created_at'}]` linkage; and a 3D scene of Fibonacci‑lattice balls with sum‑of‑sines undulation, additive‑blended edges, OrbitControls, raycaster targeting, and a CSS HUD panel `#hud` that snaps over the hovered node. The DOM today has `#topbar`, `#composer`, `#status`, `#hud` — top and bottom only.

Stubbed or absent: there is no left **Dashboard panel** and no right **Control panel** — the four‑edge peripheral frame doesn't exist; there is no notion of a **polygon** anywhere (faces are not extracted, rendered, or raycastable); there is no client‑side store beyond the per‑frame `nodes`/`edges` arrays inline in `<script type="module">`; and there is no build step — the frontend is one 478‑line HTML file, by deliberate AGENTS.md choice.

The redesign solves a concrete UX problem: today the HUD can only surface one node at a time, and there's no way to **pin** discovered structure while exploring further. The polygonal shell is that pinning surface — but with layout, identity, and visual language derived from the graph itself.

---

## 2. Design vision

The interface is one screen with two layers and one transition. **Layer A — central exploration:** a dark navigable graph space, glowing translucent nodes in depth, luminous edges, OrbitControls panning/orbiting/zooming, the entry node roughly centered. **Layer B — peripheral meaning:** a holographic shell of activated polygon screens around the central window — the cracked‑eggshell band visible in the reference image, fitted between the green outer frame (the four peripheral panels' inner edges) and the inner purple contour (the live graph's irregular boundary). **The transition:** hovering or first‑tapping a graph polygon promotes it to the *aimed* state — a translucent yellow surface drawn in place over the graph with in‑world overlay; clicking activates it and migrates it to the shell, where it stays while the user keeps exploring.

The reference image fixes the geometry: the green frame is rectangular and screen‑bound; only the four red corner anchors break it; the purple contour is irregular because the live graph is pressing against the shell from inside; the activated polygons fill the cracked band; one bright yellow triangle floats inside as the aimed face. Every visual element ties back to a structural feature of the graph data, not chrome decoration.

---

## 3. Viewport architecture — frame, anchors, contour

The four peripheral panels and their inner edges define the green frame. Each is a CSS DOM element overlaid on the WebGL canvas (`#scene`), which stays `position: fixed; inset: 0` and continues to receive pointer events outside panels.

| Edge | Panel | Existing code | New responsibilities |
|---|---|---|---|
| Top | **Search** | `#topbar` (title + sign‑out) | Full‑width search bar; node label / Cypher‑lite (`label:note content:foo`) / polygon‑id / recent. |
| Right | **Control** | none | View mode (orbit / planar projection), polygon‑detection knobs (cycle length, planarity tolerance), camera presets, density filters. |
| Bottom | **Input** | `#composer` | Stays. One channel within the input panel; same `POST /api/notes` flow. |
| Left | **Dashboard** | none | Per‑user counters (notes, identities, providers), recent activations, mini `created_at` timeline. |

The inner edges of those four panels form the four straight segments of the green frame. The four **red anchor points** are the only vertices allowed to break the frame, rendered as small `<svg>` discs at the corners; they are the anchor coordinates the layout solver in §6 uses to place the shell.

The **purple inner contour** is the irregular boundary between the shell and the live graph. It is the union of the inner sides of all currently activated shell screens, with straight infill where no polygon is pinned. With zero activations it collapses to a rectangle inset from the green frame by a fixed shell thickness (~64 px); with activations, it deforms locally. Visually it's a single SVG `<path>` stroked in `#9a4cff` with a 1 px glow.

This HUD layer is a sibling `<div id="hud-shell">` to `#scene` with absolute‑positioned panel children and an `<svg>` sibling for frame, anchors, and contour. Pure DOM/SVG — no WebGL — so it stays crisp at any DPR and panel content can be normal CSS.

---

## 4. Central graph window — rendering choices

The center stays Three.js. We deliberately do **not** swap to D3/Cytoscape/Sigma: the existing scene already does what we need (3D balls, edges, OrbitControls, raycasting); the polygon overlays must live in the same scene as the balls so depth ordering works; and introducing a build step now would fight the "ESM from `esm.sh`, no build step" choice in `services/explorer/AGENTS.md`.

Concrete changes inside the existing `<script type="module">`: the layout function is renamed `placeNodes(payload)` and made pluggable, with a second `forceDirected3D` mode behind a right‑panel knob — polygon detection (§5) is cheaper and more meaningful on a force layout because near‑coplanar faces correspond to real graph cycles. Edges keep `THREE.LineBasicMaterial` + `AdditiveBlending`, but opacity becomes a function of state: free edge (current 0.32), part of an activated polygon (full), part of the aimed polygon (1.0, yellow tint). A new `polygonsGroup = new THREE.Group()` is added to the existing `world`, holding `THREE.Mesh` instances built from `THREE.BufferGeometry` (fan‑triangulated for convex faces; `THREE.ShapeUtils.triangulateShape` for non‑convex), with `THREE.MeshBasicMaterial` (transparent, double‑sided, additive) shared per state. The starfield stays; camera stays (perspective, fov 55). `controls.update()` must run before the per‑frame contour redraw so the SVG can pull fresh projected positions.

---

## 5. Polygon lifecycle — detection and the three states

This is the design's central mechanic, so it deserves a concrete spec.

**What is a polygon?** A chordless cycle of length ≥ 3 in the visible subgraph. We ignore Neo4j edge direction for face detection but preserve it on the shell screen so arrows can render later. A polygon is canonicalized by its sorted set of node `element_id`s — the stable id is `polygonId = sha1(sorted_ids)`.

**Where does detection run?** **Client‑side 2D Delaunay over visible nodes, filtered to triangles whose three edges exist in the graph edge set.** A `polygonsAt()` routine projects visible nodes to screen, runs `d3-delaunay` (now an npm dependency under Vite — see §9), and emits the canonical `Polygon[]` for the current camera state. Cost is O(N log N); trivial at N=256. This is the canonical detection path for the explorer — not a placeholder. Real graph faces that don't form a Delaunay triangle in projection (e.g. a 4‑cycle without a diagonal) are intentionally excluded; the design accepts that constraint in exchange for predictable performance and a face set that always matches what the eye reads as a triangle in the reference image. As an opt‑in future extension, a length‑bounded chordless‑cycle enumeration (Johnson's, length ≤ 6, ≤ 1024 faces) can be added behind a right‑panel "polygon detection" knob; that path is not on the critical implementation plan. A server‑side `/api/polygons` endpoint is out of scope at the current 256‑node cap.

**The three states**, mapped to client‑side data:

- **Transparent (default).** Polygon exists in `polygons[]`, mesh not rendered. Still raycastable via per‑frame `raycaster.intersectObjects(polygonProxies)` against invisible plane proxies — the spec's "implicitly exist as regions formed by connected edges."
- **Aimed.** Triggered by hover (desktop) or first tap (touch). Mesh switches to `aimedMaterial` (yellow `#ffd84a`, opacity 0.55, additive). A `<div class="polygon-overlay aimed">` is positioned at the polygon's centroid screen projection with in‑place content (see §7). Fades in over 140 ms — matches `#hud`'s existing transition.
- **Activated.** Triggered by click (desktop) or a 200 ms long‑press (touch). Added to `activatedPolygons` (a Map keyed by `polygonId`), removed from the central scene's render list, handed to the shell (§6). Gets a faint "tether line" — a `THREE.Line` from one vertex to the corresponding shell screen's anchor — so it stays *tethered to its origin*. Deactivated by clicking the × glyph on its shell screen. Activated state lives entirely in client memory; it does not persist across reloads.

State transitions reuse the OrbitControls drag‑gate the existing code already uses (raycasts only fire on `pointerActive` when not dragging).

By default each polygon surfaces: node labels and summaries (already in `_node_payload`); edge `type`s (already in `_rel_payload`); a count of other activated polygons sharing a vertex (cluster signal); for polygons containing `:input:note` vertices, the `created_at` span as a sparkline — this needs `_node_payload` to start emitting `created_at` (small additive change). A count badge for one‑hop neighbors that aren't themselves in the visible set is optional.

---

## 6. Activated shell — layout into the cracked‑eggshell band

The shell is a ring of irregular polygons fitted between the green outer frame and the purple inner contour. Each shell screen corresponds to one activated polygon and should look like a flattened, slightly distorted projection of the original face. The layout problem: given N activated polygons and an outer rectangle defined by the four red anchors, partition the band of width T into N polygonal cells whose inner edges form the purple contour.

Sketch (a function in `shell.js` per §9): (1) **Sort** activated polygons clockwise by the angle from screen center to their 3D centroid projected to screen — gives them stable positions tied to where they live in the graph. (2) **Allocate** an angular wedge per polygon proportional to its perimeter, clamped to `[6°, 60°]`; outer arc on the green frame, inner arc on the purple contour. (3) **Fit** each screen inside its wedge with a straight outer side hugging the frame and an irregular inner side that roughly preserves the original face's silhouette; adjacent screens share an edge, no overlaps. (4) **Assemble** the purple contour `<path>` as the union of inner sides, with straight infill across empty wedges. (5) **Animate** wedge reflow over 250 ms on activation/deactivation; tether lines update to point at the new wedge centroid.

Each shell screen renders inside an SVG `<foreignObject>` so its content stays normal HTML/CSS (charts, text, controls). The CSS uses `clip-path: polygon(...)` driven by the same vertex list — so fill, shimmer, and content share the cracked‑glass shape. The shell is **not** redrawn each WebGL frame; it updates only on activate/deactivate, window resize, or drag‑reorder. WebGL stays at 60 fps; SVG redraws are event‑driven.

---

## 7. Aimed polygon behavior

The aimed polygon is the spec's most interaction‑sensitive surface. Implementation notes:

- **Detection.** Same per‑frame raycast loop as today's `pickTarget()`, with two intersect lists: `nodes.map(n => n.mesh)` (existing) and `polygonProxies` (new). If a node hit beats a polygon hit, the node wins — polygon aiming requires the cursor to be in empty space *between* nodes, exactly as in the reference image.
- **Fade‑in.** `aimedMaterial.opacity` 0 → 0.55 over 140 ms (matches `#hud`'s existing transition).
- **In‑place data.** Up to four content categories, in priority order: (1) **node summaries** for the vertices (already in `_node_payload`); (2) **edge labels** — the live `type` values are `provider`, `agent`, `owner`, `readable`, `writeable`, `chained`, `author`, `source`; (3) **semantic tag chips** derived from intersecting label sets (e.g. an `agent ∩ source ∩ identity` triangle tags as "ownership cluster"); (4) a **tiny `created_at` band** when ≥ 2 vertices are notes. No category headers — typography differentiates them (§8).
- **Confirm to activate.** Click promotes; `Esc` cancels; `Enter` activates (keyboard parity with the composer's `⌘/Ctrl+Enter`).

---

## 8. Visual language

Palette, derived from the reference image and the existing CSS in `app/templates/index.html`: `--space-bg #05060a` (central graph void), `--frame-green #39ff8b` (outer frame), `--anchor-red #ff4757` (corner anchors), `--contour-violet #9a4cff` (inner contour), `--shell-glass rgba(140,90,230,0.18)` (activated shell fill), `--aimed-yellow #ffd84a` (aimed polygon), `--edge-cool #6da0ff` (free edges, existing). Node colors stay as today's `colorForLabels`: agent gold, source cyan, provider violet, identity mint, note default blue.

Typography: existing system font stack for chrome; uppercase mini‑labels at 10–11 px / `letter-spacing: .08em` for shell screens; monospace (`ui-monospace, SF Mono, Menlo`) for graph identifiers; tabular numerics; 12 px body inside shell screens.

Motion: nothing snaps. State transitions ease over 140–280 ms (`cubic-bezier(0.2, 0.8, 0.2, 1)`). The graph keeps its existing slow `world.rotation.y` drift and sum‑of‑sines undulation — that's the "alive" feel. Newly activated polygons travel from their 3D centroid to their shell wedge along a brief arc; deactivations reverse it. The aimed yellow polygon doesn't animate position (it's locked to its face) — only opacity.

---

## 9. Component & module breakdown

The redesign **introduces a Vite build step** for the frontend. The current `services/explorer/AGENTS.md` documents a no‑build, ESM‑from‑`esm.sh` constraint — that rule needs to be amended in the same change that lands Phase 0; flagged as a follow‑up below, not edited here. The frontend gets a `web/` source tree alongside the FastAPI app:

```
services/explorer/
├── app/                 # FastAPI (unchanged shape)
│   ├── main.py
│   ├── graph.py
│   ├── auth.py
│   ├── templates/
│   │   └── index.html   # thin shell; references /static/dist/<hashed>.js,css
│   └── static/
│       └── dist/        # Vite build output, served by FastAPI's StaticFiles
└── web/                 # NEW — Vite source tree
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    └── src/
        ├── main.ts      # entry; mounts onto #app from index.html
        ├── scene.ts     # Three.js scene, OrbitControls, layouts, undulation
        ├── polygons.ts  # Delaunay detection + transparent/aimed/activated state machine
        ├── shell.ts     # wedge layout, SVG <foreignObject> screens, contour path
        ├── panels.ts    # search / control / input / dashboard panel DOM
        ├── store.ts     # nodes, edges, polygons, aimedPolygonId, activatedPolygons, viewport, panelStates
        └── api.ts       # /api/graph and /api/notes wrappers
```

Vite's build emits hashed assets into `app/static/dist/`. `app/main.py` already mounts `/static` via `StaticFiles`, so no FastAPI route changes are needed; the Jinja `index.html` reads the manifest (`vite-plugin-manifest` or a tiny inline loader) and injects the right `<script type="module" src="/static/dist/main-<hash>.js">` and `<link rel="stylesheet">` tags. TypeScript is the default; npm dependencies pinned via `package.json` (`three`, `d3-delaunay`). The Dockerfile gains a build stage: `node:20-slim` runs `npm ci && npm run build`, then the FastAPI image copies `app/static/dist/`. Local dev can run `npm run dev` against Vite's HMR server, with the FastAPI app proxying or serving the built bundle in non‑dev — see Phase 0 in §12 for the cutover details.

Module responsibilities — `index.html`: document shell with `#scene` canvas, panel containers (`#search-panel`, `#control-panel`, `#input-panel`, `#dashboard-panel`), `<svg id="frame-svg">` for frame + anchors + contour, viewer info from Jinja, mount point. `scene.ts`: Three.js, OrbitControls, layouts (`fibonacciSphere`, `forceDirected3D`), undulation, edge rendering — extracts the current inline script. `polygons.ts`: Delaunay detection, state machine, per‑frame proxy raycast, mesh creation. `shell.ts`: wedge layout, `<foreignObject>` screens, contour path, deactivation. `panels.ts`: the four peripheral panels' DOM + behavior; mounts the existing composer into the bottom panel. `store.ts`: event‑emitter store. `api.ts`: `/api/graph`, `/api/notes` wrappers.

Backend changes are minimal: `app/graph.py:_node_payload` adds `created_at` and (where present) `kind` so the aimed overlay can render time bands and labels without new round trips — trivial, no schema impact. `app/main.py`'s routes are unchanged. `app/auth.py` and the Caddy `rndexp_auth_forward` integration are unchanged.

---

## 10. Data and state model

Client store (in `store.js`):

```
{
  viewer: { sub, email, name },           // from /api/graph
  graph: {
    nodes: Node[],                        // {id, label, labels, summary, created_at?}
    edges: Edge[],                        // {id, src, dst, type}
    nodeById: Map<id, Node>,
    edgeKey: Set<"src|dst">,              // for O(1) "is there an edge here?"
  },
  polygons: {
    all: Polygon[],                       // detected; transparent by default
    aimedId: string | null,
    activated: Map<polygonId, ShellScreen>,
  },
  viewport: {
    cameraTarget: Vec3,                   // OrbitControls target
    cameraPos: Vec3,
    layoutMode: 'sphere' | 'force3d',
  },
  panels: {
    search: { open, query, results },
    control: { polygonMode, density, layoutMode },
    input:  { textareaValue, submitting },
    dashboard: { counters, recent },
  },
}
```

A `Polygon` is `{ id, vertexIds, edgeIds, centroid3D, perimeter, kind: 'triangle' }`. A `ShellScreen` is `{ polygonId, wedgeIndex, anchor, content }`. The store is flat and synchronous — no Redux, no signals library; the current scene rebuild is already a "rebuild from payload" operation and we extend that pattern. Server state is unchanged. **Activations live entirely in client memory and do not persist across reloads** — a hard reload clears `activatedPolygons`. This is a deliberate scope choice for the redesign.

---

## 11. Interaction model

| Action | Mouse | Touch | Keyboard |
|---|---|---|---|
| Orbit / pan / zoom | drag / right‑drag / wheel | one‑finger / two‑finger / pinch | arrows + shift |
| Aim polygon | hover empty area between nodes | first tap on empty area | Tab cycles detected polygons |
| Activate polygon | click aimed polygon | long‑press (200 ms) | Enter while aimed |
| Cancel aim | move cursor away | tap empty space | Esc |
| Inspect node (HUD) | hover ball | tap on ball | Tab cycles nodes when no polygon aimed |
| Deactivate shell screen | click × glyph | tap × glyph | Backspace on focused screen |
| Reorder shell | drag screen | drag | — |
| Submit note | composer button | composer button | ⌘/Ctrl+Enter (already wired) |
| Search | click search panel | tap | `/` to focus, Esc to blur |

The OrbitControls drag‑gate from `index.html` is preserved — raycasts only run when the camera isn't being dragged.

---

## 12. Phased implementation plan

The current explorer ships on every push to `production`. The redesign is sequenced so each phase is mergeable independently and the WIP never breaks for users.

**Phase 0 — Vite cutover, no UX change.** Stand up `services/explorer/web/` with `package.json`, `vite.config.ts`, `tsconfig.json`. Move the existing inline script into `web/src/main.ts` (and a thin `scene.ts`) verbatim, ported to TypeScript. Add a Node build stage to `Dockerfile` that runs `npm ci && npm run build`, emitting hashed assets into `app/static/dist/`. Update `app/templates/index.html` to read the Vite manifest and inject the right `<script type="module">` and `<link rel="stylesheet">`. Amend `services/explorer/AGENTS.md`'s no‑build / `esm.sh` rule in the same PR (out of scope for this design doc but a required follow‑up). No visible UX difference. Test: existing 3D scene renders, composer submits, status updates; container build succeeds; `tools/rndexp render && tools/rndexp up` works locally.

**Phase 1 — peripheral frame.** Add the green outer frame, four red corner anchors, and rectangular purple contour in `<svg id="frame-svg">`. Mount the existing topbar/composer into the new top and bottom panels. Add placeholder left (Dashboard) and right (Control) panels so the four‑edge composition appears. SVG is `pointer-events: none`, panels are the only interactive overlays.

**Phase 2 — aimed polygon.** Triangle detection via Delaunay (`d3-delaunay` npm dep) plus the aim state. No activation, no shell yet. Test: hovering between three connected balls shows the yellow translucent triangle with overlay; hovering away clears it.

**Phase 3 — activation and shell.** `activatedPolygons`, wedge layout, irregular purple contour, tether lines. 200 ms long‑press for activation on touch. Test: clicking three different aimed triangles produces three shell screens; deactivating any one reflows the contour. This is the "design comes alive" milestone.

**Phase 4 — content.** Wire real data into shell screens (summaries, edge types, sparklines for note polygons). Add `created_at` to `_node_payload`. Wire the dashboard counters (derived from the same `/api/graph` payload). Add search.

**Phase 5 — polish.** Force‑directed layout option, motion polish, accessibility pass. Cycle enumeration ≤ 6 may be added behind the right‑panel knob as an optional, off‑by‑default extension; not on the critical path.

Each phase is one PR against `services/explorer`'s `main`, merges to `production` independently, and only needs a submodule SHA bump in the gateway.

---

## 13. Open questions and risks

Most of the structural questions surfaced during design have been decided and are now reflected in the relevant body sections (Delaunay triangles as the canonical detection path in §5, Vite as the build tool in §9 and §12, 200 ms long‑press for touch activation in §5/§11, no persistence of activated polygons in §10). What genuinely remains open:

1. **Vite dev flow.** The build pipeline is decided, but the *dev* loop isn't. Two reasonable shapes: (a) `npm run dev` runs Vite's HMR server on a separate port and the FastAPI app proxies `/static/dist/*` to it, or (b) Phase 0 ships build‑only and developers re‑run `npm run build` (or `npm run watch`) manually. (a) is faster but adds a docker‑compose wrinkle; (b) is simpler. Default recommendation: ship (b) in Phase 0, add (a) in Phase 5 if anyone misses HMR.
2. **`esm.sh` as a prototyping fallback.** The Vite cutover removes the no‑build constraint, but `esm.sh` is still a useful fast path for one‑off prototypes. Worth deciding: do we keep an `esm.sh`‑only branch path for prototyping (e.g. a separate `prototype.html` that bypasses the build), or is the Vite dev loop fast enough that we don't need it? Lean: skip the branch path; reach for it ad hoc only.
3. **Shell rendering medium.** Specced as SVG + `foreignObject` because it composes with normal HTML/CSS, the eggshell shapes are inherently 2D screen‑space, and the WebGL canvas stays focused on the live graph. The alternative — Three.js planes pinned to the camera — would let shell content sit *behind* the graph in depth but loses crisp text and clip‑path effects. Worth a final sanity check before Phase 3 lands; current recommendation is SVG.
4. **Accessibility.** The shell is highly visual. Each shell screen needs `aria-label`; the four panels need `role="region"` with names; the keyboard model in §11 helps but doesn't substitute for screen‑reader semantics — this needs a dedicated pass before any accessibility commitments are made.

**Current scope assumptions, not open questions.** The 256‑node `EXPLORER_MAX_NODES` cap is treated as a fixed input to this design — Delaunay detection, the wedge layout, force‑directed mode, and the choice to skip a server `/api/polygons` endpoint all depend on it. If the cap is ever lifted, detection moves server‑side and the shell layout's perimeter‑weighting would need a max‑screen‑count guard; out of scope until then.

**Required follow‑up not edited here.** `services/explorer/AGENTS.md` documents a no‑build, ESM‑from‑`esm.sh` rule and its "Frontend (Three.js)" / "Composer" sections describe the current sphere‑of‑balls UI; both need to be amended in the Phase 0 PR. Flagged here so it isn't forgotten.

---

*Design reviewed against `services/explorer` at the SHA pinned in the gateway as of this session. No files in `~/Developer/personal/rndexpart` were modified.*
