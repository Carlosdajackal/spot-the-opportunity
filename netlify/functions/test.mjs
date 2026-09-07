// netlify/functions/test.mjs — Stage 3: Test (online validation).
//
// Uses Anthropic's server-side web search tool to find real public
// discussion of the student's problem. See spot.mjs for the shared
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

const MAX_TOKENS = 3000;

const SYSTEM_PROMPT = `You are a market research analyst helping a UK university entrepreneurship student validate whether a problem is real and urgent, by finding what real people say about it in public online discussions.

ABSOLUTE RULE ON QUOTES. Every quote you return must be text you actually retrieved from a real page in your search results, with the URL of that page. Never invent, paraphrase into quote marks, reconstruct, or approximate a quote. Never produce a quote you cannot attribute to a specific URL you actually retrieved. If you find only two usable quotes, return two. If you find none, return none and say so. Returning fewer real quotes is always correct; inventing one to fill a quota is a serious failure that teaches this student something false about their business. Do not compensate for weak results by writing plausible-sounding ones.

Method:
1. From the Who and What, identify at least three online communities where this audience discusses their problems. Prioritise Reddit, but Hacker News, Stack Exchange sites, Quora, and public trade or hobbyist forums are all valid.
2. Search using this pattern, substituting market keywords from the problem statement and audience:
   {keywords} (site:reddit.com inurl:comments|inurl:thread | intext:"I think"|"I feel"|"my experience"|"my biggest struggle"|"struggles"|"problems"|"issues"|"challenge"|"difficulties"|"pain point"|"barriers"|"obstacles"|"frustrations"|"what I wish I knew"|"what I regret")
   Vary keywords across searches. Run additional searches on other named communities where useful.
3. Identify distinct pain points and unmet needs. Group them into categories such as Problems with Existing Solutions, Emotional Challenges, Unmet Needs. For each: a one or two sentence summary, the real quotes you found with their URLs, and how frequently and intensely it appeared.
4. Compare what you found against the student's own Stage 2 root cause. State plainly whether real conversations align with it or point somewhere different. Do not soften a genuine mismatch: discovering the root cause was wrong is a valuable result, not a failure.
5. Judge severity. Frustration, urgency and desperation indicate a MIGRAINE, a problem needing an urgent fix. Mild interest or convenience indicates a HEADACHE, a nice-to-have. Score 0 to 100, where 60 and above is a migraine.
6. If the score is below 60, give concrete advice on sharpening it: focusing the pain (lost time, money, confidence or opportunity), tightening the audience to a smaller clearer group, or narrowing to a specific scenario or trigger.
7. If your searches returned little usable material, say so honestly in evidence_note and score conservatively. Thin evidence is not evidence of a headache; it may mean the search terms were wrong. Say which.

Return ONLY a single valid JSON object, no markdown fences:
{"pain_points":[{"category":"...","summary":"...","frequency":"...","quotes":[{"text":"...","url":"...","source":"..."}]}],"root_cause_comparison":{"student_root_cause":"...","evidence_suggests":"...","verdict":"aligned|partly aligned|different","explanation":"..."},"priority_ranking":[{"pain_point":"...","rationale":"..."}],"score":0,"verdict":"migraine|headache","reasoning":"...","sharpening_advice":["..."],"evidence_note":"..."}

priority_ranking ranks pain points by frequency, intensity, specificity and solvability. sharpening_advice is an empty array when the score is 60 or above.`;

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
  const who = cleanInput(body?.who);
  const what = cleanInput(body?.what);
  const when = cleanInput(body?.when);
  const how = cleanInput(body?.how);
  const why = cleanInput(body?.why);
  const rootCause = cleanInput(body?.rootCause);

  if (!statement || !who || !what || !rootCause) {
    return badRequestResponse("Missing results from earlier stages — please complete Spot and Dig first.");
  }

  const rateCheck = await checkAndReserveRateLimit({ ip: context.ip, sessionId: getSessionId(req) });
  if (!rateCheck.allowed) {
    return rateLimitedResponse(rateCheck.message);
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
    const parsed = await callClaudeForJSON({
      apiKey,
      maxTokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
    });

    return jsonResponse(sanitizeResult(parsed, rootCause), 200);
  } catch {
    return upstreamErrorResponse("Something went wrong testing your problem. Please try again.");
  }
};

export const config = {
  path: "/api/test",
};

// Hard backstop: a quote with no real URL must never reach a student, no
// matter what the model returned. This is enforced here in code, not left
// to the prompt alone.
function isValidHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function sanitizeResult(parsed, rootCause) {
  const painPoints = Array.isArray(parsed?.pain_points)
    ? parsed.pain_points.map((p) => ({
        category: String(p?.category ?? ""),
        summary: String(p?.summary ?? ""),
        frequency: String(p?.frequency ?? ""),
        quotes: Array.isArray(p?.quotes)
          ? p.quotes
              .filter((q) => isValidHttpUrl(q?.url))
              .map((q) => ({
                text: String(q?.text ?? ""),
                url: String(q.url).trim(),
                source: String(q?.source ?? ""),
              }))
          : [],
      }))
    : [];

  const comparison = parsed?.root_cause_comparison ?? {};
  const comparisonVerdict = ["aligned", "partly aligned", "different"].includes(comparison?.verdict)
    ? comparison.verdict
    : "different";

  const priorityRanking = Array.isArray(parsed?.priority_ranking)
    ? parsed.priority_ranking.map((r) => ({
        pain_point: String(r?.pain_point ?? ""),
        rationale: String(r?.rationale ?? ""),
      }))
    : [];

  const scoreNum = Number(parsed?.score);
  const score = Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : 0;
  const verdict = parsed?.verdict === "migraine" || (parsed?.verdict !== "headache" && score >= 60) ? "migraine" : "headache";

  const sharpeningAdvice = Array.isArray(parsed?.sharpening_advice) ? parsed.sharpening_advice.map((a) => String(a)) : [];

  return {
    pain_points: painPoints,
    root_cause_comparison: {
      student_root_cause: String(comparison?.student_root_cause ?? rootCause),
      evidence_suggests: String(comparison?.evidence_suggests ?? ""),
      verdict: comparisonVerdict,
      explanation: String(comparison?.explanation ?? ""),
    },
    priority_ranking: priorityRanking,
    score,
    verdict,
    reasoning: String(parsed?.reasoning ?? ""),
    sharpening_advice: verdict === "migraine" ? [] : sharpeningAdvice,
    evidence_note: String(parsed?.evidence_note ?? ""),
  };
}
