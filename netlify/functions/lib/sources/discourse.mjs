// Discourse product and community forums (GET https://<host>/search.json?q=).
// Only hosts on the editable allowlist in ../discourse-forums.mjs are ever
// called. Pain signals: likes on the post and replies in its topic.

import { DISCOURSE_FORUMS } from "../discourse-forums.mjs";
import { MAX_RESULTS_PER_SOURCE, cleanList, fetchJSON, makeItem, settleAll } from "./util.mjs";

const MAX_FORUMS = 2;
const MAX_QUERIES = 2;

export async function searchDiscourse(plan) {
  const allowed = new Set(DISCOURSE_FORUMS.map((f) => f.host));
  const forums = cleanList(plan?.forums, { max: 10, maxLength: 100 })
    .map((f) => f.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter((f) => allowed.has(f))
    .slice(0, MAX_FORUMS);
  const queries = cleanList(plan?.queries, { max: MAX_QUERIES });
  if (!forums.length || !queries.length) return [];

  const jobs = [];
  for (const host of forums) {
    for (const q of queries) {
      jobs.push(async () => {
        const data = await fetchJSON(`https://${host}/search.json?${new URLSearchParams({ q })}`);
        const topics = new Map((data.topics || []).map((t) => [t.id, t]));
        return (data.posts || []).slice(0, MAX_RESULTS_PER_SOURCE).map((post) => {
          const topic = topics.get(post.topic_id) || {};
          return makeItem({
            source: "discourse",
            sourceLabel: `Forum (${host})`,
            group: "people",
            url: `https://${host}/t/${topic.slug || "topic"}/${post.topic_id}/${post.post_number || 1}`,
            title: topic.title || "",
            text: post.blurb || "",
            signals: [`${post.like_count ?? 0} likes`, `${topic.reply_count ?? topic.posts_count ?? 0} replies in topic`].join(", "),
          });
        });
      });
    }
  }

  return (await settleAll(jobs)).flat();
}
