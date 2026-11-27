// Bluesky post search (app.bsky.feed.searchPosts).
// The public, unauthenticated endpoint now refuses search (HTTP 403), so
// this needs an account: set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (an
// app password from Bluesky Settings → Privacy and security → App
// passwords, never the account's main password). Without them the source
// is skipped.

import { MAX_RESULTS_PER_SOURCE, SkipSource, cleanList, fetchJSON, makeItem, settleAll } from "./util.mjs";

const MAX_QUERIES = 2;
const PDS = "https://bsky.social";

export async function searchBluesky(plan) {
  const handle = Netlify.env.get("BLUESKY_HANDLE");
  const password = Netlify.env.get("BLUESKY_APP_PASSWORD");
  if (!handle || !password) {
    throw new SkipSource("needs BLUESKY_HANDLE and BLUESKY_APP_PASSWORD");
  }
  const queries = cleanList(plan?.queries, { max: MAX_QUERIES });
  if (!queries.length) return [];

  const session = await fetchJSON(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });
  const headers = { authorization: `Bearer ${session.accessJwt}` };

  const batches = await settleAll(
    queries.map((q) => async () => {
      const params = new URLSearchParams({ q, limit: String(MAX_RESULTS_PER_SOURCE), lang: "en" });
      const data = await fetchJSON(`${PDS}/xrpc/app.bsky.feed.searchPosts?${params}`, { headers });
      return data.posts || [];
    })
  );

  return batches.flat().map((post) => {
    const rkey = String(post.uri || "").split("/").pop();
    return makeItem({
      source: "bluesky",
      sourceLabel: "Bluesky",
      group: "people",
      url: `https://bsky.app/profile/${post.author?.handle}/post/${rkey}`,
      title: "",
      text: post.record?.text || "",
      signals: [`${post.likeCount ?? 0} likes`, `${post.replyCount ?? 0} replies`, `${post.repostCount ?? 0} reposts`].join(", "),
    });
  });
}
