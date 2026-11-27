// netlify/functions/test-background.mjs — Stage 3: Test (online validation).
//
// This is a Netlify BACKGROUND function (note the -background suffix,
// which is what makes it one — the exported `path` below still maps the
// externally-visible URL to /api/test). It exists because a web-search-
// backed validation with synthesis routinely takes well over Netlify's
// ~30s synchronous function limit; a background function gets a 15-minute
// ceiling instead. The tradeoff is that callers can't get a response body
// back directly — the client kicks this off, then polls test-status.mjs
// (which reads the same Netlify Blobs job record) until it's done. See
// app.js's runTest()/pollTestJob() for the client side of this.
//
// Server-side only — see spot.mjs for the shared architecture notes (no
// secrets client-side, no data stored beyond the transient job record
// below, etc).

import { getStore } from "@netlify/blobs";
import { checkAndReserveRateLimit } from "./lib/rate-limit.mjs";
import { cleanInput, getSessionId } from "./lib/http.mjs";
import { runSources } from "./lib/sources/index.mjs";
import { buildResult, planAudienceMap, synthesise } from "./lib/test-pipeline.mjs";

// How Stage 3 works (plan where to look, search those sources in parallel,
// label every item, score only first-hand accounts) is documented at the
// top of lib/test-pipeline.mjs. The sources themselves live in
// lib/sources/, one file per API.
const JOB_STORE = "test-jobs";

export default async (req, context) => {
  if (req.method !== "POST") return;

  let body;
  try {
    body = await req.json();
  } catch {
    return; // no jobId to report failure against
  }

  const jobId = typeof body?.jobId === "string" ? body.jobId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) : "";
  if (!jobId) return;

  const store = getStore(JOB_STORE);
  await store.setJSON(jobId, { status: "pending" });

  const statement = cleanInput(body?.statement);
  const who = cleanInput(body?.who);
  const what = cleanInput(body?.what);
  const when = cleanInput(body?.when);
  const how = cleanInput(body?.how);
  const why = cleanInput(body?.why);
  const rootCause = cleanInput(body?.rootCause);

  if (!statement || !who || !what || !rootCause) {
    await store.setJSON(jobId, {
      status: "error",
      message: "Missing results from earlier stages — please complete Spot and Dig first.",
    });
    return;
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    await store.setJSON(jobId, {
      status: "error",
      message: "Spot the Opportunity isn't switched on yet — the site owner still needs to add an API key.",
    });
    return;
  }

  const rateCheck = await checkAndReserveRateLimit({ ip: context.ip, sessionId: getSessionId(req) });
  if (!rateCheck.allowed) {
    await store.setJSON(jobId, { status: "error", message: rateCheck.message });
    return;
  }

  const userMessage = [
    `Problem statement: ${statement}`,
    `Who: ${who}`,
    `What: ${what}`,
    when ? `When: ${when}` : null,
    how ? `How: ${how}` : null,
    why ? `Why: ${why}` : null,
    `Student's Stage 2 root cause: ${rootCause}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const plan = await planAudienceMap({ apiKey, problemText: userMessage });
    const { items, report } = await runSources(plan.sources, { apiKey });
    const parsed = await synthesise({ apiKey, problemText: userMessage, plan, items });

    await store.setJSON(jobId, {
      status: "done",
      result: buildResult({ parsed, items, plan, sourceReport: report, rootCause }),
    });
  } catch {
    await store.setJSON(jobId, {
      status: "error",
      message: "Something went wrong testing your problem. Please try again.",
    });
  }
};

export const config = {
  path: "/api/test",
};
