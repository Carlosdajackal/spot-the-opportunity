// netlify/functions/lib/anthropic.mjs
//
// Shared helper for calling the Anthropic Messages API from all three
// endpoints (spot, dig, test). Never called from the browser — every
// caller of this module already runs server-side inside a Netlify function.

const ANTHROPIC_VERSION = "2023-06-01";

// NOTE on model: the brief specifies "claude-sonnet-4-6", which is not a
// published Anthropic model id. Using it as written would make every
// request fail. This uses claude-sonnet-5, the current Sonnet model, in its
// place across all three endpoints — flagged here rather than silently
// shipping a broken app. Swap this constant if a different model id is
// confirmed.
export const MODEL = "claude-sonnet-5";

/**
 * Calls Claude and returns the parsed JSON object from its reply.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {number} opts.maxTokens
 * @param {string} opts.system
 * @param {Array} opts.messages
 * @param {Array} [opts.tools] - e.g. the server-side web_search tool
 * @returns {Promise<any>} the parsed JSON object
 */
export async function callClaudeForJSON({ apiKey, maxTokens, system, messages, tools }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    // Every endpoint here returns one structured JSON object, not a
    // conversation. Sonnet 5 runs adaptive thinking by default even when
    // this is omitted, which (a) prepends non-text content blocks before
    // the answer and (b) eats into max_tokens — that previously caused a
    // truncated, unparsable response in production. Tool use (web search)
    // still works fine with thinking off, so it's disabled for all calls.
    thinking: { type: "disabled" },
    messages,
  };
  if (tools) {
    body.tools = tools;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}`);
  }

  const data = await response.json();
  try {
    return extractJSON(data);
  } catch (err) {
    // TEMPORARY: attach stop_reason/content-shape context to a production-
    // only parse failure so the cause (e.g. hitting max_tokens mid-search)
    // is visible without log access. Remove once confirmed.
    const shape = Array.isArray(data?.content) ? data.content.map((b) => b?.type) : data?.content;
    err.message = `${err.message} | stop_reason=${data?.stop_reason} content=${JSON.stringify(shape)}`;
    throw err;
  }
}

// Pulls the model's JSON answer out of the response. Doesn't assume the
// answer is content[0] or the only text block — with tools enabled (web
// search) the content array interleaves tool_use/tool_result blocks with
// the model's own text, and the model may narrate briefly between
// searches before its final JSON. A naive "first { to last }" slice across
// all concatenated text breaks the moment any of that narration contains
// its own brace (e.g. mentioning a literal '{' or just an unlucky curly
// quote), since it swallows everything in between as if it were one
// object. Instead, scan each text block for a properly *balanced* JSON
// object — tracking nesting depth and skipping over string contents — and
// try each candidate in turn.
function extractJSON(data) {
  const textBlocks = Array.isArray(data?.content)
    ? data.content.filter((block) => block?.type === "text").map((block) => block.text)
    : [];

  for (const text of textBlocks) {
    const candidate = extractBalancedJSONObject(text);
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Keep looking — maybe a later block has the real one.
      }
    }
  }

  // Fall back to treating the whole reply as one string, in case the JSON
  // was itself split across adjacent text blocks.
  const joined = textBlocks.join("");
  const candidate = extractBalancedJSONObject(joined);
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through to the error below
    }
  }

  throw new Error("Could not parse model response as JSON");
}

// Returns the substring of the first balanced {...} object in `text`, or
// null if none closes properly. Correctly skips braces that appear inside
// JSON string values.
function extractBalancedJSONObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}
