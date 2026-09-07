// netlify/functions/test-status.mjs — polling endpoint for Stage 3.
//
// test-background.mjs kicks off the (slow) web-search validation and
// writes its progress into a Netlify Blobs job record. The browser polls
// this fast, synchronous endpoint with the job id until the record reads
// "done" or "error". See app.js's pollTestJob().

import { getStore } from "@netlify/blobs";
import { badRequestResponse, jsonResponse, methodNotAllowedResponse } from "./lib/http.mjs";

const JOB_STORE = "test-jobs";

export default async (req) => {
  if (req.method !== "GET") {
    return methodNotAllowedResponse();
  }

  const url = new URL(req.url);
  const jobId = (url.searchParams.get("id") || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  if (!jobId) {
    return badRequestResponse("Missing job id.");
  }

  const store = getStore(JOB_STORE);
  const job = await store.get(jobId, { type: "json" });

  if (!job) {
    // Either the background function hasn't written its first "pending"
    // record yet (cold start lag), or the job id is unknown/expired.
    // Either way, "keep polling" is the right answer.
    return jsonResponse({ status: "pending" }, 200);
  }

  if (job.status === "done" || job.status === "error") {
    // Best-effort cleanup now that the client has the terminal result —
    // nothing about this job needs to persist any longer.
    store.delete(jobId).catch(() => {});
  }

  return jsonResponse(job, 200);
};

export const config = {
  path: "/api/test-status",
};
