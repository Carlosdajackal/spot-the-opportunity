// GitHub issue search (REST: GET /search/issues).
// Works without a token, but the unauthenticated search limit is about 10
// requests a minute per IP, shared with everything else on that Netlify
// IP; set GITHUB_TOKEN (any read-only token) for 30/minute. GitHub
// Discussions are only searchable through GraphQL with a token, so they
// aren't covered here. Pain signals: reactions and comment count.

import { cleanList, fetchJSON, makeItem, settleAll, stripHtml } from "./util.mjs";

const MAX_QUERIES = 2;
const MAX_REPOS = 4;
const PER_PAGE = 10;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function searchGitHub(plan) {
  const queries = cleanList(plan?.queries, { max: MAX_QUERIES });
  if (!queries.length) return [];
  const repos = cleanList(plan?.repos, { max: MAX_REPOS, maxLength: 100 }).filter((r) => REPO_PATTERN.test(r));

  const token = Netlify.env.get("GITHUB_TOKEN");
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (token) headers.authorization = `Bearer ${token}`;

  const search = async (q) => {
    const params = new URLSearchParams({ q, per_page: String(PER_PAGE) });
    const data = await fetchJSON(`https://api.github.com/search/issues?${params}`, { headers });
    return data.items || [];
  };

  const batches = await settleAll(
    queries.map((query) => async () => {
      if (!repos.length) return search(`${query} is:issue`);
      try {
        return await search(`${query} is:issue ${repos.map((r) => `repo:${r}`).join(" ")}`);
      } catch {
        // Most often a 422 because the plan named a repo that doesn't
        // exist. Fall back to searching all of GitHub rather than losing
        // the query.
        return search(`${query} is:issue`);
      }
    })
  );

  return batches
    .flat()
    .sort((a, b) => (b.reactions?.total_count ?? 0) + (b.comments ?? 0) - ((a.reactions?.total_count ?? 0) + (a.comments ?? 0)))
    .map((issue) => {
      const repo = String(issue.repository_url || "").replace("https://api.github.com/repos/", "");
      return makeItem({
        source: "github",
        sourceLabel: repo ? `GitHub (${repo})` : "GitHub",
        group: "people",
        url: issue.html_url,
        title: issue.title,
        text: stripHtml(issue.body || issue.title),
        signals: [
          `${issue.reactions?.total_count ?? 0} reactions`,
          `${issue.reactions?.["+1"] ?? 0} thumbs-up`,
          `${issue.comments ?? 0} comments`,
          issue.state,
        ].join(", "),
      });
    });
}
