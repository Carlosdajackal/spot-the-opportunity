// netlify/functions/dig.mjs — Stage 2: Dig (Five Whys review).
//
// The student writes all five "why" answers themselves; this endpoint is
// called ONCE per review, after all five are submitted — never once per
// why — to keep cost down. Server-side only; see spot.mjs for the shared
// architecture notes (no secrets client-side, no data stored, etc).

import { callClaudeForJSON } from "./lib/anthropic.mjs";
import { checkAndReserveRateLimit } from "./lib/rate-limit.mjs";
import {
  badRequestResponse,
  cleanInput,
  getSessionId,
  jsonResponse,
  methodNotAllowedResponse,
  notConfiguredResponse,
  rateLimitedResponse,
  upstreamErrorResponse,
} from "./lib/http.mjs";

const MAX_TOKENS = 1000;
const WHY_COUNT = 5;

const SYSTEM_PROMPT = `You are reviewing a UK university entrepreneurship student's Five Whys chain. They are digging from a surface problem to a root cause. You are a coach, not a rewriter: do not replace their thinking, sharpen it.

You will receive their problem statement and their five "why" answers in order.

Assess the chain:
1. Does each why genuinely go deeper, or does one restate the previous answer in different words? Restating is the most common failure — flag it plainly.
2. Does any step jump too far, skipping a link in the causal chain?
3. Does the fifth answer read like a genuine root cause (a systemic or structural condition) or still a symptom?
4. Is any step an assumption presented as fact, which they would need to check?

Then state the root cause their chain actually arrives at, in one sentence, in their own terms. Do not substitute a better root cause of your own invention.

Be encouraging and specific. Address the student directly as "you". Never condescend. If the chain is strong, say so plainly rather than inventing criticism.

Return ONLY a single valid JSON object, no markdown fences: {"root_cause":"...","strength":"strong|workable|needs_work","feedback":["...","..."],"deeper_prompt":"..."}

feedback: 2 to 4 short observations, each one sentence.
deeper_prompt: one question they could ask themselves to push the chain further, or an empty string if the chain is already solid.`;

export default async (req, context) => {
  if (req.method !== "POST") {
    return methodNotAllowedResponse();
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return notConfiguredResponse();
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return badRequestResponse("Couldn't read your answers. Please try again.");
  }

  const statement = cleanInput(body?.statement);
  const whys = Array.isArray(body?.whys) ? body.whys.map(cleanInput) : [];

  if (!statement) {
    return badRequestResponse("Missing your problem statement from Stage 1.");
  }
  if (whys.length !== WHY_COUNT || whys.some((w) => !w)) {
    return badRequestResponse("Please answer all five whys before reviewing.");
  }

  const rateCheck = await checkAndReserveRateLimit({ ip: context.ip, sessionId: getSessionId(req) });
  if (!rateCheck.allowed) {
    return rateLimitedResponse(rateCheck.message);
  }

  const whysBlock = whys.map((w, i) => `Why ${i + 1}: ${w}`).join("\n");

  try {
    const parsed = await callClaudeForJSON({
      apiKey,
      maxTokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Problem statement: ${statement}\n\n${whysBlock}`,
        },
      ],
    });

    const strength = ["strong", "workable", "needs_work"].includes(parsed.strength) ? parsed.strength : "workable";
    const feedback = Array.isArray(parsed.feedback) ? parsed.feedback.map((f) => String(f)) : [];

    return jsonResponse(
      {
        root_cause: String(parsed.root_cause ?? ""),
        strength,
        feedback,
        deeper_prompt: String(parsed.deeper_prompt ?? ""),
      },
      200
    );
  } catch {
    return upstreamErrorResponse("Something went wrong reviewing your chain. Please try again.");
  }
};

export const config = {
  path: "/api/dig",
};
