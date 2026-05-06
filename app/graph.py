"""Neo4j subgraph extraction + writes for the explorer.

Three responsibilities:

  1. `bootstrap(viewer)` — idempotently create the user's agent / identity /
     source / provider scaffolding. Run on every authenticated request, so
     first-touch users get set up automatically and there's no special
     "sign-up" path. Cheap (5 MERGE statements; all backed by uniqueness
     constraints).

  2. `user_subgraph(viewer)` — strict-ownership view of the graph. Starts
     from the user's `:agent` node and returns ONLY:
       - the agent itself
       - the user's `:identity` nodes (those linked back via `[:agent]`)
       - providers those identities belong to (via `[:identity]-[:provider]->`)
       - sources the agent owns (via `[:source]-[:owner]->[:agent]`)
       - providers those sources belong to
       - `:input:note` nodes attached to those sources, capped at MAX_NODES
     Edges are returned only between nodes already in the visible set, so we
     can't accidentally leak a name through a relationship endpoint.

  3. `create_note(viewer, content)` — persist a textarea submission as
     `(:input:note)` attached to the user's `:source` and `:identity`, with
     a `[:chained {kind:'created_at'}]` edge to the most recent prior note
     from the same author in the same source (per spec: created_at chain
     only — no sent_at, no reply, no overrides).
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from neo4j import GraphDatabase, basic_auth


log = logging.getLogger(__name__)


# --- config -----------------------------------------------------------------

def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        log.warning("invalid %s=%r, using default %d", name, raw, default)
        return default


NEO4J_URI = os.getenv("EXPLORER_NEO4J_URI", "bolt://neo4j:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")
MAX_NODES = _env_int("EXPLORER_MAX_NODES", 256)

PROVIDER_EXPLORER = "explorer"
PROVIDER_AUTH = "auth"

MAX_NOTE_BYTES = 64 * 1024  # 64 KiB; well above any reasonable textarea


# --- viewer -----------------------------------------------------------------

@dataclass(frozen=True)
class Viewer:
    """The minimum info we need from the auth headers to talk to the graph."""
    auth_user_id: int
    email: str
    name: str


# --- driver -----------------------------------------------------------------

@lru_cache(maxsize=1)
def _driver():
    return GraphDatabase.driver(NEO4J_URI, auth=basic_auth(NEO4J_USER, NEO4J_PASSWORD))


# Reuses the same constraints the telegram-bot writer creates. Re-running
# `CREATE CONSTRAINT … IF NOT EXISTS` is a no-op, so it's safe to call from
# both services on startup.
_CONSTRAINTS = [
    "CREATE CONSTRAINT note_id IF NOT EXISTS "
    "FOR (n:note) REQUIRE n.note_id IS UNIQUE",
    "CREATE CONSTRAINT note_external_pk IF NOT EXISTS "
    "FOR (n:note) REQUIRE (n.provider_name, n.external_chat_id, n.external_id) IS UNIQUE",
    "CREATE CONSTRAINT provider_name IF NOT EXISTS "
    "FOR (p:provider) REQUIRE p.name IS UNIQUE",
    "CREATE CONSTRAINT agent_auth_user_id IF NOT EXISTS "
    "FOR (a:agent) REQUIRE a.auth_user_id IS UNIQUE",
    "CREATE CONSTRAINT source_pk IF NOT EXISTS "
    "FOR (s:source) REQUIRE (s.provider_name, s.external_id) IS UNIQUE",
    "CREATE CONSTRAINT identity_pk IF NOT EXISTS "
    "FOR (i:identity) REQUIRE (i.provider_name, i.external_id) IS UNIQUE",
]


def ensure_schema() -> None:
    with _driver().session() as s:
        for c in _CONSTRAINTS:
            s.run(c)


def close() -> None:
    if _driver.cache_info().currsize:
        _driver().close()
        _driver.cache_clear()


# --- bootstrap --------------------------------------------------------------

# Idempotent. Creates:
#   - (:provider {name:'auth'}) and (:provider {name:'explorer'}) globally
#   - (:agent {auth_user_id})         the human behind the account
#   - (:identity {provider_name:'auth', external_id:auth_user_id})
#         the user's account in the auth provider's system
#   - (:source {provider_name:'explorer', external_id:auth_user_id})
#         "things this user added via the explorer"
#
# And the edges between them per the schema convention:
#   (i)-[:provider]->(auth_provider)    NEW: identity ↔ provider
#   (i)-[:agent]->(a)                   identity ↔ agent (this user is a real person)
#   (s)-[:provider]->(explorer_provider)
#   (s)-[:owner|readable|writeable]->(a)
_BOOTSTRAP_CYPHER = """
MERGE (ap:provider {name: $auth_provider})
  ON CREATE SET ap.created_at = datetime(), ap.kind = 'auth'

