// Wrappers around the existing FastAPI endpoints. The backend is unchanged
// shape — `/api/graph` and `/api/notes` only.

export async function fetchGraph() {
  const res = await fetch("/api/graph", { credentials: "same-origin" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`graph fetch ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export async function postNote(content) {
  const res = await fetch("/api/notes", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`save failed (${res.status}): ${text || res.statusText}`);
  }
  return res.json();
}
