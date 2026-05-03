# AGENTS.md — explorer service

This is a service of the [rndexpart gateway](../../AGENTS.md). Read the gateway's AGENTS.md first.

## What this service is

A FastAPI + Three.js app that renders the slice of the Neo4j graph the signed-in user owns as an undulating sphere of interlinked balls in 3D space, plus a textarea composer for adding `:input:note` nodes from the same UI.

- Public hostname: `explorer.rndexp.art` (production), `explorer.rndexp.localhost` (dev).
- Internal port: **8005**.
- Gated behind the auth service: every path except `/healthz` requires a valid session cookie. The Caddy site block `import`s the `rndexp_auth_forward` snippet defined by `services/auth/caddy.fragment`. Unlike the dashboard, the explorer requires *any* authenticated user — no `admin` role check.

## How auth works here

Caddy's `forward_auth` injects four headers into the upstream request:

| Header | Source |
|---|---|
| `X-Auth-Sub` | numeric user id, as a string |
| `X-Auth-Email` | verified email |
| `X-Auth-Roles` | comma-separated role slugs |
| `X-Auth-Permissions` | comma-separated permission slugs |

`app/auth.py:require_user` parses them, coerces `sub` to `int`, and 401s if anything's missing. The `int(sub)` is what every Cypher write keys `:agent.auth_user_id` and `:identity.external_id` on, so all services share the same canonical type.

## Graph schema (and the new identity↔provider convention)

The explorer uses the same node + edge vocabulary the telegram-bot writer established, plus one new convention: **every `:identity` is linked to its `:provider` via `(:identity)-[:provider]->(:provider)`**. An identity is "an account in a provider's system"; the edge says which system. The `(:identity)-[:agent]->(:agent)` link stays *optional* — it's only set when an identity belongs to a real rndexp.art user (so we can model identities that aren't users, e.g. external participants in an imported chat).

| Element | Identity | Created by |
|---|---|---|
| `(:provider {name})` | unique `name` | One per integration. Explorer registers `auth` (for human identities) and `explorer` (for sources owned by explorer users). |
| `(:agent {auth_user_id})` | unique `auth_user_id` | One per rndexp.art user. Created on first explorer hit. |
| `(:identity {provider_name, external_id})` | composite | Explorer creates `(provider:'auth', external_id:auth_user_id)` for the viewer. Multiple identities per agent across providers (and within a provider) are allowed. |
| `(:source {provider_name, external_id})` | composite | Explorer creates `(provider:'explorer', external_id:auth_user_id)` per user — represents "things this user added via the explorer". |
| `(:input:note {note_id})` | UUID | Created by the textarea composer. `provider_name='explorer'`, `external_chat_id=auth_user_id`, `external_id=note_id`. |

Edges:

