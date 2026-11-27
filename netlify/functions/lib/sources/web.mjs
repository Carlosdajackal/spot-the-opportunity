// Sources reached through Anthropic's server-side web search tool, for
// places with no usable public API:
// - Forums and communities on the open web (The Student Room, Mumsnet,
//   Quora, specialist forums, and Reddit where search can reach it), plus
//   Google Play reviews (Google has no public reviews API, and scraping it
//   is against its terms). This search is deliberately NOT restricted to
//   reddit.com: restricting the tool to that domain fails with a 400, and
//   Reddit results rarely come back through it anyway, so a Reddit-only
//   search found nothing.
// - Regulator and public-health sites (ICO, CISA, NHS, ONS, WHO), as cost
//   evidence, restricted to those domains.
//
// Items are built ONLY from the search tool's citations: each citation's
// `cited_text` is text Anthropic retrieved from that URL, so the quote is
// real by construction. The model's own wording in this call is thrown
// away, so it can't invent or paraphrase a quote here.

import { callClaude } from "../anthropic.mjs";
import { MAX_RESULTS_PER_SOURCE, SkipSource, cleanList, makeItem } from "./util.mjs";

const WEB_TIMEOUT_MS = 90000;
const MAX_TOKENS = 4000;

export const REGULATOR_DOMAINS = ["ico.org.uk", "cisa.gov", "nhs.uk", "ons.gov.uk", "who.int"];

const SYSTEM_PROMPT = `You collect public evidence for a university student testing whether a problem is real. Run web searches using the queries you are given (adjust the wording if a search finds nothing useful). Then write a plain bullet list with one line per relevant result, saying in a few words what that page says about the problem. Only include results that actually discuss the problem. Do not add an introduction, conclusion or advice.`;

export async function searchWebForums(plans, { apiKey }) {
  const queries = cleanList(plans.forums?.queries, { max: 4 });
  const communities = cleanList(plans.forums?.communities, { max: 6, maxLength: 60 });
  const playApps = cleanList(plans.playstore?.apps, { max: 2, maxLength: 80 });
  if (!queries.length && !playApps.length) return [];

  const lines = [];
  if (queries.length) {
    lines.push(
      `Search for forum threads, community discussions and comments where people describe having this problem in their own words.` +
        (communities.length ? ` Look especially in: ${communities.join(", ")}.` : ""),
      `Queries: ${queries.map((q) => `"${q}"`).join("; ")}`
    );
  }
  if (playApps.length) {
    lines.push(`Also search Google Play (play.google.com) for user reviews and complaints about these apps: ${playApps.join(", ")}.`);
  }

  return runWebSearch({
    apiKey,
    maxUses: 5,
    task: lines.join("\n"),
    classify: (url) => {
      const host = hostOf(url);
      if (host.endsWith("play.google.com")) return { source: "playstore", sourceLabel: "Google Play (via web search)", group: "people" };
      if (host.endsWith("reddit.com")) return { source: "reddit", sourceLabel: "Reddit (via web search)", group: "people" };
      return { source: "webforums", sourceLabel: `${host} (via web search)`, group: "people" };
    },
  });
}

export async function searchRegulators(plan, { apiKey }) {
  const queries = cleanList(plan?.queries, { max: 3 });
  const domains = [
    ...new Set(
      cleanList(plan?.domains, { max: 10, maxLength: 60 })
        .map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
        .map((d) => REGULATOR_DOMAINS.find((allowed) => d === allowed || d.endsWith(`.${allowed}`)))
        .filter(Boolean)
    ),
  ];
  if (!queries.length || !domains.length) return [];

  return runWebSearch({
    apiKey,
    domains,
    maxUses: 3,
    task: `Search these official sites for guidance, statistics, enforcement actions or incident reports that show this problem has a real cost.\nQueries: ${queries
      .map((q) => `"${q}"`)
      .join("; ")}`,
    classify: (url) => ({ source: "regulators", sourceLabel: `Regulator (${hostOf(url)})`, group: "cost" }),
  });
}

async function runWebSearch({ apiKey, domains, maxUses, task, classify }) {
  if (!apiKey) throw new SkipSource("no Anthropic key");

  const data = await callClaude({
    apiKey,
    maxTokens: MAX_TOKENS,
    timeoutMs: WEB_TIMEOUT_MS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: task }],
    tools: [
      { type: "web_search_20250305", name: "web_search", max_uses: maxUses, ...(domains ? { allowed_domains: domains } : {}) },
    ],
  });

  // Group every citation by URL; one page can be cited several times.
  const byUrl = new Map();
  for (const block of data?.content || []) {
    if (block?.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const c of block.citations) {
      if (c?.type !== "web_search_result_location" || !c.url || !c.cited_text) continue;
      // allowed_domains alone isn't enough: preview runs showed regulator
      // searches citing ncbi.nlm.nih.gov and arxiv.org. Enforce it here too.
      if (domains && !domains.some((d) => hostOf(c.url) === d || hostOf(c.url).endsWith(`.${d}`))) continue;
      const entry = byUrl.get(c.url) || { title: c.title || "", texts: [] };
      if (!entry.texts.includes(c.cited_text)) entry.texts.push(c.cited_text);
      byUrl.set(c.url, entry);
    }
  }

  return [...byUrl.entries()].slice(0, MAX_RESULTS_PER_SOURCE * 2).map(([url, entry]) =>
    makeItem({
      ...classify(url),
      url,
      title: entry.title,
      // " … " separates distinct excerpts from the same page, so a quote
      // picked later can't silently join two of them into one sentence.
      text: entry.texts.join(" … "),
      signals: "",
    })
  );
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}
