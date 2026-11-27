# Spot the Opportunity

A public problem-validation tool for **UEL Careers and Student Enterprise**,
used in Mental Wealth Professional Fitness (MWPF) lectures and enterprise
bootcamps. No login required.

Students work through four stages:

1. **Spot** — turn a rough problem (and, optionally, an idea) into one
   narrow, testable problem statement (Who/What/When/How/Why). "What are you
   building?" is optional: if it's left blank the tool works from the
   problem alone and never infers or suggests a solution.
2. **Dig** — the student writes their own Five Whys chain (nothing is
   pre-filled or written into their boxes); the tool reviews the whole
   chain once and states the root cause it actually arrives at. If they're
   stuck they can use up to **2 hints** across the five whys
   (`netlify/functions/hint.mjs`, at `/api/hint`): each is a question about
   their own previous answer plus one example answer they can use or
   adapt, shown in a panel and never filled in for them. Hints point at
   causes, never solutions. The 2-hint limit is kept in the browser and
   resets on "Start over" (or a refresh); every hint still counts towards
   the per-session rate limit. The fixed "Need a nudge?" prompts are
   unlimited and need no API call. Each Why has a
   **Need a nudge?** button that reveals preloaded guiding questions for that
   depth (no API call, no cost). The question bank is the `NUDGES` object in
   `public/app.js`; the previous answer is quoted back into one lead question.
3. **Test** — works out who has the problem and where they talk, searches
   those places, labels every piece of evidence, and scores the first-hand
   accounts 0–100 as a **migraine** (needs solving urgently) or a
   **headache** (nice-to-have, not urgent). With too few first-hand
   accounts it says **"Not enough evidence to score"** instead, and points
   the student towards who to interview. See "How Test works" below.
4. **Judge** — no API call. A summary of all three stages, with a
   conclusion box for the student to write up their own judgment, a
   **Download my results (PDF)** button, Copy, and Print. The PDF is built
   in the browser with jsPDF (self-hosted in `public/vendor/jspdf/`, MIT
   licence, loaded only when the button is pressed), so nothing is sent
   anywhere. It includes every stage, the evidence with clickable source
   links, and marks any Five Whys hints the student used. jsPDF's built-in
   fonts only cover Western European characters, so anything else (emoji,
   non-Latin scripts) shows as "?" in the PDF.

## How it works

- `public/index.html` (+ `styles.css`, `app.js`) — the page students see.
  Contains no secrets and never talks to Anthropic directly.
- `netlify/functions/spot.mjs`, `dig.mjs`, `hint.mjs` — ordinary Netlify serverless
  functions. Each holds the Anthropic API key server-side
  (`Netlify.env.get("ANTHROPIC_API_KEY")`) and returns the finished result
  directly to the browser, at `/api/spot`, `/api/dig` and `/api/hint`.
- `netlify/functions/test-background.mjs` + `test-status.mjs` — Stage 3 is
  different: a web-search-backed validation with synthesis routinely takes
  longer than Netlify's ~30-second synchronous function limit. So
  `test-background.mjs` is a **background function** (15-minute ceiling)
  that does the work and writes its result into a short-lived Netlify Blobs
  job record; `test-status.mjs` is a fast endpoint the browser polls every
  couple of seconds until that job reads "done" or "error". Both are still
  reached at `/api/test` and `/api/test-status` — the browser never talks
  to Anthropic directly, same as the other two stages.
- `netlify/functions/lib/` — shared code used across functions: the
  Anthropic API caller, rate limiting, small HTTP helpers, and Stage 3's
  pipeline (`test-pipeline.mjs`) and sources (`sources/`).

## How Test works

1. **Audience map.** One Claude call (no tools) reads the problem
   statement and root cause and returns a small plan: who has the problem,
   the words *they* use, which sources are relevant, and 3–6 short queries
   for each. Only those sources are searched, so a consumer problem
   doesn't trawl arXiv and a machine learning problem doesn't trawl the
   App Store.
2. **Sources, in parallel.** Each source in `netlify/functions/lib/sources/`
   runs behind its own timeout and returns at most about 10 results;
   results are deduplicated by URL. A source that is rate-limited, down or
   missing a key is listed under "Where we looked" and the Test carries on.
   - People who complain (the only sources that can count): Stack
     Exchange, Hacker News (Algolia), GitHub issues, Discourse forums on
     the allowlist in `lib/discourse-forums.mjs`, App Store reviews,
     Bluesky (needs an app password), and forums across the open web
     (The Student Room, Mumsnet, Quora, Reddit where reachable) plus
     Google Play reviews via Anthropic's web search tool.
   - Cost evidence: GOV.UK search, the NVD CVE database, and web search
     restricted to ICO, CISA, NHS, ONS and WHO.
   - Research: arXiv and Semantic Scholar (abstracts only).
