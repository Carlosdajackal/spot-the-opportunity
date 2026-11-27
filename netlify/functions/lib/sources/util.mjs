// netlify/functions/lib/sources/util.mjs — small helpers shared by every
// Stage 3 source adapter.
//
// Every adapter returns plain "items" of the same shape, so the synthesis
// step never needs to know which API an item came from:
//   { source, sourceLabel, group, url, title, text, signals }
// `group` is decided by the adapter, never the model: "people" (places
// where real people complain — the only items that can count towards the
// score), "cost" (regulators, incidents, CVEs) or "research" (papers).

export const MAX_RESULTS_PER_SOURCE = 10;
export const SOURCE_TIMEOUT_MS = 12000; // per HTTP request
export const USER_AGENT = "SpotTheOpportunity/1.0 (UEL Careers and Student Enterprise problem-validation tool)";

const MAX_ITEM_TEXT = 700;

export class SkipSource extends Error {}

export async function fetchJSON(url, { headers = {}, method = "GET", body, timeoutMs = SOURCE_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    method,
    body,
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchText(url, { headers = {}, timeoutMs = SOURCE_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/" };

export function stripHtml(html) {
  return String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?[a-z0-9]+);/gi, (match, name) => {
      if (ENTITIES[name] !== undefined) return ENTITIES[name];
      if (/^#\d+$/.test(name)) return String.fromCodePoint(Number(name.slice(1)));
      if (/^#x[0-9a-f]+$/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
      return match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

export function clip(text, max = MAX_ITEM_TEXT) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

// Plan fields come from the model, so treat every one as untrusted input:
// strings only, trimmed, capped in length and count.
export function cleanList(value, { max = 6, maxLength = 120 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === "string")
    .map((v) => v.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, max);
}

export function makeItem({ source, sourceLabel, group, url, title, text, signals }) {
  return {
    source,
    sourceLabel,
    group,
    url: String(url ?? "").trim(),
    title: clip(title, 200),
    text: clip(text),
    signals: clip(signals, 200),
  };
}

// Runs a list of async jobs and keeps whatever succeeded. Used inside an
// adapter that makes several requests (one per query/site), so one failed
// query doesn't throw away the others. If every job failed, rethrows the
// first error so the adapter is reported as an error, not "no results".
export async function settleAll(jobs) {
  const results = await Promise.allSettled(jobs.map((job) => job()));
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!ok.length && results.length) {
    throw results[0].reason;
  }
  return ok;
}
