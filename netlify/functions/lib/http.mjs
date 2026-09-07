// netlify/functions/lib/http.mjs — small shared helpers used by all three endpoints.

export const MAX_FIELD_LENGTH = 1200;

export function cleanInput(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_FIELD_LENGTH);
}

export function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function notConfiguredResponse() {
  return jsonResponse(
    {
      error: "not_configured",
      message: "Spot the Opportunity isn't switched on yet — the site owner still needs to add an API key.",
    },
    503
  );
}

export function methodNotAllowedResponse() {
  return jsonResponse({ error: "method_not_allowed", message: "Please use the page." }, 405);
}

export function badRequestResponse(message) {
  return jsonResponse({ error: "bad_request", message }, 400);
}

export function rateLimitedResponse(message) {
  return jsonResponse({ error: "rate_limited", message }, 429);
}

export function upstreamErrorResponse(message) {
  return jsonResponse({ error: "upstream_error", message }, 502);
}

// Students' devices generate a random session id (stored in localStorage)
// and send it on every request so the session-based rate limit in
// lib/rate-limit.mjs has something to key on. Missing/malformed headers
// just fall back to "anonymous", which is still bound by the IP backstop.
export function getSessionId(req) {
  const raw = req.headers.get("x-session-id") || "";
  return raw.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
}