| Edge | When |
|---|---|
| `(:identity)-[:provider]->(:provider)` | bootstrap; on every telegram message too. |
| `(:identity)-[:agent]->(:agent)` | bootstrap (for the viewer's auth identity). Optional in general. |
| `(:source)-[:provider]->(:provider)` | bootstrap. |
| `(:source)-[:owner\|readable\|writeable]->(:agent)` | bootstrap (all three for the user's own source). |
| `(:input:note)-[:author]->(:identity)` | every composer submission. |
| `(:input:note)-[:source]->(:source)` | every composer submission. |
| `(:input:note)-[:chained {kind:'created_at'}]->(:input:note)` | composer; links to the latest prior note from the same author in the same source by `created_at`. |

What we deliberately **don't** do (compared to telegram):

- No `sent_at` chain — the textarea has no upstream send timestamp distinct from `created_at`.
- No `reply` chain — the textarea isn't conversational.
- No `:overrides` — the textarea doesn't model edits.

`ensure_schema()` runs in the FastAPI lifespan and re-creates the same uniqueness constraints the telegram-bot writer creates. They're `IF NOT EXISTS`, so running them from both services is safe.

## Strict ownership: what the user sees

`/api/graph` does **not** accept any user-controlled query parameters that influence the result set. The only authority is `X-Auth-Sub`. The query starts at `(:agent {auth_user_id: <sub>})` and returns:

- The agent itself.
- `:identity` nodes linked back to the agent via `[:agent]`.
- `:provider` nodes those identities point at via `[:provider]`.
- `:source` nodes that own the agent via `[:owner]`.
- `:provider` nodes those sources point at via `[:provider]`.
- `:input:note` nodes attached to those sources via `[:source]`, capped at `EXPLORER_MAX_NODES` (default 256), most-recent-first by `created_at`.

Edges are then queried with `MATCH (x)-[r]->(y) WHERE elementId(x), elementId(y) IN $visible_ids` — only relationships *between nodes already in the visible set* are returned, so we can't accidentally leak a node identity through a relationship endpoint. There is **no fallback** to a sample subgraph: a brand-new user sees their own bootstrap nodes (agent, identity, source, providers) and nothing else, which is correct.

`bootstrap()` runs on every authenticated `/api/graph` and `/api/notes` call — it's idempotent (all `MERGE`), backed by uniqueness constraints, and cheaper than a cache invalidation bug.

## Composer (textarea → :input:note)

The bottom-center HUD-style panel posts `{content}` to `POST /api/notes`. The server validates length, MATCHes the user's `agent` / `identity` / `source` (which `bootstrap` guaranteed exist), CREATEs the note, and adds the `created_at` chain edge. On 201 the frontend re-fetches `/api/graph` and rebuilds the scene; the new node appears as a fresh ball on the sphere.

`Cmd/Ctrl+Enter` submits.

## Frontend (Three.js)

Single page, ESM imports from `esm.sh@0.160.0`, no build step.

- **Layout**: Fibonacci lattice on a sphere of radius 140; ball radius 4.
- **Undulation**: each ball gets a sum-of-sines displacement (different freq per axis, per-ball seed) so the sphere "breathes" without losing structure.
- **Colors**: agent gold · source cyan · provider violet · identity mint · note default blue.
- **Targeting**: per-frame raycast from the cursor. Hovered ball gets a hot-yellow material and 1.45× scale.
- **HUD**: CSS panel snapped to the targeted ball's projected screen position; shows label, `:labels` joined, and summary.

## What lives here

- `compose.fragment.yml` / `caddy.fragment` — gateway integration.
- `Dockerfile` — uv, Python 3.12 slim, non-root.
- `app/main.py` — FastAPI routes, lifespan-managed schema/driver.
- `app/auth.py` — header-based auth dependency.
- `app/graph.py` — neo4j driver, bootstrap, subgraph query, note write.
- `app/templates/index.html` — single-page Three.js client.

## Required env vars

| Var | Purpose |
|---|---|
| `NEO4J_USER` / `NEO4J_PASSWORD` | shared with the neo4j service |
| `EXPLORER_NEO4J_URI` | bolt URI; defaults to `bolt://neo4j:7687` |
| `EXPLORER_MAX_NODES` | hard ceiling on returned nodes (default `256`); the framework nodes (agent / identities / providers / sources) take a few slots, the rest is notes-most-recent-first. |

`NEO4J_USER` / `NEO4J_PASSWORD` already exist in the gateway's secret list — no new GH Actions secret is required.

## Conventions / gotchas

- The `(:identity)-[:provider]->(:provider)` edge is the new schema convention. The telegram-bot writer was updated in the same change to MERGE this edge on every message; existing identities catch up the next time their owner posts.
- Bind container ports inside the docker network only. Caddy is the public ingress.
- All hostnames in `caddy.fragment` use the production form (`*.rndexp.art`); the gateway's renderer rewrites them for local.
- No build step for the frontend — the HTML imports Three.js from `esm.sh`. If we ever want to vendor it, drop a copy into `app/static/` and switch the import.
- The Cypher writes are idempotent at the node level via `MERGE` + uniqueness constraints. The note `CREATE` is *not* idempotent — duplicate POSTs would create duplicate notes; the client-side disable-on-submit prevents the obvious case.
