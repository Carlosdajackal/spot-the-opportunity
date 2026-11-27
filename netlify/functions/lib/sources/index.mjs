// netlify/functions/lib/sources/index.mjs — runs the Stage 3 sources the
// audience map picked, in parallel, and merges what comes back.
//
// A source only runs if the plan selected it. Each one runs behind its own
// timeout and its own try/catch, so a slow, rate-limited or broken API is
// reported as such and never takes the whole Test down with it.

import { searchAppStore } from "./appstore.mjs";
import { searchBluesky } from "./bluesky.mjs";
import { searchGovUk, searchNvd } from "./cost.mjs";
import { searchDiscourse } from "./discourse.mjs";
import { searchGitHub } from "./github.mjs";
import { searchHackerNews } from "./hackernews.mjs";
import { searchArxiv, searchSemanticScholar } from "./research.mjs";
import { searchStackExchange } from "./stackexchange.mjs";
import { MAX_RESULTS_PER_SOURCE, SkipSource } from "./util.mjs";
import { searchRedditAndPlay, searchRegulators } from "./web.mjs";

const API_SOURCE_DEADLINE_MS = 30000; // whole adapter, across all its requests
const WEB_SOURCE_DEADLINE_MS = 100000; // web search runs several searches in one call

// `keys` are the plan fields that select a source. Reddit and Google Play
// share one web search call, so that entry is selected by either key.
export const SOURCES = [
  { name: "stackexchange", label: "Stack Exchange", keys: ["stackexchange"], run: (p) => searchStackExchange(p.stackexchange) },
  { name: "hackernews", label: "Hacker News", keys: ["hackernews"], run: (p) => searchHackerNews(p.hackernews) },
  { name: "github", label: "GitHub issues", keys: ["github"], run: (p) => searchGitHub(p.github) },
  { name: "discourse", label: "Community forums", keys: ["discourse"], run: (p) => searchDiscourse(p.discourse) },
  { name: "appstore", label: "App Store reviews", keys: ["appstore"], run: (p) => searchAppStore(p.appstore) },
  { name: "bluesky", label: "Bluesky", keys: ["bluesky"], run: (p) => searchBluesky(p.bluesky) },
  {
    name: "reddit_play",
    label: "Reddit and Google Play (web search)",
    keys: ["reddit", "playstore"],
    web: true,
    run: (p, ctx) => searchRedditAndPlay(p, ctx),
  },
  { name: "govuk", label: "GOV.UK", keys: ["govuk"], run: (p) => searchGovUk(p.govuk) },
  { name: "nvd", label: "NVD CVE database", keys: ["nvd"], run: (p) => searchNvd(p.nvd) },
  { name: "regulators", label: "Regulator sites (web search)", keys: ["regulators"], web: true, run: (p, ctx) => searchRegulators(p.regulators, ctx) },
  { name: "arxiv", label: "arXiv", keys: ["arxiv"], run: (p) => searchArxiv(p.arxiv) },
  { name: "semanticscholar", label: "Semantic Scholar", keys: ["semanticscholar"], run: (p) => searchSemanticScholar(p.semanticscholar) },
];

/**
 * @param {object} plan - the sanitised `sources` object from the audience map
 * @param {{apiKey: string}} ctx
 * @returns {Promise<{items: object[], report: object[]}>} items carry a
 *   short id ("s1", "s2"...) the synthesis step quotes by; report has one
 *   row per source saying what happened to it.
 */
export async function runSources(plan, ctx) {
  const selected = SOURCES.filter((s) => s.keys.some((k) => plan?.[k]));

  const outcomes = await Promise.all(
    selected.map(async (source) => {
      const deadline = source.web ? WEB_SOURCE_DEADLINE_MS : API_SOURCE_DEADLINE_MS;
      try {
        const items = await withDeadline(source.run(plan, ctx), deadline);
        return { source, items: items.slice(0, source.web ? MAX_RESULTS_PER_SOURCE * 2 : MAX_RESULTS_PER_SOURCE), status: "ok" };
      } catch (error) {
        const skipped = error instanceof SkipSource;
        return { source, items: [], status: skipped ? "skipped" : "error", note: shortReason(error) };
      }
    })
  );

  const seen = new Set();
  const items = [];
  const report = SOURCES.map((s) => ({ name: s.name, label: s.label, status: "not_selected", count: 0 }));

  for (const { source, items: found, status, note } of outcomes) {
    let kept = 0;
    for (const item of found) {
      const key = normaliseUrl(item.url);
      if (!key || seen.has(key) || !item.text) continue;
      seen.add(key);
      items.push({ ...item, id: `s${items.length + 1}` });
      kept++;
    }
    Object.assign(
      report.find((r) => r.name === source.name),
      { status: status === "ok" && kept === 0 ? "no_results" : status, count: kept, note: note || "" }
    );
  }

  return { items, report };
}

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function normaliseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}${url.search}`.toLowerCase();
  } catch {
    return "";
  }
}

// Only ever an HTTP status, "timed out", or a missing-key note — never any
// of the student's text — so it is safe to show in the result.
function shortReason(error) {
  const message = String(error?.message || "failed");
  if (/HTTP 429/.test(message)) return "rate limited";
  if (/timed out|TimeoutError|aborted/i.test(message) || error?.name === "TimeoutError") return "timed out";
  return message.slice(0, 80);
}
