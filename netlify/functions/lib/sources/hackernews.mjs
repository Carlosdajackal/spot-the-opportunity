// Hacker News, via the public Algolia search API (hn.algolia.com/api/v1/search).
// No key needed. Searches stories and comments together.

import { cleanList, fetchJSON, makeItem, settleAll, stripHtml } from "./util.mjs";

const MAX_QUERIES = 3;
const HITS_PER_QUERY = 10;

export async function searchHackerNews(plan) {
  const queries = cleanList(plan?.queries, { max: MAX_QUERIES });
  if (!queries.length) return [];

  const batches = await settleAll(
    queries.map((q) => async () => {
      const params = new URLSearchParams({ query: q, tags: "(story,comment)", hitsPerPage: String(HITS_PER_QUERY) });
      const data = await fetchJSON(`https://hn.algolia.com/api/v1/search?${params}`);
      return data.hits || [];
    })
  );

  return batches.flat().map((hit) => {
    const isComment = Array.isArray(hit._tags) && hit._tags.includes("comment");
    return makeItem({
      source: "hackernews",
      sourceLabel: "Hacker News",
      group: "people",
      url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      title: hit.title || hit.story_title || "",
      text: stripHtml(hit.comment_text || hit.story_text || hit.title || ""),
      signals: isComment
        ? "comment"
        : [`story, ${hit.points ?? 0} points`, `${hit.num_comments ?? 0} comments`].join(", "),
    });
  });
}