MERGE (ep:provider {name: $explorer_provider})
  ON CREATE SET ep.created_at = datetime(), ep.kind = 'explorer'

MERGE (a:agent {auth_user_id: $auth_user_id})
  ON CREATE SET a.created_at = datetime()
SET a.email = CASE WHEN $email <> '' THEN $email ELSE a.email END,
    a.name  = CASE WHEN $name  <> '' THEN $name  ELSE a.name  END

MERGE (i:identity {provider_name: $auth_provider, external_id: $auth_user_id})
  ON CREATE SET i.created_at = datetime(), i.kind = 'auth_user'
SET i.email = CASE WHEN $email <> '' THEN $email ELSE i.email END,
    i.name  = CASE WHEN $name  <> '' THEN $name  ELSE i.name  END
MERGE (i)-[:provider]->(ap)
MERGE (i)-[:agent]->(a)

MERGE (s:source {provider_name: $explorer_provider, external_id: $auth_user_id})
  ON CREATE SET s.created_at = datetime(), s.kind = 'explorer_user'
SET s.title = CASE WHEN $email <> '' THEN $email ELSE s.title END
MERGE (s)-[:provider]->(ep)
MERGE (s)-[:owner]->(a)
MERGE (s)-[:readable]->(a)
MERGE (s)-[:writeable]->(a)
"""


def _bootstrap_params(viewer: Viewer) -> dict[str, Any]:
    return {
        "auth_user_id": viewer.auth_user_id,
        "email": viewer.email or "",
        "name": viewer.name or "",
        "auth_provider": PROVIDER_AUTH,
        "explorer_provider": PROVIDER_EXPLORER,
    }


def bootstrap(viewer: Viewer) -> None:
    """Ensure the user's scaffold exists. Idempotent."""
    with _driver().session() as session:
        session.execute_write(lambda tx: tx.run(_BOOTSTRAP_CYPHER, **_bootstrap_params(viewer)).consume())


# --- subgraph (strict ownership) -------------------------------------------

# Returns only what the viewer owns. Notes are bounded by MAX_NODES (most
# recent first); the framework nodes (agent / identities / providers /
# sources) are unbounded but small.
_FRAMEWORK_CYPHER = """
MATCH (a:agent {auth_user_id: $auth_user_id})
OPTIONAL MATCH (a)<-[:agent]-(i:identity)
OPTIONAL MATCH (i)-[:provider]->(ip:provider)
OPTIONAL MATCH (a)<-[:owner]-(s:source)
OPTIONAL MATCH (s)-[:provider]->(sp:provider)
RETURN a AS agent,
       collect(DISTINCT i)  AS identities,
       collect(DISTINCT ip) AS identity_providers,
       collect(DISTINCT s)  AS sources,
       collect(DISTINCT sp) AS source_providers
""".strip()

