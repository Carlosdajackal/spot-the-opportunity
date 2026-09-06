// Spot the Opportunity — client-side only. No secrets live here; every
// generation request goes to this site's own /api/sharpen endpoint.

(function () {
  "use strict";

  const form = document.getElementById("sharpen-form");
  const problemField = document.getElementById("problem");
  const ideaField = document.getElementById("idea");
  const submitBtn = document.getElementById("submit-btn");
  const submitLabel = submitBtn.querySelector(".btn-label");

  const resultSection = document.getElementById("result");
  const resultStatement = document.getElementById("result-statement");
  const resultWho = document.getElementById("result-who");
  const resultWhat = document.getElementById("result-what");
  const resultWhen = document.getElementById("result-when");
  const resultHow = document.getElementById("result-how");
  const resultWhy = document.getElementById("result-why");
  const resultAssumptions = document.getElementById("result-assumptions");

  const copyBtn = document.getElementById("copy-btn");
  const retryBtn = document.getElementById("retry-btn");
  const resetBtn = document.getElementById("reset-btn");

  const statusMessage = document.getElementById("status-message");

  const SUBMIT_IDLE_LABEL = "Sharpen my problem statement";
  const SUBMIT_LOADING_LABEL = "Bringing it into focus";

  let lastInputs = null;
  let lastResult = null;

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

  // ---------- Form submit ----------
  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const problem = problemField.value.trim();
    const idea = ideaField.value.trim();

    if (!problem || !idea) {
      showStatus("Please fill in both fields.");
      return;
    }

    lastInputs = { problem, idea };
    generate(lastInputs, { loadingTarget: submitBtn, loadingLabelEl: submitLabel });
  });

  retryBtn.addEventListener("click", () => {
    if (!lastInputs) return;
    const originalLabel = retryBtn.textContent;
    generate(lastInputs, {
      loadingTarget: retryBtn,
      loadingLabelEl: retryBtn,
      loadingText: SUBMIT_LOADING_LABEL,
      restoreLabel: originalLabel,
    });
  });

  resetBtn.addEventListener("click", () => {
    stopListening();
    form.reset();
    lastInputs = null;
    lastResult = null;
    hideStatus();
    resultSection.hidden = true;
    form.hidden = false;
    problemField.focus();
  });

  copyBtn.addEventListener("click", async () => {
    if (!lastResult) return;
    const text = formatResultAsText(lastResult);
    try {
      await navigator.clipboard.writeText(text);
      flashCopyFeedback();
    } catch {
      showStatus("Couldn't copy automatically — please select and copy the text manually.");
    }
  });

  function flashCopyFeedback() {
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied";
    setTimeout(() => {
      copyBtn.textContent = original;
    }, 1500);
  }

  async function generate(inputs, opts) {
    hideStatus();
    setLoading(true, opts);

    try {
      const response = await fetch("/api/sharpen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(inputs),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data || data.error) {
        const message = (data && data.message) || "Something went wrong. Please try again.";
        showStatus(message);
        return;
      }

      lastResult = data;
      renderResult(data);
    } catch {
      showStatus("Couldn't reach the server. Please check your connection and try again.");
    } finally {
      setLoading(false, opts);
    }
  }

  function setLoading(isLoading, opts) {
    const { loadingTarget, loadingLabelEl, loadingText, restoreLabel } = opts;

    loadingTarget.disabled = isLoading;

    if (loadingTarget === submitBtn) {
      submitBtn.classList.toggle("is-loading", isLoading);
      submitLabel.textContent = isLoading ? SUBMIT_LOADING_LABEL : SUBMIT_IDLE_LABEL;
    } else if (loadingLabelEl) {
      loadingLabelEl.textContent = isLoading ? loadingText : restoreLabel;
    }
  }

  function renderResult(data) {
    resultStatement.textContent = data.statement;
    resultWho.textContent = data.who;
    resultWhat.textContent = data.what;
    resultWhen.textContent = data.when;
    resultHow.textContent = data.how;
    resultWhy.textContent = data.why;

    if (data.assumptions && data.assumptions.trim()) {
      resultAssumptions.textContent = "Where we had to guess: " + data.assumptions.trim();
      resultAssumptions.hidden = false;
    } else {
      resultAssumptions.hidden = true;
    }

    form.hidden = true;
    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }

  function formatResultAsText(data) {
    let text =
      `Problem statement: ${data.statement}\n\n` +
      `Who: ${data.who}\n` +
      `What: ${data.what}\n` +
      `When: ${data.when}\n` +
      `How: ${data.how}\n` +
      `Why: ${data.why}`;

    if (data.assumptions && data.assumptions.trim()) {
      text += `\n\nWhere we had to guess: ${data.assumptions.trim()}`;
    }

    return text;
  }

  function showStatus(message) {
    statusMessage.textContent = message;
    statusMessage.hidden = false;
  }

  function hideStatus() {
    statusMessage.hidden = true;
    statusMessage.textContent = "";
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
})();
