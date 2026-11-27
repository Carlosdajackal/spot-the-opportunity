// Apple App Store reviews: find each app with the iTunes Search API, then
// read its public customer-reviews feed (UK store). No key needed. Lower
// star ratings are taken first, since complaints are the pain signal.
// Individual reviews have no public URL, so each links to the app's page.

import { cleanList, fetchJSON, makeItem, settleAll } from "./util.mjs";

const MAX_APPS = 2;
const REVIEWS_PER_APP = 5;
const COUNTRY = "gb";

export async function searchAppStore(plan) {
  const apps = cleanList(plan?.apps, { max: MAX_APPS, maxLength: 80 });
  if (!apps.length) return [];

  const batches = await settleAll(
    apps.map((name) => async () => {
      const params = new URLSearchParams({ term: name, entity: "software", country: COUNTRY, limit: "1" });
      const found = await fetchJSON(`https://itunes.apple.com/search?${params}`);
      const app = found.results?.[0];
      if (!app?.trackId) return [];

      const feed = await fetchJSON(
        `https://itunes.apple.com/${COUNTRY}/rss/customerreviews/page=1/id=${app.trackId}/sortby=mostrecent/json`
      );
      const entries = feed?.feed?.entry;
      const reviews = (Array.isArray(entries) ? entries : entries ? [entries] : [])
        .map((e) => ({
          rating: Number(e?.["im:rating"]?.label),
          title: e?.title?.label || "",
          content: e?.content?.label || "",
        }))
        .filter((r) => r.content && Number.isFinite(r.rating))
        .sort((a, b) => a.rating - b.rating)
        .slice(0, REVIEWS_PER_APP);

      return reviews.map((r) =>
        makeItem({
          source: "appstore",
          sourceLabel: `App Store review (${app.trackName})`,
          group: "people",
          url: app.trackViewUrl,
          title: r.title,
          text: r.content,
          signals: `${r.rating}/5 stars`,
        })
      );
    })
  );

  return batches.flat();
}
