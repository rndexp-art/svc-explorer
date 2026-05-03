# Explorer service — FastAPI + Three.js. Runs on port 8005.
#
# Mirrors the dashboard service Dockerfile shape: uv installs into the system
# Python from a pinned requirements.txt, no venv, non-root.
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv==0.5.11

WORKDIR /app

COPY requirements.txt pyproject.toml /app/
RUN uv pip install --system --no-cache -r requirements.txt

COPY app/ /app/app/

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin explorersvc \
    && chown -R explorersvc:explorersvc /app
USER explorersvc

EXPOSE 8005

ENTRYPOINT ["tini", "--"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8005", "--proxy-headers", "--forwarded-allow-ips", "*"]
