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
  return extractJSON(data);
}

// Pulls the model's JSON answer out of the response. Doesn't assume the
// answer is content[0] or the only text block — with tools enabled (web
// search) the content array can interleave tool_use/tool_result blocks
// with the model's own text, and even without tools a stray block could
// precede the answer. Concatenating every text block and then slicing from
// the first "{" to the last "}" is robust to both stray leading blocks and
// the model narrating briefly before its final JSON.
function extractJSON(data) {
  const textBlocks = Array.isArray(data?.content)
    ? data.content
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n")
    : "";

  const match = textBlocks.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : textBlocks;

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Could not parse model response as JSON");
  }
}
