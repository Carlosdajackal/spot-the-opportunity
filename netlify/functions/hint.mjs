// netlify/functions/hint.mjs — Stage 2: Dig, one hint for one "why".
//
// Students get 2 hints across the whole Five Whys (the cap lives in the
// browser — see app.js — because the server can't tell a new problem
// from a page refresh; the shared rate limit still bounds cost). Each hint
// is a guiding question about the student's own previous answer, plus one
// example answer they can use or adapt if they're stuck. The example is
// only ever shown, never written into their answer box.
//
// Server-side only; see spot.mjs for the shared architecture notes. Like
// every endpoint, nothing the student sends or gets back is stored or
// logged.

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

const MAX_TOKENS = 400;
const WHY_COUNT = 5;

const SYSTEM_PROMPT = `You help a UK final-year university student who is stuck partway through a Five Whys exercise. They are digging from a business problem towards its root cause, one "why" at a time. Give them a hint for the "why" they are on now.

What the hint is about:
- For Why 1: what causes the problem in their problem statement, especially its "because" reason.
- For Why 2 to 5: what causes their answer to the previous why. Work from THEIR answer, not from what you think the chain should be.

The hint has two parts:
1. "nudge": one short sentence, a question or a direction to think in, about their previous answer (or, for Why 1, the problem statement). Point towards causes: people, habits, incentives, rules, time, money, knowledge, or how the system is set up. If their previous answer is a symptom, or says the same thing as an earlier answer or the problem statement in different words, say so gently first, for example: "That sounds like the same point said differently. What causes it?"
2. "suggested_answer": one sentence the student could write in the box for this why, if they are really stuck. Write it plainly, as a statement of cause in the same register as their own answers (no "I think", no "Maybe"). It must go exactly one step deeper than their previous answer: a cause of it, not a restatement of it, and not a leap straight to a final root cause.

Rules for both parts:
- Never suggest a solution, product, app, platform, tool, feature or fix. Both parts are about WHY something happens, never what to do about it.
- UK English spelling. Plain words a final-year student would use. No jargon unless they used it first.
- Keep each part under 35 words.

Return ONLY a single valid JSON object, no markdown fences: {"nudge":"...","suggested_answer":"..."}`;

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
    return badRequestResponse("Couldn't get a hint, try again.");
  }

  const statement = cleanInput(body?.statement);
  const because = cleanInput(body?.because);
  const why = Number(body?.why);
  const whys = Array.isArray(body?.whys) ? body.whys.slice(0, WHY_COUNT - 1).map(cleanInput) : [];

  if (!statement) {
    return badRequestResponse("Missing your problem statement from Stage 1.");
  }
  if (!Number.isInteger(why) || why < 1 || why > WHY_COUNT) {
    return badRequestResponse("Couldn't get a hint, try again.");
  }
  // A hint for Why n is about the answer to Why n-1, so that one must exist.
  if (why > 1 && (whys.length < why - 1 || !whys[why - 2])) {
    return badRequestResponse("Write your answer to the previous Why first, then ask for a hint.");
  }

  const rateCheck = await checkAndReserveRateLimit({ ip: context.ip, sessionId: getSessionId(req) });
  if (!rateCheck.allowed) {
    return rateLimitedResponse(rateCheck.message);
  }

  const answered = whys.slice(0, why - 1).map((w, i) => `Why ${i + 1}: ${w}`);
  const content = [
    `Problem statement: ${statement}`,
    because ? `Its "because" reason: ${because}` : null,
    "",
    answered.length ? `Their answers so far:\n${answered.join("\n")}` : "They haven't answered any whys yet.",
    "",
    `They are stuck on Why ${why}.`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  try {
    const parsed = await callClaudeForJSON({
      apiKey,
      maxTokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });

    const nudge = String(parsed?.nudge ?? "").trim();
    const suggestedAnswer = String(parsed?.suggested_answer ?? "").trim();
    if (!nudge || !suggestedAnswer) {
      throw new Error("Incomplete hint");
    }

    return jsonResponse({ nudge, suggested_answer: suggestedAnswer }, 200);
  } catch {
    return upstreamErrorResponse("Couldn't get a hint, try again.");
  }
};

export const config = {
  path: "/api/hint",
};
