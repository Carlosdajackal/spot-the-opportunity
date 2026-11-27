// netlify/functions/lib/test-pipeline.mjs — Stage 3 (Test) logic:
//
//   1. Audience map: one small Claude call (no tools) that decides who has
//      this problem, the words they'd use, and which sources are worth
//      searching — so a consumer problem doesn't trawl arXiv and an ML
//      research problem doesn't trawl the App Store.
//   2. Sources: lib/sources/ runs only the sources the map picked, in
//      parallel, each with its own timeout.
//   3. Synthesis: one Claude call (no tools) that labels every retrieved
//      item and quotes it by id. It never sees anything it didn't get from
//      us, and every quote is checked against the item's real text here.
//   4. Scoring happens HERE, in code, not in the model: only "person" and
//      "practitioner" items from people-sources count, so commentary,
//      vendor pages, regulators and papers can never raise the score.

import { DISCOURSE_FORUMS } from "./discourse-forums.mjs";
import { callClaudeForJSON } from "./anthropic.mjs";
import { cleanList, clip } from "./sources/util.mjs";
import { REGULATOR_DOMAINS } from "./sources/web.mjs";

// Fewer first-person accounts than this and we don't score at all: we say
// there isn't enough evidence yet, and point the student at interviews.
export const MIN_PERSON_ITEMS = 5;
export const MIGRAINE_THRESHOLD = 60;

const PLAN_MAX_TOKENS = 2500;
const SYNTHESIS_MAX_TOKENS = 12000;
const PLAN_TIMEOUT_MS = 45000;
const SYNTHESIS_TIMEOUT_MS = 150000;

const SOURCE_KEYS = [
  "stackexchange",
  "hackernews",
  "github",
  "discourse",
  "appstore",
  "playstore",
  "bluesky",
  "forums",
  "govuk",
  "nvd",
  "regulators",
  "arxiv",
  "semanticscholar",
];

export const LABELS = ["person", "practitioner", "commentary", "cost", "research"];
const COUNTABLE = new Set(["person", "practitioner"]);

// ---------------------------------------------------------------------------
// 1. Audience map

const PLAN_SYSTEM_PROMPT = `You plan where to look for evidence that a problem is real, for a UK university student validating a business problem. Many students work on specialist technical problems (security, machine learning, data, accessibility, IoT); others work on everyday consumer problems. Your plan decides which sources get searched, so choose carefully.

First, work out who actually has this problem and the words THEY would use when complaining about it online. People rarely use academic or textbook terms: a clinician says "the audit log is useless", not "insufficient forensic granularity".

Then pick ONLY the sources below that this audience really uses. Stack Exchange and Hacker News are for technical audiences; don't choose them for everyday consumer or student problems. Leave out any source that doesn't fit by omitting its key. A consumer or student-life problem should not search arXiv, Semantic Scholar or NVD. A research-level machine learning problem should not search the App Store.

Sources (key: what it is, and what to provide):
- forums: forums and communities across the open web, via web search: Reddit, The Student Room, Mumsnet, Quora, patient and carer forums, trade and hobbyist forums. Right for almost every problem, and the main source for consumer, student, workplace and patient problems. Name the specific communities this audience uses. {"communities":["..."],"queries":["..."]}
- stackexchange: Stack Exchange Q&A sites, for technical, professional and some everyday audiences. Give site API names such as stackoverflow, security, stats, datascience, superuser, softwareengineering, serverfault, dba, ux, academia, money, workplace, parenting, travel, cooking, diy. {"sites":["..."],"queries":["..."]}
- hackernews: Hacker News, for software developers, startups and tech workers. {"queries":["..."]}
- github: GitHub issues on open-source projects this audience uses or builds with. Give real repositories as owner/name, or none to search all of GitHub. {"repos":["owner/name"],"queries":["..."]}
- discourse: product community forums. Choose ONLY from this list: ${DISCOURSE_FORUMS.map((f) => `${f.host} (${f.about})`).join("; ")}. {"forums":["host"],"queries":["..."]}
- appstore: Apple App Store reviews of real, named iPhone apps this audience uses today to cope with the problem. {"apps":["exact app name"]}
- playstore: Google Play reviews of real, named Android apps, as above. {"apps":["exact app name"]}
- bluesky: Bluesky posts, for problems people talk about publicly on social media. {"queries":["..."]}
- govuk: GOV.UK guidance, statistics and regulation, to show the problem has a real cost. {"queries":["..."]}
- nvd: the US NVD vulnerability database. ONLY for problems about software or device security vulnerabilities. {"queries":["..."]}
- regulators: official regulator and public-health sites, to show cost or harm. Choose domains ONLY from: ${REGULATOR_DOMAINS.join(", ")}. {"domains":["..."],"queries":["..."]}
- arxiv: arXiv papers. ONLY for research-level technical problems. {"queries":["..."]}
- semanticscholar: academic papers across disciplines. ONLY for research-level problems. {"queries":["..."]}

Queries: give 3 to 6 per chosen source. Most of these are literal keyword search engines, so each query is a short phrase of 2 to 5 words in the audience's own language, with no quotation marks, boolean operators or site: syntax. Keep Stack Exchange, NVD and arXiv queries to 2 or 3 words, because they only match results containing every word.

Also say who the student should interview if online evidence turns out to be thin: 3 to 5 specific kinds of people, and where to find them in practice (named communities, events, societies, organisations, job roles).

Return ONLY a single valid JSON object, no markdown fences:
{"audience":[{"who":"...","their_words":["..."]}],"sources":{"<key>":{...}},"interview_targets":[{"who":"...","where":"..."}]}`;

