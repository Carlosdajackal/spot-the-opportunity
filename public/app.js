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
    if (!problem) {
      showStatus(spotStatus, "Please describe the problem you're working on.");
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

  // Nudge questions: preloaded, no API call. Questions only — never an
  // answer — so the student still does the thinking. Edit wording here.
  // `lead` (Why 2-5) quotes the student's previous answer back to them;
  // `{prev}` is replaced with a shortened copy of it.
  const NUDGES = {
    1: {
      aim: "Describe what actually happens, in plain terms.",
      questions: [
        "Who is affected, and what are they trying to do at the moment it goes wrong?",
        "What do they do instead today to cope or work around it?",
        "When did you last see this happen, or hear someone describe it?",
        "What is the first thing that goes wrong, before anything else?",
      ],
    },
    2: {
      aim: "Find the direct cause of what you wrote in Why 1.",
      lead: "You said “{prev}”. What is the immediate trigger that makes that happen?",
      questions: [
        "Is something missing: a tool, information, time or money?",
        "Is it a habit, a skill gap, or a choice people make?",
        "Would this still happen if the people involved were trying their hardest?",
      ],
    },
    3: {
      aim: "Look underneath the cause you just gave.",
      lead: "You said “{prev}”. What sits behind that?",
      questions: [
        "Why hasn’t this already been fixed?",
        "Who decided it works this way, and why might they have done so?",
        "Is this true for everyone affected, or only some of them?",
      ],
    },
    4: {
      aim: "Look for the system, rule or incentive that keeps it going.",
      lead: "You said “{prev}”. What keeps that in place?",
      questions: [
        "Is there a rule, cost, process or incentive that makes it hard to change?",
        "Who benefits from things staying as they are?",
        "Is this a one-off, or does it keep happening in similar situations?",
      ],
    },
    5: {
      aim: "Test whether you have reached a root cause.",
      lead: "You said “{prev}”. If this were fixed, would your original problem stop?",
      questions: [
        "Is this a cause, or still a symptom of something deeper?",
        "Is it something you know, or something you are assuming and would need to check?",
        "Could you explain it to a stranger in one sentence?",
      ],
    },
  };
  // Shown on every Why: guards against the most common Five Whys failure.
  const NUDGE_RESTATE_CHECK =
    "Does your answer say something new, or just repeat the last one in different words?";
  const NUDGE_PREV_MAX = 90;

  function buildNudgePanel(idx) {
    const panel = document.getElementById(`nudge-${idx}`);
    const data = NUDGES[idx];
    panel.textContent = "";

    const aim = document.createElement("p");
    aim.className = "nudge-aim";
    aim.textContent = data.aim;
    panel.appendChild(aim);

    const list = document.createElement("ul");
    list.className = "nudge-list";
    const add = (text) => {
      const li = document.createElement("li");
      li.textContent = text;
      list.appendChild(li);
    };

    if (data.lead) {
      const prevField = document.getElementById(`why-${idx - 1}`);
      let prev = prevField ? prevField.value.trim().replace(/\s+/g, " ") : "";
      if (prev.length > NUDGE_PREV_MAX) prev = prev.slice(0, NUDGE_PREV_MAX).trimEnd() + "…";
      if (prev) add(data.lead.replace("{prev}", prev));
    }
    data.questions.forEach(add);
    if (idx > 1) add(NUDGE_RESTATE_CHECK);

    panel.appendChild(list);
  }

  document.querySelectorAll(".nudge-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-why"));
      const panel = document.getElementById(`nudge-${idx}`);
      const open = btn.getAttribute("aria-expanded") === "true";
      if (!open) buildNudgePanel(idx);
      panel.hidden = open;
      btn.setAttribute("aria-expanded", String(!open));
      btn.textContent = open ? "Need a nudge?" : "Hide nudge";
    });
  });

  // ---------- Hints: 2 across the whole Five Whys ----------
  // One Hint tool, moved next to whichever Why box is active. A hint for
  // Why n is about the student's answer to Why n-1 (Why 1: the problem
  // statement). It's only counted once one is actually shown, so a failed
  // request, an empty previous answer or a double-click never uses one up.
  // The count lives only in memory: "Start over" (or a refresh) resets it.
  // Hints are shown in a panel, never written into the answer box.
  const MAX_HINTS = 2;
  const HINT_LOADING_LABEL = "Getting a hint…";
  const hintTool = document.getElementById("hint-tool");
  const hintBtn = document.getElementById("hint-btn");
  const hintStatus = document.getElementById("hint-status");
  const hintAnnouncer = document.getElementById("hint-announcer");
  let hintsUsed = 0;
  let hintLog = []; // { why, nudge, suggested_answer } for each hint shown; marked in the PDF
  let hintLoading = false;
  let hintRequestId = 0; // bumped on Start over, so a late reply is ignored
  let activeWhy = 1;

  function hintsLeft() {
    return MAX_HINTS - hintsUsed;
  }

  function updateHintButton() {
    const left = hintsLeft();
    hintBtn.disabled = hintLoading || left <= 0;
    hintBtn.textContent = hintLoading ? HINT_LOADING_LABEL : left > 0 ? `Hint on my answer (${left} left)` : "No hints left";
    document.getElementById("hint-exhausted").hidden = left > 0;
  }

  function moveHintTool(idx) {
    activeWhy = idx;
    const nudgeBtn = document.querySelector(`.nudge-btn[data-why="${idx}"]`);
    if (nudgeBtn.nextElementSibling !== hintTool) nudgeBtn.after(hintTool);
  }

  for (let i = 1; i <= WHY_COUNT; i++) {
    document.getElementById(`why-${i}`).addEventListener("focus", () => {
      if (activeWhy === i) return;
      hideStatus(hintStatus);
      moveHintTool(i);
    });
  }

  hintBtn.addEventListener("click", async () => {
    if (hintLoading || hintsLeft() <= 0 || !state.spot || !state.spot.result) return;

    const idx = activeWhy;
    const whys = [];
    for (let i = 1; i < idx; i++) {
      whys.push(document.getElementById(`why-${i}`).value.trim());
    }
    if (idx > 1 && !whys[idx - 2]) {
      showStatus(hintStatus, "Write your answer to the previous Why first, then ask for a hint.");
      return;
    }

    hideStatus(hintStatus);
    hintLoading = true;
    updateHintButton();
    const requestId = ++hintRequestId;

    const result = await callApi("/api/hint", {
      statement: state.spot.result.statement,
      because: state.spot.result.why,
      whys,
      why: idx,
    });

    if (requestId !== hintRequestId) return; // the student pressed Start over meanwhile
    hintLoading = false;

    if (!result.ok) {
      showStatus(hintStatus, "Couldn't get a hint, try again.");
      updateHintButton();
      return;
    }

    hintsUsed++;
    hintLog.push({ why: idx, nudge: result.data.nudge, suggested_answer: result.data.suggested_answer });
    updateHintButton();
    renderHint(idx, result.data);
  });

  function renderHint(idx, data) {
    const panel = document.getElementById(`hint-panel-${idx}`);
    const card = document.createElement("div");
    card.className = "hint-card";

    const label = document.createElement("p");
    label.className = "hint-label";
    label.textContent = `Hint for Why ${idx}`;
    card.appendChild(label);

    const nudge = document.createElement("p");
    nudge.className = "hint-nudge";
    nudge.textContent = data.nudge;
    card.appendChild(nudge);

    const suggestLabel = document.createElement("p");
    suggestLabel.className = "hint-suggest-label";
    suggestLabel.textContent = "An answer you could use or adapt:";
    card.appendChild(suggestLabel);

    const suggest = document.createElement("blockquote");
    suggest.className = "hint-suggest";
    suggest.textContent = data.suggested_answer;
    card.appendChild(suggest);

    panel.appendChild(card);
    panel.hidden = false;

    const left = hintsLeft();
    hintAnnouncer.textContent = `Hint for Why ${idx}: ${data.nudge} An answer you could use or adapt: ${data.suggested_answer} ${
      left === 0 ? "No hints left." : `${left} ${left === 1 ? "hint" : "hints"} left.`
    }`;
  }

  function resetHints() {
    hintRequestId++;
    hintsUsed = 0;
    hintLog = [];
    hintLoading = false;
    document.querySelectorAll(".hint-panel").forEach((p) => {
      p.hidden = true;
      p.textContent = "";
    });
    hideStatus(hintStatus);
    hintAnnouncer.textContent = "";
    moveHintTool(1);
    updateHintButton();
  }

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
  const TEST_POLL_MAX_MS = 300000; // generous ceiling: audience map + parallel sources + synthesis

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

  // Display names for the evidence labels the server assigns. Only the
  // first two ever count towards the score (enforced server-side in
  // lib/test-pipeline.mjs); the notes say so to the student.
  const EVIDENCE_LABELS = [
    { key: "person", name: "Person with the problem", note: "First-hand accounts. These count towards the score." },
    { key: "practitioner", name: "Practitioner / peer", note: "People close to the audience. These count towards the score." },
    { key: "commentary", name: "Commentary / vendor", note: "Blogs, marketing and companies selling a fix. Shown for context; never counts." },
    { key: "cost", name: "Cost evidence", note: "Regulators, incidents, CVEs and statistics. Shows it matters; doesn't count as sentiment." },
    { key: "research", name: "Research", note: "Papers. Shows the problem is recognised and unsolved; doesn't count as sentiment." },
  ];
  const SOURCE_STATUS_TEXT = {
    ok: (r) => `${r.count} found`,
    no_results: () => "nothing relevant found",
    skipped: (r) => `skipped (${r.note})`,
    error: (r) => `couldn't be reached${r.note ? ` (${r.note})` : ""}`,
  };

  const BORDERLINE_MARGIN = 10; // points either side of the migraine line

  function verdictWord(verdict) {
    if (verdict === "migraine") return "Migraine";
    if (verdict === "headache") return "Headache";
    return "Not enough evidence to score";
  }

  function renderTestResult(data) {
    const insufficient = data.verdict === "insufficient";
    const card = document.getElementById("test-verdict-card");
    card.className = `verdict-card verdict-${data.verdict}`;
    document.getElementById("test-verdict-word").textContent = verdictWord(data.verdict);
    document.getElementById("test-verdict-score-wrap").hidden = insufficient;
    document.getElementById("test-verdict-score").textContent = insufficient ? "" : String(data.score);
    document.getElementById("test-verdict-reasoning").textContent = insufficient
      ? `This could be a headache, but we can't tell yet: we found ${data.counts.person} first-hand ${
          data.counts.person === 1 ? "account" : "accounts"
        } from people with the problem, and need at least ${data.min_person_items} to score it. ${data.reasoning}`.trim()
      : data.reasoning;

    // Scores this close to the migraine line can flip between runs, so
    // suggest running Test again rather than trusting one result.
    const threshold = data.migraine_threshold ?? 60;
    document.getElementById("test-borderline").hidden =
      insufficient || Math.abs(data.score - threshold) > BORDERLINE_MARGIN;

    document.getElementById("test-thin").hidden = !insufficient;
    const talkTo = document.getElementById("test-talk-to");
    talkTo.innerHTML = "";
    (data.talk_to || []).forEach((t) => {
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = t.who;
      li.appendChild(strong);
      if (t.where) li.appendChild(document.createTextNode(" — " + t.where));
      talkTo.appendChild(li);
    });
    document.getElementById("test-talk-to-wrap").hidden = !talkTo.children.length;

    const sharpeningWrap = document.getElementById("test-sharpening");
    const sharpeningList = document.getElementById("test-sharpening-list");
    sharpeningList.innerHTML = "";
    if (data.verdict !== "migraine" && data.sharpening_advice.length) {
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
      p.textContent = "No first-hand accounts of this problem were found in this search.";
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
        freq.textContent = "Based on " + pp.frequency;
        wrap.appendChild(freq);
      }

      painPointsEl.appendChild(wrap);
    });

    const evidenceEl = document.getElementById("test-evidence");
    evidenceEl.innerHTML = "";
    if (!data.evidence.length) {
      const p = document.createElement("p");
      p.textContent = "No usable evidence was found for this search.";
      evidenceEl.appendChild(p);
    }
    EVIDENCE_LABELS.forEach((label) => {
      const group = data.evidence.filter((e) => e.label === label.key);
      if (!group.length) return;

      const wrap = document.createElement("div");
      wrap.className = "evidence-group";

      const h4 = document.createElement("h4");
      h4.textContent = `${label.name} (${group.length})`;
      wrap.appendChild(h4);

      const note = document.createElement("p");
      note.className = "evidence-group-note";
      note.textContent = label.note;
      wrap.appendChild(note);

      const quoteList = document.createElement("ul");
      quoteList.className = "quotes";
      group.forEach((e) => {
        const li = document.createElement("li");
        li.className = `quote-${e.label}`;

        const blockquote = document.createElement("blockquote");
        blockquote.textContent = e.quote;
        li.appendChild(blockquote);

        const cite = document.createElement("p");
        cite.className = "quote-source";
        const chip = document.createElement("span");
        chip.className = "evidence-chip";
        chip.textContent = label.name;
        cite.appendChild(chip);
        const link = document.createElement("a");
        link.href = e.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = e.source || e.url;
        cite.appendChild(link);
        if (e.signals) cite.appendChild(document.createTextNode(` · ${e.signals}`));
        li.appendChild(cite);

        quoteList.appendChild(li);
      });
      wrap.appendChild(quoteList);
      evidenceEl.appendChild(wrap);
    });

    document.getElementById("test-cost-summary").textContent = data.cost_summary;
    document.getElementById("test-cost-wrap").hidden = !(data.cost_summary && data.cost_summary.trim());

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

    const sourcesEl = document.getElementById("test-sources");
    sourcesEl.innerHTML = "";
    (data.sources || [])
      .filter((r) => r.status !== "not_selected")
      .forEach((r) => {
        const li = document.createElement("li");
        const describe = SOURCE_STATUS_TEXT[r.status] || (() => r.status);
        li.textContent = `${r.label}: ${describe(r)}`;
        sourcesEl.appendChild(li);
      });

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

  // ---------- Download as PDF ----------
  // Built entirely in the browser with jsPDF (self-hosted under /vendor,
  // and only loaded the first time someone presses the button), so the
  // student's answers never leave their device for this. On iPhone, Safari
  // opens the PDF with a Share button to save it to Files or send it on.
  const DOWNLOAD_IDLE_LABEL = "Download my results (PDF)";
  const DOWNLOAD_LOADING_LABEL = "Preparing your PDF…";
  const downloadBtn = document.getElementById("judge-download-btn");
  const judgeStatus = document.getElementById("judge-status");
  let jsPdfLoading = null;

  function loadJsPdf() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (!jsPdfLoading) {
      jsPdfLoading = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/vendor/jspdf/jspdf.umd.min.js";
        script.onload = () => (window.jspdf && window.jspdf.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error("jsPDF missing")));
        script.onerror = () => reject(new Error("jsPDF failed to load"));
        document.head.appendChild(script);
      }).catch((error) => {
        jsPdfLoading = null; // allow a retry
        throw error;
      });
    }
    return jsPdfLoading;
  }

  downloadBtn.addEventListener("click", async () => {
    if (!state.spot || !state.dig || !state.test) return;
    hideStatus(judgeStatus);
    setButtonLoading(downloadBtn, true, DOWNLOAD_LOADING_LABEL, DOWNLOAD_IDLE_LABEL);
    try {
      const JsPDF = await loadJsPdf();
      buildResultsPdf(JsPDF).save(`spot-the-opportunity-${localDateStamp()}.pdf`);
    } catch {
      showStatus(judgeStatus, "Couldn't create the PDF. Please try again, or use Print instead.");
    } finally {
      setButtonLoading(downloadBtn, false, DOWNLOAD_LOADING_LABEL, DOWNLOAD_IDLE_LABEL);
    }
  });

  function localDateStamp() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // jsPDF's built-in fonts only cover Western European characters, so
  // swap typographic punctuation for plain equivalents and replace
  // anything else they can't draw, rather than printing garbage.
  function pdfSafe(text) {
    return String(text ?? "")
      .normalize("NFC")
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
      .replace(/[\u2012\u2013]/g, "-")
      .replace(/\s*\u2014\s*/g, " - ")
      .replace(/\u2026/g, "...")
      .replace(/[\u00A0\u202F]/g, " ")
      .replace(/[^\n\x20-\x7E\xA1-\xFF]/gu, "?")
      .trim();
  }

  function buildResultsPdf(JsPDF) {
    const spot = state.spot.result;
    const dig = state.dig.result;
    const test = state.test.result;

    const doc = new JsPDF({ unit: "mm", format: "a4" });
    const PAGE_H = 297;
    const MARGIN = 18;
    const WIDTH = 210 - MARGIN * 2;
    const INK = [40, 39, 39];
    const AMETHYST = [158, 97, 164];
    const MUTED = [95, 95, 95];
    let y = MARGIN;

    const ensureRoom = (height) => {
      if (y + height > PAGE_H - MARGIN) {
        doc.addPage();
        y = MARGIN;
      }
    };

    // Writes wrapped text. `bullet` draws a hanging bullet; `link` makes
    // every line of the text a clickable link to that URL.
    const write = (text, { size = 10.5, style = "normal", color = INK, indent = 0, gap = 1.6, bullet = false, link } = {}) => {
      const clean = pdfSafe(text);
      if (!clean) return;
      doc.setFont("helvetica", style);
      doc.setFontSize(size);
      doc.setTextColor(...color);
      const textIndent = indent + (bullet ? 4 : 0);
      const lineHeight = size * 0.45;
      doc.splitTextToSize(clean, WIDTH - textIndent).forEach((line, i) => {
        ensureRoom(lineHeight);
        y += lineHeight;
        if (bullet && i === 0) doc.text("-", MARGIN + indent, y);
        if (link) doc.textWithLink(line, MARGIN + textIndent, y, { url: link });
        else doc.text(line, MARGIN + textIndent, y);
      });
      y += gap;
    };
    const heading = (text) => {
      ensureRoom(16);
      y += 5;
      write(text, { size: 14, style: "bold", color: AMETHYST, gap: 2 });
    };
    const subheading = (text) => {
      ensureRoom(10);
      y += 1.5;
      write(text, { size: 11, style: "bold", gap: 1 });
    };

    // Title
    write("Spot the Opportunity", { size: 20, style: "bold", gap: 1 });
    write(
      `Your results · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} · UEL Careers and Student Enterprise`,
      { size: 9.5, color: MUTED, gap: 2 }
    );

    // 1. Spot
    heading("1. Spot: your problem statement");
    write(spot.statement, { size: 11.5, style: "bold", gap: 2 });
    [["Who", spot.who], ["What", spot.what], ["When", spot.when], ["How", spot.how], ["Why", spot.why]].forEach(([label, value]) =>
      write(`${label}: ${value}`)
    );

    // 2. Dig
    heading("2. Dig: your Five Whys");
    write(
      hintLog.length
        ? `Hints used: ${hintLog.length} of ${MAX_HINTS}. Each one is marked under the Why it was asked for.`
        : "Hints used: none.",
      { size: 9.5, style: "italic", color: MUTED, gap: 2 }
    );
    state.dig.whys.forEach((answer, i) => {
      write(`Why ${i + 1}: ${answer}`, { gap: 1 });
      hintLog
        .filter((h) => h.why === i + 1)
        .forEach((h) =>
          write(`[Hint used] Question: ${h.nudge} Suggested answer: ${h.suggested_answer}`, {
            size: 9,
            style: "italic",
            color: AMETHYST,
            indent: 6,
            gap: 1,
          })
        );
      y += 0.8;
    });
    subheading("Root cause your chain arrives at");
    write(dig.root_cause);
    dig.feedback.forEach((f) => write(f, { bullet: true, gap: 1 }));
    if (dig.deeper_prompt && dig.deeper_prompt.trim()) write(`Push further: ${dig.deeper_prompt}`, { style: "italic" });

    // 3. Test
    heading("3. Test: what real people say");
    write(formatVerdictLine(test), { style: "bold", gap: 2 });
    if (test.verdict !== "insufficient" && Math.abs(test.score - (test.migraine_threshold ?? 60)) <= BORDERLINE_MARGIN) {
      write("This score is close to the line between a headache and a migraine. Results can move a few points between runs.", {
        size: 9.5,
        style: "italic",
        color: MUTED,
      });
    }
    if (test.verdict === "insufficient") {
      write(
        "We couldn't find many people describing this online. That's common for specialist audiences. It means you need to talk to 5 of them, not that the problem is weak."
      );
      if (test.talk_to.length) {
        subheading("Who to talk to, and where to find them");
        test.talk_to.forEach((t) => write(`${t.who}${t.where ? ` - ${t.where}` : ""}`, { bullet: true, gap: 1 }));
      }
    }
    if (test.sharpening_advice.length) {
      subheading("Sharpening advice");
      test.sharpening_advice.forEach((a) => write(a, { bullet: true, gap: 1 }));
    }

    subheading("Root cause check");
    const comparison = test.root_cause_comparison;
    write(`${capitalize(comparison.verdict)}${comparison.evidence_suggests ? `: ${comparison.evidence_suggests}` : ""}`);
    write(comparison.explanation);

    if (test.pain_points.length) {
      subheading("What real people are saying");
      test.pain_points.forEach((pp) => {
        write(pp.category, { style: "bold", gap: 0.5 });
        write(pp.summary, { gap: 0.5 });
        if (pp.frequency) write(`Based on ${pp.frequency}`, { size: 9, style: "italic", color: MUTED });
      });
    }

    subheading("Evidence, by type");
    write('Only "Person with the problem" and "Practitioner / peer" count towards the score.', {
      size: 9,
      style: "italic",
      color: MUTED,
    });
    if (!test.evidence.length) write("No usable evidence was found for this search.");
    EVIDENCE_LABELS.forEach((label) => {
      const group = test.evidence.filter((e) => e.label === label.key);
      if (!group.length) return;
      write(`${label.name} (${group.length})`, { style: "bold", gap: 1 });
      group.forEach((e) => {
        write(`"${e.quote}"`, { style: "italic", indent: 4, gap: 0.5 });
        write(`${e.source || "Source"}: ${e.url}`, { size: 8.5, color: AMETHYST, indent: 4, gap: 1.8, link: e.url });
      });
    });

    if (test.cost_summary && test.cost_summary.trim()) {
      subheading("Why it matters");
      write(test.cost_summary);
    }
    if (test.priority_ranking.length) {
      subheading("Priority ranking");
      test.priority_ranking.forEach((r, i) => write(`${i + 1}. ${r.pain_point} - ${r.rationale}`, { gap: 1 }));
    }
    if (test.evidence_note && test.evidence_note.trim()) {
      subheading("About this search");
      write(test.evidence_note, { size: 9.5 });
    }
    const looked = (test.sources || []).filter((r) => r.status !== "not_selected");
    if (looked.length) {
      subheading("Where we looked");
      looked.forEach((r) => write(`${r.label}: ${(SOURCE_STATUS_TEXT[r.status] || (() => r.status))(r)}`, { size: 9.5, bullet: true, gap: 0.8 }));
    }

    // 4. Judge
    heading("4. Judge: your conclusion");
    write(judgeConclusion.value.trim() || "(No conclusion written yet.)");

    // Page numbers
    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page++) {
      doc.setPage(page);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...MUTED);
      doc.text(`Spot the Opportunity · page ${page} of ${pages}`, MARGIN, PAGE_H - 10);
    }

    return doc;
  }

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

    summaryEl.appendChild(buildSummarySection("Evidence and verdict", [formatVerdictLine(test)]));

    if (!judgeConclusionTouched) {
      judgeConclusion.value =
        test.verdict === "insufficient"
          ? "We don't have enough evidence to judge this problem yet. To get it, we will talk to..."
          : `We believe this problem is a ${test.verdict} because...`;
    }
  }

  function formatVerdictLine(test) {
    if (test.verdict === "insufficient") {
      return `Not enough evidence to score: this could be a headache, but we can't tell yet (${test.counts.person} first-hand ${
        test.counts.person === 1 ? "account" : "accounts"
      } found; at least ${test.min_person_items} needed). Get more evidence, starting with interviews. ${test.reasoning}`.trim();
    }
    return `${verdictWord(test.verdict)} (${test.score}/100) — ${test.reasoning}`;
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
      lines.push(`-- ${pp.category} --`, pp.summary, `Based on: ${pp.frequency}`, "");
    });

    EVIDENCE_LABELS.forEach((label) => {
      const group = test.evidence.filter((e) => e.label === label.key);
      if (!group.length) return;
      lines.push(`-- ${label.name} --`);
      group.forEach((e) => lines.push(`"${e.quote}" — ${e.source || ""} (${e.url})`));
      lines.push("");
    });

    if (test.cost_summary) lines.push(`Why it matters: ${test.cost_summary}`, "");

    lines.push(
      `Root cause check: ${test.root_cause_comparison.verdict} — ${test.root_cause_comparison.explanation}`,
      "",
      `Verdict: ${formatVerdictLine(test)}`
    );

    if (test.verdict === "insufficient" && test.talk_to.length) {
      lines.push("", "Who to talk to:", ...test.talk_to.map((t) => `· ${t.who}${t.where ? ` — ${t.where}` : ""}`));
    }

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
    document.querySelectorAll(".nudge-btn").forEach((b) => {
      b.setAttribute("aria-expanded", "false");
      b.textContent = "Need a nudge?";
    });
    document.querySelectorAll(".nudge-panel").forEach((p) => {
      p.hidden = true;
      p.textContent = "";
    });
    resetHints();
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
