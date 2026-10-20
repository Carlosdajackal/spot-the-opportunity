// netlify/functions/spot.mjs — Stage 1: Spot.
//
// Server-side only. Holds the Anthropic key via Netlify.env.get() and is the
// ONLY thing that ever talks to the Anthropic API for this stage. The
// browser only ever calls this site's own /api/spot endpoint.
//
// No submitted text is logged, saved, or persisted anywhere. Netlify Blobs
// (via lib/rate-limit.mjs) is used only to store small numeric counters for
// rate limiting (never the student's actual answers).

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

const SYSTEM_PROMPT = `You help UK university entrepreneurship students turn a rough idea into a narrow, specific problem statement, in the exact "Spot the Opportunity" format used at the University of East London.

Reference example of the target format and level of specificity:
Statement: "Independent fashion brands struggle to produce and sell clothing sustainably while keeping prices affordable for everyday consumers."
Who: "Independent and small fashion brands, designers, and start-ups selling to everyday consumers."
What: "They find it difficult to balance sustainable production with prices customers are willing to pay."
When: "During product design, sourcing, production, pricing, and when launching collections to market."
How: "They use more ethical materials and suppliers, which cost more, while competing against cheaper fast-fashion alternatives."
Why: "Because sustainable fashion systems are more expensive and complex, and consumers are price-sensitive despite caring about sustainability."

Given the student's rough description of (a) the problem they think exists and, optionally, (b) what they are building:
1. Find the real underlying problem, not the solution. Students often describe their solution as if it were the problem. If so, work backwards to name the actual pain point their solution implies. If no solution was given, work from the problem alone: do not guess, infer, suggest or hint at any solution, product or idea anywhere in your output (including the statement, "how", "why" and assumptions). "How" describes how people cope with the problem today, never what could be built to fix it. Any assumptions you note must be about the problem itself (who is affected, when it happens), never about a possible solution.
2. Narrow it hard. Reject "everyone" or "people" as a who. Reject "in general" or "these days" as a when. Name a specific group and a specific triggering moment or context.
3. Write ONE problem statement sentence in the same register and length as the example.
4. Fill who/what/when/how/why as short phrases matching the terseness of the example. why starts with "Because...".
5. If the input was too vague to narrow confidently, still give your best attempt but note briefly what you assumed. If nothing was guessed, return an empty string for assumptions.
The student may have used voice input, so expect transcription errors and interpret obvious mis-transcriptions charitably.

Return ONLY a single valid JSON object, no markdown fences, no commentary: {"statement":"...","who":"...","what":"...","when":"...","how":"...","why":"...","assumptions":"..."}`;

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

  const problem = cleanInput(body?.problem);
  const idea = cleanInput(body?.idea);

  if (!problem) {
    return badRequestResponse("Please describe the problem you're working on.");
  }

  const rateCheck = await checkAndReserveRateLimit({ ip: context.ip, sessionId: getSessionId(req) });
  if (!rateCheck.allowed) {
    return rateLimitedResponse(rateCheck.message);
  }

  try {
    const parsed = await callClaudeForJSON({
      apiKey,
      maxTokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: idea
            ? `The problem the student thinks they're solving: ${problem}\n\nWhat they are building (their idea/solution): ${idea}`
            : `The problem the student is working on: ${problem}\n\nThe student has not described a solution. Work only from the problem and do not introduce one.`,
        },
      ],
    });

    return jsonResponse(
      {
        statement: String(parsed.statement ?? ""),
        who: String(parsed.who ?? ""),
        what: String(parsed.what ?? ""),
        when: String(parsed.when ?? ""),
        how: String(parsed.how ?? ""),
        why: String(parsed.why ?? ""),
        assumptions: String(parsed.assumptions ?? ""),
      },
      200
    );
  } catch {
    return upstreamErrorResponse("Something went wrong generating your statement. Please try again.");
  }
};

export const config = {
  path: "/api/spot",
};