export async function planAudienceMap({ apiKey, problemText }) {
  try {
    const parsed = await callClaudeForJSON({
      apiKey,
      maxTokens: PLAN_MAX_TOKENS,
      timeoutMs: PLAN_TIMEOUT_MS,
      system: PLAN_SYSTEM_PROMPT,
      messages: [{ role: "user", content: problemText }],
    });
    const plan = sanitizePlan(parsed);
    if (Object.keys(plan.sources).length) return plan;
  } catch {
    // fall through to the fallback below
  }
  return fallbackPlan(problemText);
}

function sanitizePlan(parsed) {
  const rawSources = parsed?.sources && typeof parsed.sources === "object" ? parsed.sources : {};
  const sources = {};
  for (const key of SOURCE_KEYS) {
    const value = rawSources[key];
    if (value && typeof value === "object" && !Array.isArray(value)) sources[key] = value;
  }
  return {
    audience: (Array.isArray(parsed?.audience) ? parsed.audience : []).slice(0, 4).map((a) => ({
      who: clip(a?.who, 160),
      their_words: cleanList(a?.their_words, { max: 6, maxLength: 60 }),
    })),
    sources,
    interview_targets: (Array.isArray(parsed?.interview_targets) ? parsed.interview_targets : [])
      .slice(0, 5)
      .map((t) => ({ who: clip(t?.who, 160), where: clip(t?.where, 240) }))
      .filter((t) => t.who),
  };
}

// If the planning call fails, still search the two general-purpose people
// sources rather than failing the whole Test.
function fallbackPlan(problemText) {
  const statement = (problemText.match(/^Problem statement: (.*)$/m) || [])[1] || problemText;
  const query = clip(statement, 100).replace(/…$/, "");
  return {
    audience: [],
    sources: { forums: { queries: [query] }, hackernews: { queries: [query] } },
    interview_targets: [],
  };
}

// ---------------------------------------------------------------------------
// 3. Synthesis

