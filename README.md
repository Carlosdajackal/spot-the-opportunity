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
   pre-filled or generated for them); the tool reviews the whole chain once
   and states the root cause it actually arrives at. Each Why has a
   **Need a nudge?** button that reveals preloaded guiding questions for that
   depth (no API call, no cost). The question bank is the `NUDGES` object in
   `public/app.js`; the previous answer is quoted back into one lead question.
3. **Test** — searches real public conversations (via Anthropic's web
   search tool) to check whether real people express this problem, and how
   painfully, then scores it 0–100 as a **migraine** (needs solving
   urgently) or a **headache** (nice-to-have, not urgent).
4. **Judge** — no API call. A summary of all three stages, with a
   conclusion box for the student to write up their own judgment, a Copy
   export, and Print / Save as PDF.

## How it works

- `public/index.html` (+ `styles.css`, `app.js`) — the page students see.
  Contains no secrets and never talks to Anthropic directly.
- `netlify/functions/spot.mjs`, `dig.mjs` — two ordinary Netlify serverless
  functions. Each holds the Anthropic API key server-side
  (`Netlify.env.get("ANTHROPIC_API_KEY")`) and returns the finished result
  directly to the browser, at `/api/spot` and `/api/dig`.
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
  Anthropic API caller, rate limiting, and small HTTP helpers.

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

## Local development

Requires Node.js and the Netlify CLI (`npm install -g netlify-cli`).

```bash
npm install
netlify dev
```

`netlify dev` runs the functions locally and emulates Netlify Blobs. You'll
still need `ANTHROPIC_API_KEY` set locally (e.g. in a `.netlify`-managed
env or a local `.env`, which is git-ignored) for generation to work.
