"""Authenticated-user gate.

The Caddy site for `explorer.rndexp.art` imports the `rndexp_auth_forward`
snippet defined by the auth service. That snippet calls `auth:8001/verify`
and, on 200, injects four headers into the upstream request:

    X-Auth-Sub          numeric user id, as a string
    X-Auth-Email        verified email
    X-Auth-Roles        comma-separated role slugs
    X-Auth-Permissions  comma-separated permission slugs
    X-Auth-Name         (optional) display name; not always set

On 401 the snippet 302s to the login page, so the explorer normally only
ever sees authenticated requests. We still re-check the headers as defense
in depth: if the gateway is misconfigured (or the explorer is reached by a
direct container hit), missing headers MUST 401.

Unlike the dashboard, no role check — any signed-in user can explore their
own slice of the graph.
"""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException, Request, status

from .graph import Viewer


@dataclass(frozen=True)
class AuthedUser:
    sub: int
    email: str
    name: str
    roles: list[str]
    permissions: list[str]

    def viewer(self) -> Viewer:
        """Project to the smaller struct the graph layer takes."""
        return Viewer(auth_user_id=self.sub, email=self.email, name=self.name)


def _split_csv(value: str) -> list[str]:
    return [s.strip() for s in value.split(",") if s.strip()]


def require_user(request: Request) -> AuthedUser:
    """FastAPI dependency: 401 if no auth headers, 401 if `sub` isn't an int.

    `sub` arrives as a string ("numeric user id, as a string" per the auth
    service's contract). We coerce to int here so downstream code — including
    the Cypher writes — uses a single canonical type for `auth_user_id`.
    """
    email = request.headers.get("x-auth-email", "").strip().lower()
    sub_raw = request.headers.get("x-auth-sub", "").strip()
    if not email or not sub_raw:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="auth headers missing — request did not pass forward_auth",
        )
    try:
        sub = int(sub_raw)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Auth-Sub is not numeric",
        )
    return AuthedUser(
        sub=sub,
        email=email,
        name=request.headers.get("x-auth-name", "").strip(),
        roles=_split_csv(request.headers.get("x-auth-roles", "")),
        permissions=_split_csv(request.headers.get("x-auth-permissions", "")),
    )
