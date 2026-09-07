// Spot the Opportunity — client-side only. No secrets live here; every
// generation request goes to this site's own /api/spot, /api/dig, or
// /api/test endpoint.

(function () {
  "use strict";

  // ---------- Session id (for session-based rate limiting — see
  // netlify/functions/lib/rate-limit.mjs for why this exists instead of
  // per-IP limiting) ----------
  const SESSION_ID = getOrCreateSessionId();

  function getOrCreateSessionId() {
    try {
      let id = localStorage.getItem("stoSessionId");
      if (!id) {
        id = window.crypto && crypto.randomUUID ? crypto.randomUUID() : randomFallbackId();
        localStorage.setItem("stoSessionId", id);
      }
      return id;
    } catch {
      // localStorage unavailable (private browsing, disabled storage, etc.)
      // — fall back to a per-page-load id. The IP backstop still applies.
      return randomFallbackId();
    }
  }

  function randomFallbackId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // ---------- Shared state across stages ----------
  const state = {
    spot: null, // { problem, idea, result }
    dig: null, // { whys: string[5], result }
    test: null, // { result }
  };

  // ---------- Shared helpers ----------
  async function callApi(endpoint, payload) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": SESSION_ID },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.error) {
        return { ok: false, message: (data && data.message) || "Something went wrong. Please try again." };
      }
      return { ok: true, data };
    } catch {
      return { ok: false, message: "Couldn't reach the server. Please check your connection and try again." };
    }
  }

  function setButtonLoading(btn, isLoading, loadingText, idleText) {
    btn.disabled = isLoading;
    const labelEl = btn.querySelector(".btn-label") || btn;
    labelEl.textContent = isLoading ? loadingText : idleText;
    btn.classList.toggle("is-loading", isLoading);
  }

  function showStatus(el, message) {
    el.textContent = message;
    el.hidden = false;
  }

  function hideStatus(el) {
    el.hidden = true;
    el.textContent = "";
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  const announcer = document.getElementById("stage-announcer");
  function announce(message) {
    announcer.textContent = message;
  }

  function setNavState(stageKey, status) {
    const item = document.querySelector(`.stage-nav-item[data-stage-nav="${stageKey}"]`);
    item.classList.remove("is-locked", "is-current", "is-complete");
    item.classList.add(`is-${status}`);
    if (status === "current") {
      item.setAttribute("aria-current", "step");
    } else {
      item.removeAttribute("aria-current");
    }
  }

  function unlockStage(stageKey, announceLabel) {
    const section = document.getElementById(`stage-${stageKey}`);
    section.hidden = false;
    section.classList.remove("is-locked");
    setNavState(stageKey, "current");
    announce(`${announceLabel} unlocked.`);
    section.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }

  function lockStage(stageKey) {
    const section = document.getElementById(`stage-${stageKey}`);
    section.hidden = true;
    section.classList.add("is-locked");
    setNavState(stageKey, "locked");
  }

  // ---------- Voice input (SpeechRecognition), text typing always works ----------
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let activeMicBtn = null;

  document.querySelectorAll(".mic-btn").forEach((btn) => {
    if (!SpeechRecognitionCtor) {
      btn.disabled = true;
      btn.title = "Voice input isn't supported in this browser — try typing instead, or use Chrome/Edge.";
      return;
    }

    btn.title = "Click to speak this field";
    btn.addEventListener("click", () => toggleListening(btn));
  });

  function toggleListening(btn) {
    if (activeMicBtn === btn) {
      stopListening();
      return;
    }

    stopListening();

    const targetId = btn.getAttribute("data-target");
    const targetField = document.getElementById(targetId);

    recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-GB";
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.addEventListener("result", (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join(" ");
      const existing = targetField.value.trim();
      targetField.value = (existing ? existing + " " : "") + transcript.trim();
    });

    recognition.addEventListener("end", () => {
      btn.classList.remove("is-listening");
      activeMicBtn = null;
      recognition = null;
    });

    recognition.addEventListener("error", () => {
      btn.classList.remove("is-listening");
      activeMicBtn = null;
      recognition = null;
    });

    try {
      recognition.start();
      btn.classList.add("is-listening");
      activeMicBtn = btn;
    } catch {
      // Ignore — e.g. mic permission denied. Typing still works.
    }
  }

  function stopListening() {
    if (recognition) {
      recognition.stop();
    }
    if (activeMicBtn) {
      activeMicBtn.classList.remove("is-listening");
    }
    activeMicBtn = null;
  }

  // ================= STAGE 1 — SPOT =================
  const spotForm = document.getElementById("spot-form");
  const problemField = document.getElementById("problem");
  const ideaField = document.getElementById("idea");
  const spotSubmitBtn = document.getElementById("spot-submit-btn");
  const spotResult = document.getElementById("spot-result");
  const spotStatus = document.getElementById("spot-status");

  const SPOT_IDLE_LABEL = "Sharpen my problem statement";
  const SPOT_LOADING_LABEL = "Bringing it into focus";

  spotForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const problem = problemField.value.trim();
    const idea = ideaField.value.trim();
    if (!problem || !idea) {
      showStatus(spotStatus, "Please fill in both fields.");
      return;
    }
    runSpot({ problem, idea });
  });

  document.getElementById("spot-retry-btn").addEventListener("click", () => {
    if (!state.spot) return;
    runSpot({ problem: state.spot.problem, idea: state.spot.idea });
  });

  document.getElementById("spot-reset-btn").addEventListener("click", resetEverything);

  document.getElementById("spot-copy-btn").addEventListener("click", async () => {
    if (!state.spot || !state.spot.result) return;
    await copyText(formatSpotAsText(state.spot.result), document.getElementById("spot-copy-btn"));
  });

  async function runSpot(inputs) {
    hideStatus(spotStatus);
    setButtonLoading(spotSubmitBtn, true, SPOT_LOADING_LABEL, SPOT_IDLE_LABEL);

    const result = await callApi("/api/spot", inputs);

    setButtonLoading(spotSubmitBtn, false, SPOT_LOADING_LABEL, SPOT_IDLE_LABEL);

    if (!result.ok) {
      showStatus(spotStatus, result.message);
      return;
    }

    state.spot = { problem: inputs.problem, idea: inputs.idea, result: result.data };
    renderSpotResult(result.data);

    setNavState("spot", "complete");
    if (document.getElementById("stage-dig").hidden) {
      unlockStage("dig", "Stage 2: Dig");
    }
  }

  function renderSpotResult(data) {
    document.getElementById("spot-result-statement").textContent = data.statement;
    document.getElementById("spot-result-who").textContent = data.who;
    document.getElementById("spot-result-what").textContent = data.what;
    document.getElementById("spot-result-when").textContent = data.when;
    document.getElementById("spot-result-how").textContent = data.how;
    document.getElementById("spot-result-why").textContent = data.why;

    const assumptionsEl = document.getElementById("spot-result-assumptions");
    if (data.assumptions && data.assumptions.trim()) {
      assumptionsEl.textContent = "Where we had to guess: " + data.assumptions.trim();
      assumptionsEl.hidden = false;
    } else {
      assumptionsEl.hidden = true;
    }

    spotForm.hidden = true;
    spotResult.hidden = false;
  }

  function formatSpotAsText(data) {
    let text =
      `Problem statement: ${data.statement}\n\n` +
      `Who: ${data.who}\nWhat: ${data.what}\nWhen: ${data.when}\nHow: ${data.how}\nWhy: ${data.why}`;
    if (data.assumptions && data.assumptions.trim()) {
      text += `\n\nWhere we had to guess: ${data.assumptions.trim()}`;
    }
    return text;
  }

  // ================= STAGE 2 — DIG =================
  const digForm = document.getElementById("dig-form");
  const digSubmitBtn = document.getElementById("dig-submit-btn");
  const digResult = document.getElementById("dig-result");
  const digStatus = document.getElementById("dig-status");
  const WHY_COUNT = 5;

  const DIG_IDLE_LABEL = "Review my thinking";
  const DIG_LOADING_LABEL = "Checking your reasoning";

  document.getElementById("dig-example-toggle").addEventListener("click", () => {
    const block = document.getElementById("dig-example");
    block.hidden = !block.hidden;
  });

  document.querySelectorAll(".why-next-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-why"));
      const currentField = document.getElementById(`why-${idx}`);
      const value = currentField.value.trim();
      if (!value) {
        showStatus(digStatus, "Please answer this why before continuing.");
        return;
      }
      hideStatus(digStatus);

      const nextIdx = idx + 1;
      const nextItem = document.querySelector(`.why-item[data-why="${nextIdx}"]`);
      const contextEl = document.getElementById(`why-context-${nextIdx}`);
      if (contextEl) {
        contextEl.textContent = `Your answer to Why ${idx}: ${value}`;
      }
      nextItem.hidden = false;

      if (nextIdx === WHY_COUNT) {
        digSubmitBtn.hidden = false;
      }

      const nextField = document.getElementById(`why-${nextIdx}`);
      nextField.focus();
      nextItem.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
    });
  });

  digForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitDig();
  });

  document.getElementById("dig-recheck-btn").addEventListener("click", submitDig);

  function submitDig() {
    const whys = [];
    for (let i = 1; i <= WHY_COUNT; i++) {
      whys.push(document.getElementById(`why-${i}`).value.trim());
    }
    if (whys.some((w) => !w)) {
      showStatus(digStatus, "Please answer all five whys before reviewing.");
      return;
    }
    if (!state.spot || !state.spot.result) {
      showStatus(digStatus, "Please complete Stage 1 first.");
      return;
    }
    runDig(whys);
  }

  async function runDig(whys) {
    hideStatus(digStatus);
    setButtonLoading(digSubmitBtn, true, DIG_LOADING_LABEL, DIG_IDLE_LABEL);
    document.getElementById("dig-recheck-btn").disabled = true;

    const result = await callApi("/api/dig", { statement: state.spot.result.statement, whys });

    setButtonLoading(digSubmitBtn, false, DIG_LOADING_LABEL, DIG_IDLE_LABEL);
    document.getElementById("dig-recheck-btn").disabled = false;

    if (!result.ok) {
      showStatus(digStatus, result.message);
      return;
    }

    state.dig = { whys, result: result.data };
    renderDigResult(result.data);

    setNavState("dig", "complete");
    if (document.getElementById("stage-test").hidden) {
      unlockStage("test", "Stage 3: Test");
    }
  }

  const STRENGTH_LABELS = { strong: "Strong chain", workable: "Workable chain", needs_work: "Needs work" };

  function renderDigResult(data) {
    const strengthEl = document.getElementById("dig-strength");
    strengthEl.textContent = STRENGTH_LABELS[data.strength] || "Workable chain";
    strengthEl.className = `dig-strength-badge dig-strength-${data.strength}`;

    document.getElementById("dig-root-cause").textContent = data.root_cause;

    const feedbackEl = document.getElementById("dig-feedback");
    feedbackEl.innerHTML = "";
    data.feedback.forEach((f) => {
      const li = document.createElement("li");
      li.textContent = f;
      feedbackEl.appendChild(li);
    });

    const deeperEl = document.getElementById("dig-deeper-prompt");
    if (data.deeper_prompt && data.deeper_prompt.trim()) {
      deeperEl.textContent = "Push further: " + data.deeper_prompt.trim();
      deeperEl.hidden = false;
    } else {
      deeperEl.hidden = true;
    }

    digResult.hidden = false;
  }

  // ================= STAGE 3 — TEST =================
  const testRunBtn = document.getElementById("test-run-btn");
  const testResult = document.getElementById("test-result");
  const testStatus = document.getElementById("test-status");

  const TEST_IDLE_LABEL = "Test this against real conversations";
  const TEST_LOADING_LABEL = "Searching real conversations";

  // A web-search-backed validation with synthesis routinely takes longer
  // than Netlify's ~30s synchronous function limit, so /api/test is a
  // background function: this kicks off the job, then polls
  // /api/test-status (a fast, separate endpoint) until it's done. See
  // netlify/functions/test-background.mjs and test-status.mjs.
  const TEST_POLL_INTERVAL_MS = 2000;
  const TEST_POLL_MAX_MS = 120000; // generous ceiling for a multi-search lookup

  testRunBtn.addEventListener("click", runTest);

  async function runTest() {
    if (!state.spot || !state.spot.result || !state.dig || !state.dig.result) {
      showStatus(testStatus, "Please complete Stage 1 and Stage 2 first.");
      return;
    }

    hideStatus(testStatus);
    setButtonLoading(testRunBtn, true, TEST_LOADING_LABEL, TEST_IDLE_LABEL);

    const spot = state.spot.result;
    const jobId = window.crypto && crypto.randomUUID ? crypto.randomUUID() : randomFallbackId();

    try {
      await fetch("/api/test", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": SESSION_ID },
        body: JSON.stringify({
          jobId,
          statement: spot.statement,
          who: spot.who,
          what: spot.what,
          when: spot.when,
          how: spot.how,
          why: spot.why,
          rootCause: state.dig.result.root_cause,
        }),
      });
    } catch {
      setButtonLoading(testRunBtn, false, TEST_LOADING_LABEL, TEST_IDLE_LABEL);
      showStatus(testStatus, "Couldn't reach the server. Please check your connection and try again.");
      return;
    }

    const outcome = await pollTestJob(jobId);
    setButtonLoading(testRunBtn, false, TEST_LOADING_LABEL, TEST_IDLE_LABEL);

    if (!outcome.ok) {
      showStatus(testStatus, outcome.message);
      return;
    }

    state.test = { result: outcome.data };
    renderTestResult(outcome.data);

    setNavState("test", "complete");
    if (document.getElementById("stage-judge").hidden) {
      unlockStage("judge", "Stage 4: Judge");
    }
    renderJudgeSummary();
  }

  async function pollTestJob(jobId) {
    const deadline = Date.now() + TEST_POLL_MAX_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, TEST_POLL_INTERVAL_MS));
      try {
        const response = await fetch(`/api/test-status?id=${encodeURIComponent(jobId)}`, {
          headers: { "x-session-id": SESSION_ID },
        });
        const data = await response.json().catch(() => null);
        if (data && data.status === "done") {
          return { ok: true, data: data.result };
        }
        if (data && data.status === "error") {
          return { ok: false, message: data.message || "Something went wrong. Please try again." };
        }
        // status "pending" (or an unreadable response) — keep polling.
      } catch {
        // Transient network hiccup — keep polling until the deadline.
      }
    }
    return { ok: false, message: "This is taking longer than expected. Please try again in a moment." };
  }

  function renderTestResult(data) {
    const card = document.getElementById("test-verdict-card");
    card.className = `verdict-card verdict-${data.verdict}`;
    document.getElementById("test-verdict-word").textContent = data.verdict === "migraine" ? "Migraine" : "Headache";
    document.getElementById("test-verdict-score").textContent = String(data.score);
    document.getElementById("test-verdict-reasoning").textContent = data.reasoning;

    const sharpeningWrap = document.getElementById("test-sharpening");
    const sharpeningList = document.getElementById("test-sharpening-list");
    sharpeningList.innerHTML = "";
    if (data.verdict === "headache" && data.sharpening_advice.length) {
      data.sharpening_advice.forEach((a) => {
        const li = document.createElement("li");
        li.textContent = a;
        sharpeningList.appendChild(li);
      });
      sharpeningWrap.hidden = false;
    } else {
      sharpeningWrap.hidden = true;
    }

    const comparison = data.root_cause_comparison;
    document.getElementById("test-comparison-verdict").textContent =
      "Verdict: " + capitalize(comparison.verdict) + (comparison.evidence_suggests ? ` — ${comparison.evidence_suggests}` : "");
    document.getElementById("test-comparison-explanation").textContent = comparison.explanation;

    const painPointsEl = document.getElementById("test-pain-points");
    painPointsEl.innerHTML = "";
    if (!data.pain_points.length) {
      const p = document.createElement("p");
      p.textContent = "No usable real-world quotes were found for this search.";
      painPointsEl.appendChild(p);
    }
    data.pain_points.forEach((pp) => {
      const wrap = document.createElement("div");
      wrap.className = "pain-point";

      const h4 = document.createElement("h4");
      h4.textContent = pp.category;
      wrap.appendChild(h4);

      const summary = document.createElement("p");
      summary.textContent = pp.summary;
      wrap.appendChild(summary);

      if (pp.frequency) {
        const freq = document.createElement("p");
        freq.className = "pain-point-frequency";
        freq.textContent = "Frequency: " + pp.frequency;
        wrap.appendChild(freq);
      }

      const quoteList = document.createElement("ul");
      quoteList.className = "quotes";
      pp.quotes.forEach((q) => {
        const li = document.createElement("li");

        const blockquote = document.createElement("blockquote");
        blockquote.textContent = q.text;
        li.appendChild(blockquote);

        const cite = document.createElement("p");
        cite.className = "quote-source";
        const link = document.createElement("a");
        link.href = q.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = q.source || q.url;
        cite.appendChild(link);
        li.appendChild(cite);

        quoteList.appendChild(li);
      });
      wrap.appendChild(quoteList);

      painPointsEl.appendChild(wrap);
    });

    const rankingEl = document.getElementById("test-priority-ranking");
    rankingEl.innerHTML = "";
    data.priority_ranking.forEach((r) => {
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = r.pain_point;
      li.appendChild(strong);
      li.appendChild(document.createTextNode(" — " + r.rationale));
      rankingEl.appendChild(li);
    });

    const evidenceNoteEl = document.getElementById("test-evidence-note");
    if (data.evidence_note && data.evidence_note.trim()) {
      evidenceNoteEl.textContent = data.evidence_note.trim();
      evidenceNoteEl.hidden = false;
    } else {
      evidenceNoteEl.hidden = true;
    }

    testResult.hidden = false;
  }

  function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  // ================= STAGE 4 — JUDGE =================
  const judgeConclusion = document.getElementById("judge-conclusion");
  let judgeConclusionTouched = false;
  judgeConclusion.addEventListener("input", () => {
    judgeConclusionTouched = true;
  });

  document.getElementById("judge-copy-btn").addEventListener("click", async () => {
    await copyText(formatJudgeAsText(), document.getElementById("judge-copy-btn"));
  });

  document.getElementById("judge-print-btn").addEventListener("click", () => {
    window.print();
  });

  // Textareas don't print reliably across browsers, so the conclusion is
  // mirrored into a plain print-only element right before printing — this
  // covers Ctrl+P / Cmd+P too, not just our own button.
  window.addEventListener("beforeprint", () => {
    document.getElementById("judge-conclusion-print").textContent = judgeConclusion.value;
  });

  function renderJudgeSummary() {
    if (!state.spot || !state.dig || !state.test) return;
    const spot = state.spot.result;
    const dig = state.dig.result;
    const test = state.test.result;

    const summaryEl = document.getElementById("judge-summary");
    summaryEl.innerHTML = "";

    summaryEl.appendChild(buildSummarySection("Problem statement", [
      spot.statement,
      `Who: ${spot.who}`,
      `What: ${spot.what}`,
      `When: ${spot.when}`,
      `How: ${spot.how}`,
      `Why: ${spot.why}`,
    ]));

    summaryEl.appendChild(
      buildSummarySection("Root cause (Five Whys)", [dig.root_cause, ...dig.feedback.map((f) => "· " + f)])
    );

    const verdictLine = `${test.verdict === "migraine" ? "Migraine" : "Headache"} (${test.score}/100) — ${test.reasoning}`;
    summaryEl.appendChild(buildSummarySection("Evidence and verdict", [verdictLine]));

    if (!judgeConclusionTouched) {
      judgeConclusion.value = `We believe this problem is a ${test.verdict} because...`;
    }
  }

  function buildSummarySection(title, lines) {
    const wrap = document.createElement("div");
    wrap.className = "judge-summary-section";
    const h3 = document.createElement("h3");
    h3.textContent = title;
    wrap.appendChild(h3);
    lines.forEach((line) => {
      const p = document.createElement("p");
      p.textContent = line;
      wrap.appendChild(p);
    });
    return wrap;
  }

  function formatJudgeAsText() {
    const spot = state.spot && state.spot.result;
    const dig = state.dig && state.dig.result;
    const test = state.test && state.test.result;
    if (!spot || !dig || !test) return "";

    const lines = [
      "SPOT THE OPPORTUNITY",
      "",
      "== Problem statement ==",
      spot.statement,
      `Who: ${spot.who}`,
      `What: ${spot.what}`,
      `When: ${spot.when}`,
      `How: ${spot.how}`,
      `Why: ${spot.why}`,
      "",
      "== Five Whys / root cause ==",
      ...state.dig.whys.map((w, i) => `Why ${i + 1}: ${w}`),
      "",
      `Root cause: ${dig.root_cause}`,
      ...dig.feedback.map((f) => "· " + f),
      "",
      "== Evidence from real conversations ==",
    ];

    test.pain_points.forEach((pp) => {
      lines.push(`-- ${pp.category} --`, pp.summary, `Frequency: ${pp.frequency}`);
      pp.quotes.forEach((q) => {
        lines.push(`"${q.text}" — ${q.source || ""} (${q.url})`);
      });
      lines.push("");
    });

    lines.push(
      `Root cause check: ${test.root_cause_comparison.verdict} — ${test.root_cause_comparison.explanation}`,
      "",
      `Verdict: ${test.verdict === "migraine" ? "Migraine" : "Headache"} (${test.score}/100)`,
      test.reasoning
    );

    if (test.sharpening_advice.length) {
      lines.push("", "Sharpening advice:", ...test.sharpening_advice.map((a) => "· " + a));
    }

    lines.push("", "== Conclusion ==", judgeConclusion.value.trim());

    return lines.join("\n");
  }

  // ---------- Copy-to-clipboard (shared) ----------
  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    } catch {
      window.alert("Couldn't copy automatically — please select and copy the text manually.");
    }
  }

  // ---------- Full reset ----------
  function resetEverything() {
    stopListening();

    spotForm.reset();
    spotForm.hidden = false;
    spotResult.hidden = true;
    hideStatus(spotStatus);
    state.spot = null;
    setNavState("spot", "current");

    digForm.reset();
    for (let i = 2; i <= WHY_COUNT; i++) {
      document.querySelector(`.why-item[data-why="${i}"]`).hidden = true;
    }
    digSubmitBtn.hidden = true;
    digResult.hidden = true;
    document.getElementById("dig-example").hidden = true;
    hideStatus(digStatus);
    state.dig = null;
    lockStage("dig");

    testResult.hidden = true;
    hideStatus(testStatus);
    state.test = null;
    lockStage("test");

    judgeConclusion.value = "";
    judgeConclusionTouched = false;
    document.getElementById("judge-summary").innerHTML = "";
    lockStage("judge");

    problemField.focus();
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }
})();
