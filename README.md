# Spot the Opportunity

A public tool for **UEL Careers and Student Enterprise**. Students describe a
rough problem and idea; the tool returns a narrow, testable problem
statement in the "Spot the Opportunity" format. No login required.

## How it works

- `public/index.html` (+ `styles.css`, `app.js`) — the page students see.
  Contains no secrets and never talks to Anthropic directly.
- `netlify/functions/sharpen.mjs` — a Netlify serverless function. Holds the
  Anthropic API key server-side (`Netlify.env.get("ANTHROPIC_API_KEY")`),
  calls the Anthropic API, and returns only the finished result to the
  browser at `/api/sharpen`.

The browser can only ever reach this site's own `/api/sharpen` endpoint —
the API key never appears in any client-side file.

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
| `ANTHROPIC_API_KEY` | Netlify → Site configuration → Environment variables | Server-side only. Required for `/api/sharpen` to generate anything. Without it, the function returns a "not switched on yet" message instead of crashing. |

Never commit this key, put it in client-side code, or paste it into chat.

## Rate limits

Defined as named constants at the top of `netlify/functions/sharpen.mjs`:

- **12 generations per visitor IP per hour**
- **600 generations per day, site-wide**

Both are tracked with small counters in Netlify Blobs. Once the daily
site-wide limit is hit, the function stops calling the Anthropic API
entirely (to control cost) and returns a plain message saying so, rather
than continuing to spend.

## No data is stored

Nothing a student types is logged, saved, or persisted. Their answers are
sent once to generate a statement and are not written anywhere — not to
Netlify Blobs, not to a log, not to a database. (The only thing stored is
small numeric rate-limit counters — never the submitted text.)

## Local development

Requires Node.js and the Netlify CLI (`npm install -g netlify-cli`).

```bash
npm install
netlify dev
```

`netlify dev` runs the function locally and emulates Netlify Blobs. You'll
still need `ANTHROPIC_API_KEY` set locally (e.g. in a `.netlify`-managed
env or a local `.env`, which is git-ignored) for generation to work.