3. **Labelling.** One Claude call (no tools) labels each retrieved item as
   *Person with the problem*, *Practitioner / peer*, *Commentary / vendor*,
   *Cost evidence* or *Research*, and quotes it by id. Code then checks
   every quote appears word-for-word in the retrieved text (falling back
   to the real text if not), and restricts labels by source: a CVE or a
   paper can never be labelled as a person. At most 5 *Commentary / vendor*
   items are kept (`MAX_COMMENTARY_SHOWN`), since they're only context.
4. **Scoring, in code.** The score is the average pain intensity of the
   *Person* and *Practitioner* items only, so commentary, vendors,
   regulators and papers can never raise it. With fewer than 5 *Person*
   items there is no score: the result says "Not enough evidence to
   score", explains that this is common for specialist audiences, and
   lists who to talk to and where to find them. The thresholds are named
   constants at the top of `lib/test-pipeline.mjs`. Each run finds
   slightly different posts, so a score within 10 points of the migraine
   line (50–70) shows a tip suggesting the student runs Test again and
   compares.

The browser can only ever reach this site's own `/api/*` endpoints — the
API key never appears in any client-side file.

## Deploying — GitHub → Netlify only

This site deploys **only** via a GitHub push to `main` triggering a Netlify
build through continuous deployment. **Do not** deploy by dragging a build
folder into the Netlify UI — that path bypasses git history and this
deploy rule, and isn't used for this project.

To ship a change: commit, push to `main`, and let Netlify's GitHub
integration build and deploy it.

## Environment variable

| Name | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Netlify → Site configuration → Environment variables | Server-side only. Required for all three endpoints. Without it, each returns a "not switched on yet" message instead of crashing. |
| `GITHUB_TOKEN`, `STACKEXCHANGE_KEY`, `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD`, `NVD_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY` | Same place | Optional, Stage 3 only. Each raises a source's rate limit or switches it on; missing ones are skipped. See `.env.example`. |

Never commit this key, put it in client-side code, or paste it into chat.

## Rate limits — and why they're structured this way

Defined as named constants at the top of `netlify/functions/lib/rate-limit.mjs`:

- **25 generations per browser session per hour** — the primary control.
- **400 generations per IP per hour** — a much looser anti-abuse backstop.
- **600 generations per day, site-wide.**

Students use this tool live, in lectures and bootcamps of up to ~150
people, on shared campus wifi — so dozens or hundreds of students can
appear to us behind a small handful of shared public IP addresses.
Rate-limiting primarily by IP would risk locking out an entire lecture
theatre mid-session. Instead, each browser generates a random session id
(stored in `localStorage`) and sends it as a header on every request; that
per-session limit is the real per-student control. The per-IP number above
is only a backstop against a genuine scripted abuser, set high enough that
a full lecture theatre sharing one IP never trips it.

All three are tracked with small counters in Netlify Blobs. Once the daily
site-wide limit is hit, the functions stop calling the Anthropic API
entirely (to control cost) and return a plain message saying so, rather
than continuing to spend.

## No data is stored

Nothing a student types is logged, saved, or persisted. Their answers are
sent once per stage to generate a result and are not written anywhere —
not to Netlify Blobs, not to a log, not to a database. Two things are
stored only transiently, and only as an implementation detail of talking
to a serverless backend, never as a record kept on purpose:

- Small numeric rate-limit counters (never the submitted text or output).
- Stage 3's job record (`test-background.mjs` / `test-status.mjs`) —
  holds that one generation's result just long enough for the browser to
  poll and collect it, then deletes it immediately on retrieval.

Stage 3 also sends short search phrases, written by the audience-map step
from the student's problem, to the public search APIs it uses (Stack
Exchange, Hacker News, GitHub, the allowlisted forums, the App Store,
GOV.UK, NVD, arXiv, Semantic Scholar, and Bluesky if configured). Those
are search queries like "voice control windows", not the student's text,
but each service handles them under its own terms.

## Local development

Requires Node.js and the Netlify CLI (`npm install -g netlify-cli`).

```bash
npm install
netlify dev
```

`netlify dev` runs the functions locally and emulates Netlify Blobs. You'll
still need `ANTHROPIC_API_KEY` set locally (e.g. in a `.netlify`-managed
env or a local `.env`, which is git-ignored) for generation to work.