const SYNTHESIS_SYSTEM_PROMPT = `You are a market research analyst helping a UK university entrepreneurship student judge whether a problem is real and urgent. You are given evidence items that were retrieved from real public sources, each with an id. Work ONLY from these items.

ABSOLUTE RULE ON QUOTES. Every quote must be copied character-for-character from the Text of the item it belongs to. Never paraphrase, tidy up, merge two passages, or invent. If an item has no sentence worth quoting, leave it out. A quote that isn't an exact copy is discarded, so an inexact quote gains nothing.

Step 1. Label every item that is genuinely about this problem. Leave out any item that isn't about this specific problem, even if it shares keywords: an unrelated question is not commentary, it is simply left out.
- "person": a first-person account from someone in the TARGET AUDIENCE named in the problem statement, who has this problem themselves ("I", "we", "my team"). Someone outside that audience is never a person, even if they write in the first person.
- "practitioner": someone close to the audience describing the problem as they see it in people they work with or support, such as a clinician, teacher, carer, support worker, or a developer building tools for that audience.
- "commentary": blogs, news write-ups, consultancies, marketing pages, generic advice, or a company selling a fix.
- "cost": regulator, government, incident, vulnerability or statistical evidence that the problem causes harm or costs something.
- "research": academic papers.
An item's group limits its label: a "people" group item can only be person, practitioner or commentary; a "cost" group item can only be cost; a "research" group item can only be research. For research items, prefer sentences about limitations, open challenges or future work, which show the problem is recognised and unsolved.

For person and practitioner items only, rate intensity:
1 = mild interest, inconvenience or a nice-to-have.
2 = clear frustration, or a real cost in time, money, confidence or opportunity, or a workaround they resent.
3 = urgent, blocking or desperate, or they say they would pay or switch immediately.
Use the item's signals (votes, reactions, unanswered, star rating) as supporting evidence of how widely the pain is shared.

Step 2. Group the person and practitioner items into distinct pain points (such as Problems with Existing Solutions, Emotional Challenges, Unmet Needs). Commentary, cost and research items never form a pain point.

Step 3. Compare what the person and practitioner items show against the student's Stage 2 root cause. State plainly whether they align or point somewhere different. Do not soften a genuine mismatch: finding the root cause was wrong is a valuable result.

Step 4. Write a short plain-English summary of how intense and how widespread the pain is in the person and practitioner items. Do not give a score or a migraine/headache verdict; that is calculated separately from your labels. Separately, summarise in one or two sentences what any cost or research items show about why the problem matters, or leave it empty.

Step 5. Give 2 to 4 concrete ways the student could sharpen the problem: focusing the pain (lost time, money, confidence or opportunity), tightening the audience to a smaller, clearer group, or narrowing to a specific scenario or trigger.

Step 6. In evidence_note, say honestly how good the search coverage was: which sources produced useful first-hand material, which didn't, and whether thin results more likely mean the search terms were wrong or this audience simply doesn't post publicly.

Return ONLY a single valid JSON object, no markdown fences:
{"items":[{"id":"s1","label":"person|practitioner|commentary|cost|research","intensity":1,"quote":"..."}],"pain_points":[{"category":"...","summary":"...","item_ids":["s1"]}],"root_cause_comparison":{"student_root_cause":"...","evidence_suggests":"...","verdict":"aligned|partly aligned|different","explanation":"..."},"priority_ranking":[{"pain_point":"...","rationale":"..."}],"reasoning":"...","cost_summary":"...","sharpening_advice":["..."],"evidence_note":"..."}

intensity is only needed for person and practitioner items. priority_ranking ranks pain points by frequency, intensity, specificity and solvability.`;

export async function synthesise({ apiKey, problemText, plan, items }) {
  const audienceLines = plan.audience.map((a) => `- ${a.who}${a.their_words.length ? ` (they say: ${a.their_words.join("; ")})` : ""}`);
  const itemLines = items.map((item) =>
    [
      `[${item.id}] group: ${item.group} · ${item.sourceLabel}`,
      item.title ? `Title: ${item.title}` : null,
      item.signals ? `Signals: ${item.signals}` : null,
      `Text: ${item.text}`,
    ]
      .filter(Boolean)
      .join("\n")
  );

  const content = [
    problemText,
    "",
    "Who has this problem (from the audience map):",
    audienceLines.length ? audienceLines.join("\n") : "- (not available)",
    "",
    `Evidence items (${items.length}):`,
    itemLines.length ? itemLines.join("\n\n") : "(no items were retrieved)",
  ].join("\n");

  return callClaudeForJSON({
    apiKey,
    maxTokens: SYNTHESIS_MAX_TOKENS,
    timeoutMs: SYNTHESIS_TIMEOUT_MS,
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });
}

// ---------------------------------------------------------------------------
// 4. Scoring and sanitising

