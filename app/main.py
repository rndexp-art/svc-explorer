"""FastAPI app for the rndexp.art explorer.

Routes:
  GET  /healthz       liveness, unauthenticated.
  GET  /              the 3D scene (HTML + Three.js, all client-side).
  GET  /api/graph     JSON {nodes, edges, viewer} for the signed-in user.
  POST /api/notes     create an :input:note from the textarea composer.

Authn: every route except /healthz requires a valid auth header set, enforced
by `app.auth.require_user`. No role check — any signed-in user is welcome to
explore. Strict ownership is enforced inside the graph layer; no caller-
controlled query parameters affect what gets returned.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Body, Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from neo4j.exceptions import Neo4jError, ServiceUnavailable
from pydantic import BaseModel, Field

from . import graph
from .auth import AuthedUser, require_user


log = logging.getLogger("explorer")
logging.basicConfig(level=logging.INFO)


TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Idempotent: re-runs `CREATE CONSTRAINT … IF NOT EXISTS` so the explorer
    # works even if the telegram-bot writer hasn't run yet (fresh DB).
    try:
        graph.ensure_schema()
    except ServiceUnavailable as e:
        # Don't block startup if neo4j is briefly unreachable — first request
        # will retry (and surface a 503 to the user, not a crashloop).
        log.warning("neo4j unavailable at startup, deferring schema: %s", e)
    yield
    graph.close()


app = FastAPI(title="rndexp-art explorer", docs_url=None, redoc_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def _wrap_neo4j(fn):
    """Convert neo4j-driver exceptions into HTTP errors with safe messages."""
    try:
        return fn()
    except ServiceUnavailable as e:
        log.warning("neo4j unavailable: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="graph backend unavailable",
        )
    except Neo4jError as e:
        log.exception("neo4j query failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"graph query failed: {e.code}",
        )


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/", response_class=HTMLResponse)
def index(request: Request, me: Annotated[AuthedUser, Depends(require_user)]):
    return templates.TemplateResponse(
        request,
        "index.html",
        {"me": me},
    )


@app.get("/api/graph")
def api_graph(me: Annotated[AuthedUser, Depends(require_user)]):
    viewer = me.viewer()
    _wrap_neo4j(lambda: graph.bootstrap(viewer))
    slice_ = _wrap_neo4j(lambda: graph.user_subgraph(viewer))
    return JSONResponse({
        "nodes": slice_.nodes,
        "edges": slice_.edges,
        "note_count": slice_.note_count,
        "viewer": {"email": me.email, "sub": me.sub},
    })


class NoteIn(BaseModel):
    content: str = Field(min_length=1, max_length=64 * 1024)


@app.post("/api/notes", status_code=status.HTTP_201_CREATED)
def api_create_note(
    me: Annotated[AuthedUser, Depends(require_user)],
    body: Annotated[NoteIn, Body()],
):
    viewer = me.viewer()
    _wrap_neo4j(lambda: graph.bootstrap(viewer))
    try:
        note_id = _wrap_neo4j(lambda: graph.create_note(viewer, body.content))
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return {"note_id": note_id}
