// "This problem costs something" evidence: GOV.UK search and the NVD CVE
// database. These support "This matters because" but never count as
// sentiment, so every item is grouped as "cost". No keys needed (NVD
// allows 5 requests per 30 seconds without one; NVD_API_KEY raises that).

import { MAX_RESULTS_PER_SOURCE, cleanList, fetchJSON, makeItem, settleAll } from "./util.mjs";

const MAX_QUERIES = 2;

export async function searchGovUk(plan) {
  const queries = cleanList(plan?.queries, { max: MAX_QUERIES });
  if (!queries.length) return [];

  const batches = await settleAll(
    queries.map((q) => async () => {
      const params = new URLSearchParams({ q, count: String(MAX_RESULTS_PER_SOURCE), fields: "title,description,link,format" });
      const data = await fetchJSON(`https://www.gov.uk/api/search.json?${params}`);
      return data.results || [];
    })
  );

  return batches.flat().map((r) =>
    makeItem({
      source: "govuk",
      sourceLabel: "GOV.UK",
      group: "cost",
      url: String(r.link || "").startsWith("http") ? r.link : `https://www.gov.uk${r.link || ""}`,
      title: r.title,
      text: r.description || r.title,
      signals: r.format ? String(r.format).replace(/_/g, " ") : "",
    })
  );
}

export async function searchNvd(plan) {
  const queries = cleanList(plan?.queries, { max: MAX_QUERIES, maxLength: 60 });
  if (!queries.length) return [];

  const key = Netlify.env.get("NVD_API_KEY");
  const headers = key ? { apiKey: key } : {};

  const batches = await settleAll(
    queries.map((q) => async () => {
      const params = new URLSearchParams({ keywordSearch: q, resultsPerPage: String(MAX_RESULTS_PER_SOURCE) });
      const data = await fetchJSON(`https://services.nvd.nist.gov/rest/json/cves/2.0?${params}`, { headers });
      return data.vulnerabilities || [];
    })
  );

  return batches.flat().map(({ cve }) => {
    const description = (cve?.descriptions || []).find((d) => d.lang === "en")?.value || "";
    const metric = cve?.metrics?.cvssMetricV31?.[0] || cve?.metrics?.cvssMetricV30?.[0] || cve?.metrics?.cvssMetricV2?.[0];
    const severity = metric?.cvssData?.baseSeverity || metric?.baseSeverity;
    return makeItem({
      source: "nvd",
      sourceLabel: "NVD (CVE)",
      group: "cost",
      url: `https://nvd.nist.gov/vuln/detail/${cve?.id}`,
      title: cve?.id,
      text: description,
      signals: [severity ? `severity ${severity}` : null, cve?.published ? `published ${cve.published.slice(0, 10)}` : null]
        .filter(Boolean)
        .join(", "),
    });
  });
}