_NOTES_CYPHER = """
MATCH (a:agent {auth_user_id: $auth_user_id})
MATCH (n:input:note)-[:source]->(:source)-[:owner]->(a)
WITH n ORDER BY coalesce(n.created_at, n.sent_at, datetime({epochMillis: 0})) DESC
LIMIT $cap
RETURN collect(n) AS notes
""".strip()

# Inter-node edges: only between nodes already in the visible set. Direction
# is preserved in the payload so the frontend can render labelled arrows
# later if we want; for now we draw undirected lines.
_EDGES_CYPHER = """
UNWIND $ids AS id
MATCH (a) WHERE elementId(a) = id
MATCH (a)-[r]->(b) WHERE elementId(b) IN $ids
RETURN DISTINCT r
""".strip()


@dataclass(frozen=True)
class GraphSlice:
    nodes: list[dict[str, Any]]
    edges: list[dict[str, Any]]
    note_count: int


def _node_payload(node) -> dict[str, Any]:
    """Serialize a Neo4j Node into the JSON shape the frontend expects.

    `label` is human-readable (best of name/title/email/etc); `summary` is a
    short string the HUD panel renders verbatim. The node's Neo4j labels
    (`agent`, `identity`, `note`, …) come back as `labels` so the frontend
    can colorize by kind later.
    """
    props = dict(node.items())
    labels = list(node.labels)

    label_keys = ("name", "title", "email", "username", "label")
    label = next((str(props[k]) for k in label_keys if props.get(k)), None)
    if label is None:
        if "input" in labels and "note" in labels:
            content = str(props.get("content", "")).strip()
            label = (content[:40] + "…") if len(content) > 40 else (content or "(empty note)")
        elif "agent" in labels:
            label = f"agent #{props.get('auth_user_id', '?')}"
        elif "source" in labels:
            label = f"{props.get('provider_name', '?')} source"
        elif "identity" in labels:
            label = f"{props.get('provider_name', '?')}:{props.get('external_id', '?')}"
        elif "provider" in labels:
            label = f"provider:{props.get('name', '?')}"
        else:
            label = (labels[0] if labels else "node")

    # Summary: prefer a content-ish field; fall back to a compact prop dump.
    summary_keys = ("content", "summary", "description", "body", "text", "email")
    summary = next((str(props[k]) for k in summary_keys if props.get(k)), "")
    if not summary:
        skip = set(label_keys) | {"meta", "note_id", "auth_user_id"}
        remaining = {k: v for k, v in props.items() if k not in skip and v not in (None, "")}
        if remaining:
            summary = " · ".join(f"{k}: {v!s}" for k, v in list(remaining.items())[:4])
    if len(summary) > 280:
        summary = summary[:277] + "…"

    created_at = props.get("created_at")
    if created_at is not None and not isinstance(created_at, (str, int, float)):
        # neo4j DateTime → ISO 8601 so the frontend can `new Date(...)` it.
        created_at = created_at.iso_format() if hasattr(created_at, "iso_format") else str(created_at)

    return {
        "id": node.element_id,
        "label": label,
        "labels": labels,
        "summary": summary,
        "created_at": created_at,
        "kind": props.get("kind"),
    }


def _rel_payload(rel) -> dict[str, Any]:
    return {
        "id": rel.element_id,
        "src": rel.start_node.element_id,
        "dst": rel.end_node.element_id,
        "type": rel.type,
    }