export function buildResult({ parsed, items, plan, sourceReport, rootCause }) {
  const itemsById = new Map(items.map((item) => [item.id, item]));

  const evidence = [];
  const labelled = new Map();
  for (const raw of Array.isArray(parsed?.items) ? parsed.items : []) {
    const item = itemsById.get(String(raw?.id ?? ""));
    if (!item || labelled.has(item.id)) continue;
    const label = allowedLabel(item.group, raw?.label);
    if (!label) continue;

    const countable = COUNTABLE.has(label);
    const intensityNum = Math.round(Number(raw?.intensity));
    const entry = {
      id: item.id,
      label,
      intensity: countable ? Math.max(1, Math.min(3, Number.isFinite(intensityNum) ? intensityNum : 1)) : null,
      quote: verifiedQuote(raw?.quote, item.text),
      url: item.url,
      source: item.sourceLabel,
      title: item.title,
      signals: item.signals,
    };
    labelled.set(item.id, entry);
    evidence.push(entry);
  }

  const counts = Object.fromEntries(LABELS.map((l) => [l, evidence.filter((e) => e.label === l).length]));
  const countable = evidence.filter((e) => COUNTABLE.has(e.label));

  // The score is the average intensity of the person/practitioner items,
  // on a 0–100 scale (all "mild" = 33, all "clear frustration" = 67, all
  // "urgent" = 100). Nothing else feeds into it.
  let verdict;
  let score = null;
  if (counts.person < MIN_PERSON_ITEMS) {
    verdict = "insufficient";
  } else {
    const avg = countable.reduce((sum, e) => sum + e.intensity, 0) / countable.length;
    score = Math.round((avg / 3) * 100);
    verdict = score >= MIGRAINE_THRESHOLD ? "migraine" : "headache";
  }

  const painPoints = (Array.isArray(parsed?.pain_points) ? parsed.pain_points : [])
    .map((p) => {
      const ids = [...new Set(cleanList(p?.item_ids, { max: 40, maxLength: 10 }))].filter((id) =>
        COUNTABLE.has(labelled.get(id)?.label)
      );
      return {
        category: String(p?.category ?? ""),
        summary: String(p?.summary ?? ""),
        item_ids: ids,
        frequency: describeCounts(ids.map((id) => labelled.get(id).label)),
      };
    })
    .filter((p) => p.item_ids.length);

  const comparison = parsed?.root_cause_comparison ?? {};
  const comparisonVerdict = ["aligned", "partly aligned", "different"].includes(comparison?.verdict)
    ? comparison.verdict
    : "different";

  return {
    verdict,
    score,
    min_person_items: MIN_PERSON_ITEMS,
    counts,
    reasoning: String(parsed?.reasoning ?? ""),
    cost_summary: String(parsed?.cost_summary ?? ""),
    evidence: evidence.sort((a, b) => (b.intensity ?? 0) - (a.intensity ?? 0)),
    pain_points: painPoints,
    root_cause_comparison: {
      student_root_cause: String(comparison?.student_root_cause ?? rootCause),
      evidence_suggests: String(comparison?.evidence_suggests ?? ""),
      verdict: comparisonVerdict,
      explanation: String(comparison?.explanation ?? ""),
    },
    priority_ranking: (Array.isArray(parsed?.priority_ranking) ? parsed.priority_ranking : []).map((r) => ({
      pain_point: String(r?.pain_point ?? ""),
      rationale: String(r?.rationale ?? ""),
    })),
    sharpening_advice:
      verdict === "migraine" ? [] : (Array.isArray(parsed?.sharpening_advice) ? parsed.sharpening_advice : []).map((a) => String(a)),
    evidence_note: String(parsed?.evidence_note ?? ""),
    talk_to: plan.interview_targets,
    audience: plan.audience,
    sources: sourceReport,
  };
}

function allowedLabel(group, label) {
  if (!LABELS.includes(label)) return null;
  if (group === "cost") return "cost";
  if (group === "research") return "research";
  // A people-source item labelled cost/research is just commentary: it
  // must never count, but it also isn't a regulator or a paper.
  return COUNTABLE.has(label) || label === "commentary" ? label : "commentary";
}

// The model's quote must appear in the item's real text. If it doesn't,
// fall back to the start of the real text, so nothing shown to a student
// is ever words the source didn't say.
function verifiedQuote(quote, text) {
  const candidate = typeof quote === "string" ? quote.trim().replace(/^["“]|["”]$/g, "") : "";
  if (candidate.length >= 12 && normalise(text).includes(normalise(candidate))) {
    return clip(candidate, 400);
  }
  return clip(text, 280);
}

function normalise(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

function describeCounts(labels) {
  const people = labels.filter((l) => l === "person").length;
  const practitioners = labels.filter((l) => l === "practitioner").length;
  return [
    people ? `${people} ${people === 1 ? "person" : "people"} with the problem` : null,
    practitioners ? `${practitioners} ${practitioners === 1 ? "practitioner" : "practitioners"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}
