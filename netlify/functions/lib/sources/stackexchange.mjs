// Stack Exchange API (api.stackexchange.com/2.3/search/advanced).
// Works without a key at 300 requests/day per IP; Netlify functions share
// IPs, so a free STACKEXCHANGE_KEY (not a secret — it only raises the quota
// to 10,000/day) is recommended. Pain signals: question score, answer
// count, and whether it's still unanswered / has no accepted answer.

import { MAX_RESULTS_PER_SOURCE, cleanList, fetchJSON, makeItem, settleAll, stripHtml } from "./util.mjs";

const MAX_SITES = 3;
const MAX_QUERIES = 2;
const SITE_PATTERN = /^[a-z0-9.-]+$/;

export async function searchStackExchange(plan) {
  const sites = cleanList(plan?.sites, { max: MAX_SITES, maxLength: 40 })
    .map((s) => s.toLowerCase().replace(/\.stackexchange\.com$|\.com$/, ""))
    .filter((s) => SITE_PATTERN.test(s));
  const queries = cleanList(plan?.queries, { max: MAX_QUERIES });
  if (!sites.length || !queries.length) return [];

  const key = Netlify.env.get("STACKEXCHANGE_KEY");
  const jobs = [];
  for (const site of sites) {
    for (const q of queries) {
      jobs.push(async () => {
        const params = new URLSearchParams({
          order: "desc",
          sort: "relevance",
          q,
          site,
          pagesize: String(MAX_RESULTS_PER_SOURCE),
          filter: "withbody",
        });
        if (key) params.set("key", key);
        const data = await fetchJSON(`https://api.stackexchange.com/2.3/search/advanced?${params}`);
        return (data.items || []).map((question) => ({ question, site }));
      });
    }
  }

  const batches = await settleAll(jobs);
  return batches
    .flat()
    .sort((a, b) => (b.question.score ?? 0) - (a.question.score ?? 0))
    .map(({ question, site }) =>
      makeItem({
        source: "stackexchange",
        sourceLabel: `Stack Exchange (${site})`,
        group: "people",
        url: question.link,
        title: stripHtml(question.title),
        text: stripHtml(question.body),
        signals: [
          `question score ${question.score ?? 0}`,
          `${question.answer_count ?? 0} answers`,
          question.accepted_answer_id ? "has an accepted answer" : "no accepted answer",
          question.view_count ? `${question.view_count} views` : null,
        ]
          .filter(Boolean)
          .join(", "),
      })
    );
}