def user_subgraph(viewer: Viewer) -> GraphSlice:
    """Strict-ownership view. Caller already passed `bootstrap` so the user's
    own framework nodes are guaranteed to exist."""
    with _driver().session() as session:
        rec = session.run(_FRAMEWORK_CYPHER, auth_user_id=viewer.auth_user_id).single()
        if rec is None:
            return GraphSlice(nodes=[], edges=[], note_count=0)

        framework: list = [rec["agent"]]
        for key in ("identities", "identity_providers", "sources", "source_providers"):
            framework.extend(rec[key] or [])

        # Cap notes to (MAX_NODES - len(framework)) so the total node count
        # stays under MAX_NODES. Reserve at least 1 slot.
        notes_cap = max(1, MAX_NODES - len(framework))
        rec_notes = session.run(_NOTES_CYPHER, auth_user_id=viewer.auth_user_id, cap=notes_cap).single()
        notes = list(rec_notes["notes"]) if rec_notes else []

        # Dedupe by element_id (an agent could in principle appear in
        # multiple OPTIONAL MATCH branches — the DISTINCT in cypher handles
        # framework-vs-framework, but a note collected as both author-node
        # and source-node would collide here).
        seen: set[str] = set()
        all_nodes = []
        for n in framework + notes:
            if n is None or n.element_id in seen:
                continue
            seen.add(n.element_id)
            all_nodes.append(n)

        if len(all_nodes) > MAX_NODES:
            all_nodes = all_nodes[:MAX_NODES]

        ids = [n.element_id for n in all_nodes]
        rels = list(session.run(_EDGES_CYPHER, ids=ids).value()) if len(ids) >= 2 else []

    return GraphSlice(
        nodes=[_node_payload(n) for n in all_nodes],
        edges=[_rel_payload(r) for r in rels],
        note_count=len(notes),
    )


# --- write: textarea note ---------------------------------------------------

# CREATE the new note (uuid in `note_id` and `external_id`, so the
# (provider, chat, ext_id) uniqueness constraint is satisfied trivially).
# Then chain to the most recent prior note from the same identity in the
# same source by created_at — and *only* by created_at (per the spec we
# omit sent_at chains, reply chains, and overrides).
_CREATE_NOTE_CYPHER = """
MATCH (a:agent {auth_user_id: $auth_user_id})
MATCH (i:identity {provider_name: $auth_provider, external_id: $auth_user_id})
MATCH (s:source {provider_name: $explorer_provider, external_id: $auth_user_id})

CREATE (n:input:note {
    note_id: $note_id,
    provider_name: $explorer_provider,
    external_chat_id: $auth_user_id,
    external_id: $note_id,
    content: $content,
    created_at: datetime(),
    meta: $meta_json
})
MERGE (n)-[:author]->(i)
MERGE (n)-[:source]->(s)

WITH n, s, i
OPTIONAL MATCH (prev:input:note)-[:author]->(i)
WHERE (prev)-[:source]->(s)
  AND prev.note_id <> n.note_id
  AND prev.created_at < n.created_at
WITH n, prev ORDER BY prev.created_at DESC LIMIT 1
FOREACH (_ IN CASE WHEN prev IS NOT NULL THEN [1] ELSE [] END |
    MERGE (n)-[:chained {kind: 'created_at'}]->(prev)
)

RETURN n.note_id AS note_id
""".strip()


def create_note(viewer: Viewer, content: str) -> str:
    """Persist a textarea note. Returns the new note_id. Caller has already
    bootstrapped the viewer (so the agent/identity/source MATCH succeeds)."""
    text = (content or "").strip()
    if not text:
        raise ValueError("note content is empty")
    if len(text.encode("utf-8")) > MAX_NOTE_BYTES:
        raise ValueError(f"note content exceeds {MAX_NOTE_BYTES} bytes")

    note_id = str(uuid.uuid4())
    meta = {
        "submitted_via": "explorer-textarea",
        "submitted_at": datetime.now(tz=timezone.utc).isoformat(),
    }
    params = {
        "auth_user_id": viewer.auth_user_id,
        "auth_provider": PROVIDER_AUTH,
        "explorer_provider": PROVIDER_EXPLORER,
        "note_id": note_id,
        "content": text,
        "meta_json": json.dumps(meta, separators=(",", ":")),
    }
    with _driver().session() as session:
        rec = session.execute_write(lambda tx: tx.run(_CREATE_NOTE_CYPHER, **params).single())
    return (rec["note_id"] if rec else note_id)
