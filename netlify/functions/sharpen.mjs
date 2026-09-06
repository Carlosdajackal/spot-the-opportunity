// netlify/functions/sharpen.mjs
//
// Server-side only. Holds the Anthropic key via Netlify.env.get() and is the
// ONLY thing that ever talks to the Anthropic API. The browser only ever
// calls this site's own /api/sharpen endpoint.
//
// No submitted text is logged, saved, or persisted anywhere. Netlify Blobs
// is used only to store small numeric counters for rate limiting (never the
// student's actual answers).

import { getStore } from "@netlify/blobs";

// ---- Rate limit constants ----
const IP_HOURLY_LIMIT = 12; // generations per visitor IP per hour
const SITE_DAILY_LIMIT = 600; // generations per day, site-wide

// ---- Input constraints ----
const MAX_FIELD_LENGTH = 1200;

// NOTE on model: the brief specified "claude-sonnet-4-6", which is not a
// published Anthropic model id. Using it as written would make every
// request fail. This uses claude-sonnet-5, the current Sonnet model, in its
// place — flagged here and to Carl rather than silently shipping a broken
// endpoint. Swap this constant if a different model id is confirmed.
const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1000;

const SYSTEM_PROMPT = `You help UK university entrepreneurship students turn a rough idea into a narrow, specific problem statement, in the exact "Spot the Opportunity" format used at the University of East London.

Reference example of the target format and level of specificity:
Statement: "Small businesses across the UK are struggling to adapt to rapid digital transformation and economic uncertainty, with many lacking the data skills, innovation capacity, and workforce agility needed to stay competitive in a changing global market."
Who: "SMEs, start-ups, and business leaders."
What: "Pressure to digitise processes without resources and confidence."
When: "During times of economic volatility."
How: "Outdated systems, manual processes, or generic training."
Why: "Because rapid technological change and uncertainty make it difficult for businesses to invest in innovation while managing short-term survival."

Given the student's rough description of (a) the problem they think exists and (b) what they are building:
1. Find the real underlying problem, not the solution. Students often describe their solution as if it were the problem — if so, work backwards to name the actual pain point their solution implies.
2. Narrow it hard. Reject "everyone" or "people" as a who. Reject "in general" or "these days" as a when. Name a specific group and a specific triggering moment or context.
3. Write ONE problem statement sentence in the same register and length as the example.
4. Fill who/what/when/how/why as short phrases, matching the terseness of the example. why starts with "Because...".
5. If the input was too vague to narrow with confidence, still produce your best attempt, but note briefly what you had to assume. If nothing had to be guessed, return an empty string for assumptions.
The student may have used voice input, so expect transcription errors — interpret obvious mis-transcriptions charitably.

Return ONLY a single valid JSON object, no markdown fences, no commentary: {"statement": "...", "who": "...", "what": "...", "when": "...", "how": "...", "why": "...", "assumptions": "..."}`;

export default async (req, context) => {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Please use the form on the page." }, 405);
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json(
      {
        error: "not_configured",
        message: "Spot the Opportunity isn't switched on yet — the site owner still needs to add an API key.",
      },
      503
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request", message: "Couldn't read your answers. Please try again." }, 400);
  }

  const problem = cleanInput(body?.problem);
  const idea = cleanInput(body?.idea);

  if (!problem || !idea) {
    return json({ error: "bad_request", message: "Please fill in both fields." }, 400);
  }

  const rateCheck = await checkAndReserveRateLimit(context);
  if (!rateCheck.allowed) {
    return json({ error: "rate_limited", message: rateCheck.message }, 429);
  }

  try {
    const result = await callAnthropic(apiKey, problem, idea);
    return json(result, 200);
  } catch (err) {
    return json(
      { error: "upstream_error", message: "Something went wrong generating your statement. Please try again." },
      502
    );
  }
};

export const config = {
  path: "/api/sharpen",
};

function cleanInput(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_FIELD_LENGTH);
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Reserves one generation against both the per-IP hourly limit and the
// site-wide daily limit. Counters only — never stores the request content.
// Netlify Blobs has no built-in atomic increment, so this is read-then-write
// (last write wins); under heavy concurrent bursts the true count could
// drift slightly past the limit, which is an acceptable tradeoff for a
// cost-control guardrail rather than a hard security boundary.
async function checkAndReserveRateLimit(context) {
  const store = getStore("rate-limits");
  const now = new Date();
  const dayKey = `site:${now.toISOString().slice(0, 10)}`;
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  const ip = context.ip || "unknown";
  const ipKey = `ip:${ip}:${hourBucket}`;

  const [dayCount, ipCount] = await Promise.all([
    store.get(dayKey, { type: "json" }),
    store.get(ipKey, { type: "json" }),
  ]);

  if ((dayCount ?? 0) >= SITE_DAILY_LIMIT) {
    return {
      allowed: false,
      message: "Spot the Opportunity has reached its generation limit for today. Please try again tomorrow.",
    };
  }

  if ((ipCount ?? 0) >= IP_HOURLY_LIMIT) {
    return {
      allowed: false,
      message: "You've reached the hourly limit for this tool. Please try again in a bit.",
    };
  }

  await Promise.all([
    store.setJSON(dayKey, (dayCount ?? 0) + 1),
    store.setJSON(ipKey, (ipCount ?? 0) + 1),
  ]);

  return { allowed: true };
}

async function callAnthropic(apiKey, problem, idea) {
  const userMessage = `The problem the student thinks they're solving: ${problem}\n\nWhat they are building (their idea/solution): ${idea}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      // Sonnet 5 runs adaptive thinking by default even when this is
      // omitted, which (a) prepends a "thinking" content block before the
      // answer and (b) eats into max_tokens. Neither is useful for a fixed-
      // format JSON answer, so it's switched off explicitly.
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}`);
  }

  const data = await response.json();
  // Don't assume content[0] is the answer — a thinking block (or anything
  // else) could precede it. Find the first actual text block instead.
  const textBlock = Array.isArray(data?.content) ? data.content.find((block) => block?.type === "text") : null;
  const raw = textBlock?.text ?? "";

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Could not parse model response as JSON");
  }

  return {
    statement: String(parsed.statement ?? ""),
    who: String(parsed.who ?? ""),
    what: String(parsed.what ?? ""),
    when: String(parsed.when ?? ""),
    how: String(parsed.how ?? ""),
    why: String(parsed.why ?? ""),
    assumptions: String(parsed.assumptions ?? ""),
  };
}
