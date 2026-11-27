// Academic papers: arXiv and Semantic Scholar. Evidence that a problem is
// recognised and unsolved, never evidence of people's pain, so every item
// is grouped as "research".
//
// Both APIs return abstracts only. The "limitations / future work"
// sections live in the full PDFs, which are too slow to fetch and parse
// here, so the synthesis prompt looks for that language in the abstract.

import { MAX_RESULTS_PER_SOURCE, cleanList, fetchJSON, fetchText, makeItem, settleAll } from "./util.mjs";

const MAX_QUERIES = 2;
const ARXIV_GAP_MS = 3000; // arXiv asks for no more than one request every 3 seconds

export async function searchArxiv(plan) {
  const queries = cleanList(plan?.queries, { max: MAX_QUERIES, maxLength: 80 });
  if (!queries.length) return [];

  const items = [];
  for (const [index, q] of queries.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, ARXIV_GAP_MS));
    const terms = q.split(/\s+/).filter(Boolean).map((t) => `all:${t.replace(/[^\p{L}\p{N}-]/gu, "")}`).filter((t) => t !== "all:");
    if (!terms.length) continue;
    const params = new URLSearchParams({
      search_query: terms.join(" AND "),
      max_results: String(Math.ceil(MAX_RESULTS_PER_SOURCE / queries.length)),
      sortBy: "relevance",
    });
    try {
      const xml = await fetchText(`https://export.arxiv.org/api/query?${params}`);
      items.push(...parseArxiv(xml));
    } catch (error) {
      if (!items.length && index === queries.length - 1) throw error;
    }
  }
  return items;
}

function parseArxiv(xml) {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  const tag = (entry, name) => (entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || "";
  return entries.map((entry) =>
    makeItem({
      source: "arxiv",
      sourceLabel: "arXiv",
      group: "research",
      url: tag(entry, "id").trim(),
      title: tag(entry, "title"),
      text: tag(entry, "summary"),
      signals: tag(entry, "published").slice(0, 10) ? `published ${tag(entry, "published").slice(0, 10)}` : "",
    })
  );
}

// Semantic Scholar's unauthenticated pool is shared by everyone and often
// answers 429; SEMANTIC_SCHOLAR_API_KEY (free on request) avoids that.
// A 429 just means this source is reported as failed for that run.
export async function searchSemanticScholar(plan) {
  const queries = cleanList(plan?.queries, { max: 1 });
  if (!queries.length) return [];

  const key = Netlify.env.get("SEMANTIC_SCHOLAR_API_KEY");
  const headers = key ? { "x-api-key": key } : {};

  const batches = await settleAll(
    queries.map((q) => async () => {
      const params = new URLSearchParams({
        query: q,
        limit: String(MAX_RESULTS_PER_SOURCE),
        fields: "title,abstract,url,year,citationCount",
      });
      const data = await fetchJSON(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, { headers });
      return data.data || [];
    })
  );

  return batches
    .flat()
    .filter((p) => p.abstract)
    .map((p) =>
      makeItem({
        source: "semanticscholar",
        sourceLabel: "Semantic Scholar",
        group: "research",
        url: p.url,
        title: p.title,
        text: p.abstract,
        signals: [p.year ? `year ${p.year}` : null, `${p.citationCount ?? 0} citations`].filter(Boolean).join(", "),
      })
    );
}
