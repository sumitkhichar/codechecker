const tabBtns = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabBtns.forEach((b) => b.classList.remove("active"));
    tabPanels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

// ---- Voice Input (Web Speech API) ----
const voiceStatus = document.getElementById("voice-status");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition      = null;   // shared recognition instance
let activeBtn        = null;   // mic button currently recording
let activeTarget     = null;   // textarea being filled
let micStream        = null;   // MediaStream kept alive during session
let voiceStatusTimer = null;

function setVoiceStatus(type, message, autohide = true) {
  clearTimeout(voiceStatusTimer);
  voiceStatus.textContent = message;
  voiceStatus.className   = `voice-status ${type}`;
  voiceStatus.classList.remove("hidden");
  if (autohide && (type === "success" || type === "error")) {
    voiceStatusTimer = setTimeout(() => {
      voiceStatus.className = "voice-status hidden";
    }, 4500);
  }
}

function releaseMicStream() {
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
}

function stopListening() {
  if (recognition) { try { recognition.stop(); } catch (_) {} }
  releaseMicStream();
  if (activeBtn) {
    activeBtn.classList.remove("listening");
    activeBtn.textContent = "🎤";
    activeBtn.disabled    = false;
    activeBtn = null;
  }
  activeTarget = null;
}

function startRecognition(textarea, btn) {
  recognition = new SpeechRecognition();
  recognition.lang            = "en-US";
  recognition.interimResults  = false;
  recognition.maxAlternatives = 1;

  activeBtn    = btn;
  activeTarget = textarea;

  btn.classList.add("listening");
  btn.textContent = "⏹";
  btn.disabled    = false;  // keep tappable so user can cancel

  setVoiceStatus("listening", "🎙 Listening… speak now.", false);

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    const current    = activeTarget.value.trim();
    activeTarget.value = current ? current + " " + transcript : transcript;
    activeTarget.dispatchEvent(new Event("input", { bubbles: true }));
    setVoiceStatus("success",
      `✅ Got it: "${transcript.slice(0, 70)}${transcript.length > 70 ? "…" : ""}"`);
  };

  recognition.onerror = (event) => {
    const messages = {
      "no-speech":
        "😶 No speech detected — tap again and speak clearly.",
      "audio-capture":
        "🎙 Mic unavailable. Go to Windows Settings → Privacy → Microphone and allow your browser.",
      "not-allowed":
        "🔒 Permission denied — click the 🔒 icon in the address bar, allow Microphone, then retry.",
      "aborted":
        "⏹ Recording cancelled.",
      "network":
        "🌐 Speech service needs an internet connection.",
      "service-not-allowed":
        "🔒 Speech service requires HTTPS. Open via https:// or use localhost.",
    };
    setVoiceStatus("error", messages[event.error] || `❌ ${event.error}`);
  };

  recognition.onend = () => { stopListening(); };

  recognition.start();
}

if (!SpeechRecognition) {
  // Browser doesn't support speech API — hide all mic buttons silently
  document.querySelectorAll(".mic-btn").forEach(btn => btn.style.display = "none");
} else {
  document.querySelectorAll(".mic-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const textarea = document.getElementById(btn.dataset.target);
      if (!textarea) return;

      // Tap the active button again → cancel recording
      if (activeBtn === btn) {
        stopListening();
        setVoiceStatus("error", "⏹ Recording stopped.");
        return;
      }
      // Another button was active → stop it first
      if (activeBtn) stopListening();

      // ── Permission pre-flight via getUserMedia ────────────────────
      // Calling getUserMedia first triggers the browser's permission
      // dialog properly and hands the mic device to the speech API
      // cleanly — preventing the audio-capture error.
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setVoiceStatus("error",
          "🎙 Your browser doesn't support mic access. Use Chrome on desktop or Android.");
        return;
      }

      setVoiceStatus("listening", "🔐 Requesting microphone access…", false);

      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        releaseMicStream();
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          setVoiceStatus("error",
            "🔒 Mic access denied — click 🔒 in the address bar → allow Microphone → refresh.");
        } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
          setVoiceStatus("error",
            "🎙 No microphone found — plug one in, then check Windows Settings → Privacy → Microphone.");
        } else {
          setVoiceStatus("error", `❌ Mic error: ${err.message}`);
        }
        return;
      }

      // Permission granted → start speech recognition
      // (keep micStream open so the device isn't released between steps)
      startRecognition(textarea, btn);
    });
  });
}

// ---- Toast Notification System ----
const toastContainer = document.getElementById("toast-container");

function showToast(message, type = "error") {
  if (!toastContainer) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  const iconMap = {
    error: "❌",
    success: "✅",
    info: "ℹ️",
    warning: "⚠️",
  };

  toast.innerHTML = `
    <div class="toast-content">
      <span class="toast-icon">${iconMap[type] || "ℹ️"}</span>
      <span class="toast-text">${message}</span>
    </div>
    <button type="button" class="toast-close-btn" title="Dismiss">&times;</button>
  `;

  const closeBtn = toast.querySelector(".toast-close-btn");
  let dismissed = false;

  const dismissToast = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.add("hiding");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  };

  closeBtn.addEventListener("click", dismissToast);
  toast.addEventListener("click", (e) => {
    if (e.target !== closeBtn) dismissToast();
  });

  toastContainer.appendChild(toast);
  setTimeout(dismissToast, 3800);
}

function handleApiError(err) {
  if (!err) {
    showToast("Something went wrong, please try again", "error");
    return;
  }
  const msg = err.message || String(err);
  const lower = msg.toLowerCase();

  if (err.name === "AbortError" || lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
    showToast("Request timed out, try again", "error");
  } else if (lower.includes("401") || lower.includes("403") || lower.includes("api key") || lower.includes("unauthorized")) {
    showToast("Invalid API key — check your settings", "error");
  } else {
    showToast(msg || "Something went wrong", "error");
  }
}

// ---- Inline Input Validation Helpers ----
function showFieldError(fieldEl, errorEl, message) {
  if (!fieldEl) return;
  fieldEl.classList.add("input-error");
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }
  fieldEl.focus();

  const clearOnInput = () => {
    clearFieldError(fieldEl, errorEl);
    fieldEl.removeEventListener("input", clearOnInput);
    fieldEl.removeEventListener("change", clearOnInput);
  };
  fieldEl.addEventListener("input", clearOnInput);
  fieldEl.addEventListener("change", clearOnInput);
}

function clearFieldError(fieldEl, errorEl) {
  if (fieldEl) fieldEl.classList.remove("input-error");
  if (errorEl) {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }
}

// ---- API Call with 25s Timeout via AbortController ----
async function callApi(endpoint, payload, timeoutMs = 25000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    if (!res.ok) {
      const error = new Error(data.error || "Something went wrong.");
      error.status = res.status;
      throw error;
    }
    return data.result !== undefined ? data.result : data;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ---- Markdown, Math (KaTeX), & Syntax Highlighting (Prism) Pipeline ----
function addCopyButtons(container) {
  const preElements = container.querySelectorAll("pre");
  preElements.forEach((pre) => {
    if (pre.querySelector(".copy-code-btn")) return;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-code-btn";
    copyBtn.textContent = "Copy";
    copyBtn.title = "Copy code to clipboard";

    copyBtn.addEventListener("click", async () => {
      const codeEl = pre.querySelector("code");
      const textToCopy = codeEl ? codeEl.innerText : pre.innerText;
      try {
        await navigator.clipboard.writeText(textToCopy);
        copyBtn.textContent = "Copied!";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("copied");
        }, 2000);
      } catch (_) {
        copyBtn.textContent = "Failed";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
      }
    });

    pre.style.position = "relative";
    pre.appendChild(copyBtn);
  });
}

function renderContent(container, markdownText) {
  if (!markdownText) {
    container.innerHTML = "";
    return;
  }

  // 1. Markdown parsing with marked.js
  let html = markdownText;
  if (window.marked && typeof window.marked.parse === "function") {
    html = window.marked.parse(markdownText);
  }
  container.innerHTML = html;

  // 2. Math rendering with KaTeX (delimiters: $$, $, \(, \[)
  if (typeof window.renderMathInElement === "function") {
    try {
      window.renderMathInElement(container, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      });
    } catch (e) {
      console.warn("KaTeX render error:", e);
    }
  }

  // 3. Syntax highlighting with Prism.js
  if (window.Prism && typeof window.Prism.highlightAllUnder === "function") {
    try {
      window.Prism.highlightAllUnder(container);
    } catch (e) {
      console.warn("Prism highlight error:", e);
    }
  }

  // 4. Attach copy code buttons to all code blocks
  addCopyButtons(container);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const commaIndex = result.indexOf(",");
      const base64Data = commaIndex !== -1 ? result.slice(commaIndex + 1) : result;
      resolve({
        mime_type: file.type || "image/jpeg",
        data: base64Data,
      });
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ---- Write Code ----
let writeImageFile = null;
const writeBtn = document.getElementById("write-btn");
const writeLoading = document.getElementById("write-loading");
const writeOutput = document.getElementById("write-output");
const writeUploadBtn = document.getElementById("write-upload-btn");
const writeImageInput = document.getElementById("write-image-input");
const writeImagePreview = document.getElementById("write-image-preview");
const writePreviewImg = document.getElementById("write-preview-img");
const writePreviewName = document.getElementById("write-preview-name");
const writePreviewSize = document.getElementById("write-preview-size");
const writeRemoveImgBtn = document.getElementById("write-remove-img-btn");

writeUploadBtn.addEventListener("click", () => writeImageInput.click());

writeImageInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  writeImageFile = file;
  writePreviewImg.src = URL.createObjectURL(file);
  writePreviewName.textContent = file.name;
  writePreviewSize.textContent = formatFileSize(file.size);
  writeImagePreview.classList.remove("hidden");
});

writeRemoveImgBtn.addEventListener("click", () => {
  writeImageFile = null;
  writeImageInput.value = "";
  writePreviewImg.src = "";
  writeImagePreview.classList.add("hidden");
});

writeBtn.addEventListener("click", async () => {
  const writeDescEl = document.getElementById("write-description");
  const writeErrorEl = document.getElementById("write-error-msg");
  const description = writeDescEl.value.trim();
  const language = document.getElementById("write-language").value;

  if (!description && !writeImageFile) {
    showFieldError(writeDescEl, writeErrorEl, "Please describe the code you want or upload an image first.");
    return;
  }
  clearFieldError(writeDescEl, writeErrorEl);

  writeBtn.disabled = true;
  writeOutput.classList.add("hidden");
  writeLoading.classList.remove("hidden");

  try {
    let imageData = null;
    if (writeImageFile) {
      imageData = await fileToBase64(writeImageFile);
    }
    const payload = { description, language, image_data: imageData };
    const result = await callApi("/api/write", payload);
    renderContent(writeOutput, result);
    writeOutput.classList.remove("hidden");
  } catch (err) {
    handleApiError(err);
  } finally {
    writeLoading.classList.add("hidden");
    writeBtn.disabled = false;
  }
});

// ---- Debug Code ----
let debugImageFile = null;
const debugBtn = document.getElementById("debug-btn");
const debugLoading = document.getElementById("debug-loading");
const debugOutput = document.getElementById("debug-output");
const debugCode = document.getElementById("debug-code");
const debugLanguage = document.getElementById("debug-language");
const detectedBadge = document.getElementById("detected-badge");
const debugUploadBtn = document.getElementById("debug-upload-btn");
const debugImageInput = document.getElementById("debug-image-input");
const debugImagePreview = document.getElementById("debug-image-preview");
const debugPreviewImg = document.getElementById("debug-preview-img");
const debugPreviewName = document.getElementById("debug-preview-name");
const debugPreviewSize = document.getElementById("debug-preview-size");
const debugRemoveImgBtn = document.getElementById("debug-remove-img-btn");

debugUploadBtn.addEventListener("click", () => debugImageInput.click());

debugImageInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  debugImageFile = file;
  debugPreviewImg.src = URL.createObjectURL(file);
  debugPreviewName.textContent = file.name;
  debugPreviewSize.textContent = formatFileSize(file.size);
  debugImagePreview.classList.remove("hidden");
});

debugRemoveImgBtn.addEventListener("click", () => {
  debugImageFile = null;
  debugImageInput.value = "";
  debugPreviewImg.src = "";
  debugImagePreview.classList.add("hidden");
});

// Keyword-based language detection
function detectLanguageFromKeywords(code) {
  if (!code || !code.trim()) return "auto";

  const scores = {
    python: 0,
    javascript: 0,
    typescript: 0,
    java: 0,
    cpp: 0,
    c: 0,
    go: 0,
    sql: 0,
    html: 0,
  };

  // Python keywords
  if (/\b(def\s+\w+|elif\b|from\s+[\w.]+\s+import|import\s+[\w.]+|self\b|__init__|print\s*\(|lambda\b|except\s*(\w+)?\:|finally\:|in\s+range\(|pass\b|yield\b)\b/.test(code)) scores.python += 5;
  if (/\b(None|True|False)\b/.test(code)) scores.python += 3;
  if (/#.*$/.test(code) && !/(\/\*|\/\/)/.test(code)) scores.python += 2;
  if (/:[ \t]*(\r?\n|$)/.test(code)) scores.python += 2;

  // TypeScript (check before JS for type syntax)
  if (/\b(interface\s+[A-Z]\w*|type\s+[A-Z]\w*\s*=|:\s*(string|number|boolean|any|void|unknown)\b|<[A-Z]\w*>\s*\(|as\s+const\b)/.test(code)) scores.typescript += 6;

  // JavaScript
  if (/\b(console\.log|const\s+\w+|let\s+\w+|var\s+\w+|function\s*\(|function\s+\w+|=>|document\.|window\.|localStorage|===|!==|JSON\.)\b/.test(code)) scores.javascript += 4;
  if (/\b(async\s+function|await\s+\w+|Promise\b|setTimeout|require\(|module\.exports|export\s+default)\b/.test(code)) {
    scores.javascript += 3;
    scores.typescript += 2;
  }

  // Java
  if (/\b(System\.out\.print(ln)?|public\s+class|public\s+static\s+void\s+main|String\[\]\s+args|private\s+\w+|protected\s+\w+|@Override|extends\s+\w+|implements\s+\w+)\b/.test(code)) scores.java += 6;
  if (/\b(new\s+[A-Z]\w*\s*\(|throws\s+\w+Exception|boolean\s+\w+|int\s+\w+|double\s+\w+)\b/.test(code)) scores.java += 3;

  // C++
  if (/#include\s*<iostream>|std::|cout\s*<<|cin\s*>>|nullptr|vector<|unordered_map</.test(code)) scores.cpp += 6;
  if (/#include\s*<[a-z]+>/.test(code)) scores.cpp += 3;

  // C
  if (/#include\s*<stdio\.h>|#include\s*<stdlib\.h>|printf\s*\(|scanf\s*\(|malloc\s*\(|free\s*\(|size_t\b/.test(code)) scores.c += 6;

  // Go
  if (/\b(package\s+main|func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\(|fmt\.Print(ln|f)?|import\s*\(\s*"fmt"|go\s+\w+\(|make\(chan\s+|chan\s+\w+|goroutine)\b|:=/.test(code)) scores.go += 6;

  // SQL
  if (/\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|WHERE\s+|GROUP\s+BY|ORDER\s+BY|INNER\s+JOIN|LEFT\s+JOIN)\b/i.test(code)) scores.sql += 6;

  // HTML / CSS
  if (/<(!DOCTYPE\s+html|html|head|body|div|span|p|a|script|style)\b/i.test(code)) scores.html += 6;

  let bestLang = "auto";
  let maxScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      bestLang = lang;
    }
  }

  return maxScore >= 2 ? bestLang : "auto";
}

function updateDetectedLanguage() {
  const code = debugCode.value;
  const detected = detectLanguageFromKeywords(code);

  const displayNames = {
    python: "Python",
    javascript: "JavaScript",
    typescript: "TypeScript",
    java: "Java",
    cpp: "C++",
    c: "C",
    go: "Go",
    sql: "SQL",
    html: "HTML/CSS",
    auto: "Auto-detect",
  };

  if (detected !== "auto" && debugLanguage) {
    debugLanguage.value = detected;
    if (detectedBadge) {
      detectedBadge.textContent = `✨ Auto-selected: ${displayNames[detected] || detected}`;
      detectedBadge.style.background = "rgba(46, 204, 113, 0.2)";
      detectedBadge.style.color = "#2ecc71";
      detectedBadge.style.borderColor = "rgba(46, 204, 113, 0.4)";
    }
  } else {
    if (debugLanguage) debugLanguage.value = "auto";
    if (detectedBadge) {
      detectedBadge.textContent = "🤖 Auto-detecting from code keywords...";
      detectedBadge.style.background = "rgba(108, 92, 231, 0.18)";
      detectedBadge.style.color = "#a29bfe";
      detectedBadge.style.borderColor = "rgba(108, 92, 231, 0.45)";
    }
  }
}

// Auto-detect when code is pasted or typed
debugCode.addEventListener("input", updateDetectedLanguage);
debugCode.addEventListener("paste", () => setTimeout(updateDetectedLanguage, 10));

debugBtn.addEventListener("click", async () => {
  const debugErrorEl = document.getElementById("debug-error-msg");
  const code = debugCode.value.trim();
  const errorMessage = document.getElementById("debug-error").value.trim();
  const language = debugLanguage.value;

  if (!code && !debugImageFile) {
    showFieldError(debugCode, debugErrorEl, "Please paste your code or upload a photo of the code to debug.");
    return;
  }
  clearFieldError(debugCode, debugErrorEl);

  debugBtn.disabled = true;
  debugOutput.classList.add("hidden");
  debugLoading.classList.remove("hidden");

  try {
    let imageData = null;
    if (debugImageFile) {
      imageData = await fileToBase64(debugImageFile);
    }
    const payload = {
      code,
      error_message: errorMessage,
      language,
      image_data: imageData,
    };
    const result = await callApi("/api/debug", payload);
    renderContent(debugOutput, result);
    debugOutput.classList.remove("hidden");
  } catch (err) {
    handleApiError(err);
  } finally {
    debugLoading.classList.add("hidden");
    debugBtn.disabled = false;
  }
});

// ---- Explain Tab ----
const explainTopicSelect = document.getElementById("explain-topic-select");
const explainCustomWrap  = document.getElementById("explain-custom-wrap");
const explainTopicCustom = document.getElementById("explain-topic-custom");
const explainBtn         = document.getElementById("explain-btn");
const explainLoading     = document.getElementById("explain-loading");
const explainOutput      = document.getElementById("explain-output");

// Show/hide free-text field when user picks "✏️ Type my own topic…"
explainTopicSelect.addEventListener("change", () => {
  if (explainTopicSelect.value === "__custom__") {
    explainCustomWrap.classList.remove("hidden");
    explainTopicCustom.focus();
  } else {
    explainCustomWrap.classList.add("hidden");
  }
});

explainBtn.addEventListener("click", async () => {
  const explainErrorEl = document.getElementById("explain-error-msg");
  let topic = "";
  if (explainTopicSelect.value === "__custom__") {
    topic = explainTopicCustom.value.trim();
    if (!topic) {
      showFieldError(explainTopicCustom, explainErrorEl, "Please type the topic you want explained.");
      return;
    }
  } else if (explainTopicSelect.value) {
    topic = explainTopicSelect.value;
  }

  if (!topic) {
    showFieldError(explainTopicSelect, explainErrorEl, "Please choose a topic from the dropdown or type your own.");
    return;
  }
  clearFieldError(explainTopicSelect, explainErrorEl);
  clearFieldError(explainTopicCustom, explainErrorEl);

  const depth    = document.querySelector("input[name='explain-depth']:checked").value;
  const language = document.getElementById("explain-language").value;

  explainBtn.disabled = true;
  explainOutput.classList.add("hidden");
  explainLoading.classList.remove("hidden");

  try {
    const result = await callApi("/api/explain", { topic, depth, language });
    renderContent(explainOutput, result);
    explainOutput.classList.remove("hidden");
  } catch (err) {
    handleApiError(err);
  } finally {
    explainLoading.classList.add("hidden");
    explainBtn.disabled = false;
  }
});

// ---- LeetCode Tab ----
const lcNumberInput       = document.getElementById("lc-number");
const lcNumberErrorEl     = document.getElementById("lc-number-error-msg");
const lcFetchBtn          = document.getElementById("lc-fetch-btn");
const lcFetchLoading      = document.getElementById("lc-fetch-loading");
const lcFetchError        = document.getElementById("lc-fetch-error");

const lcCard              = document.getElementById("lc-card");
const lcNumberBadge       = document.getElementById("lc-number-badge");
const lcTitle             = document.getElementById("lc-title");
const lcDifficulty        = document.getElementById("lc-difficulty");
const lcLink              = document.getElementById("lc-link");
const lcStatement         = document.getElementById("lc-statement");

const lcHintsSection      = document.getElementById("lc-hints-section");
const lcHintBtn           = document.getElementById("lc-hint-btn");
const lcHintCounter       = document.getElementById("lc-hint-counter");
const lcHintText          = document.getElementById("lc-hint-text");

const lcTemplateSection   = document.getElementById("lc-template-section");
const lcCopyTemplate      = document.getElementById("lc-copy-template");
const lcTemplate          = document.getElementById("lc-template");

const lcApproachSection   = document.getElementById("lc-approach-section");
const lcApproach          = document.getElementById("lc-approach");
const lcApproachErrorEl   = document.getElementById("lc-approach-error-msg");
const lcReviewBtn         = document.getElementById("lc-review-btn");
const lcReviewLoading     = document.getElementById("lc-review-loading");
const lcReviewOutput      = document.getElementById("lc-review-output");

// Runner elements
const lcRunnerSection     = document.getElementById("lc-runner-section");
const lcCodeEditor        = document.getElementById("lc-code-editor");
const lcCodeErrorEl       = document.getElementById("lc-code-error-msg");
const lcRunBtn            = document.getElementById("lc-run-btn");
const lcResetCodeBtn      = document.getElementById("lc-reset-code-btn");
const lcRunLoading        = document.getElementById("lc-run-loading");
const lcTestResults       = document.getElementById("lc-test-results");
const testSummaryBadge    = document.getElementById("test-summary-badge");
const testRuntimeLabel    = document.getElementById("test-runtime-label");
const testCasesList       = document.getElementById("test-cases-list");
const testStdout          = document.getElementById("test-stdout");

let currentProblem = null;
let currentHints   = [];
let currentHintIdx = 0;

async function fetchLeetCodeProblem() {
  const num = parseInt(lcNumberInput.value, 10);
  if (!num || num < 1) {
    showFieldError(lcNumberInput, lcNumberErrorEl, "Please enter a valid problem number (e.g. 1).");
    return;
  }
  clearFieldError(lcNumberInput, lcNumberErrorEl);

  lcFetchBtn.disabled = true;
  lcFetchLoading.classList.remove("hidden");
  lcFetchError.classList.add("hidden");
  lcCard.classList.add("hidden");
  lcApproachSection.classList.add("hidden");
  lcReviewOutput.classList.add("hidden");
  lcRunnerSection.classList.add("hidden");
  lcTestResults.classList.add("hidden");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(`/api/leetcode/${num}`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to load problem.");
    }

    currentProblem = data;

    // Populate problem details
    lcNumberBadge.textContent = `#${data.number}`;
    lcTitle.textContent = data.title;

    const diff = (data.difficulty || "medium").toLowerCase();
    lcDifficulty.textContent = diff;
    lcDifficulty.className = `lc-diff-badge ${diff}`;

    if (data.link) {
      lcLink.href = data.link;
      lcLink.classList.remove("hidden");
    } else {
      lcLink.classList.add("hidden");
    }

    const rawStmt = (data.statement || "No statement available.").trim();
    renderContent(lcStatement, rawStmt);

    // Handle hints
    if (data.hints && data.hints.trim()) {
      currentHints = data.hints.split(/\n+/).map(h => h.trim()).filter(Boolean);
      currentHintIdx = 0;
      if (currentHints.length > 0) {
        lcHintsSection.classList.remove("hidden");
        lcHintCounter.textContent = `(1 of ${currentHints.length})`;
        lcHintText.classList.add("hidden");
        lcHintText.textContent = "";
      } else {
        lcHintsSection.classList.add("hidden");
      }
    } else {
      currentHints = [];
      lcHintsSection.classList.add("hidden");
    }

    // Handle starter template
    const templateCode = (data.template_py && data.template_py.trim()) ? data.template_py : "class Solution:\n    # Write your solution here\n    pass";
    lcTemplateSection.classList.remove("hidden");
    lcTemplate.textContent = templateCode;

    // Pre-populate code editor for runner
    lcCodeEditor.value = templateCode;

    // Show card, approach, and code runner sections
    lcCard.classList.remove("hidden");
    lcApproachSection.classList.remove("hidden");
    lcRunnerSection.classList.remove("hidden");
  } catch (err) {
    clearTimeout(timer);
    handleApiError(err);
    lcFetchError.textContent = err.message;
    lcFetchError.classList.remove("hidden");
  } finally {
    lcFetchLoading.classList.add("hidden");
    lcFetchBtn.disabled = false;
  }
}

// Fetch problem on button click or Enter key in number field
lcFetchBtn.addEventListener("click", fetchLeetCodeProblem);
lcNumberInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    fetchLeetCodeProblem();
  }
});

// Hint button click: reveal hints sequentially
lcHintBtn.addEventListener("click", () => {
  if (currentHints.length === 0) return;

  if (lcHintText.classList.contains("hidden")) {
    // Reveal first hint
    lcHintText.textContent = `Hint 1: ${currentHints[0]}`;
    lcHintText.classList.remove("hidden");
    currentHintIdx = 1;
  } else if (currentHintIdx < currentHints.length) {
    // Append next hint
    currentHintIdx++;
    lcHintText.textContent += `\n\nHint ${currentHintIdx}: ${currentHints[currentHintIdx - 1]}`;
  }

  if (currentHintIdx < currentHints.length) {
    lcHintCounter.textContent = `(${currentHintIdx + 1} of ${currentHints.length})`;
  } else {
    lcHintCounter.textContent = `(all hints shown)`;
  }
});

// Copy template button
lcCopyTemplate.addEventListener("click", async () => {
  const code = lcTemplate.textContent;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    const originalText = lcCopyTemplate.textContent;
    lcCopyTemplate.textContent = "✅ Copied!";
    setTimeout(() => { lcCopyTemplate.textContent = originalText; }, 2000);
  } catch (_) {
    showToast("Could not copy to clipboard.", "warning");
  }
});

// Reset editor to starter template
lcResetCodeBtn.addEventListener("click", () => {
  if (!currentProblem) return;
  const starter = (currentProblem.template_py && currentProblem.template_py.trim())
    ? currentProblem.template_py
    : "class Solution:\n    # Write your solution here\n    pass";
  lcCodeEditor.value = starter;
  clearFieldError(lcCodeEditor, lcCodeErrorEl);
  showToast("Reset code to starter template", "info");
});

// Review approach click
lcReviewBtn.addEventListener("click", async () => {
  const approach = lcApproach.value.trim();
  if (!approach) {
    showFieldError(lcApproach, lcApproachErrorEl, "Please describe your approach first before reviewing.");
    return;
  }
  clearFieldError(lcApproach, lcApproachErrorEl);

  if (!currentProblem) {
    showToast("Please fetch a problem first.", "warning");
    return;
  }

  lcReviewBtn.disabled = true;
  lcReviewOutput.classList.add("hidden");
  lcReviewLoading.classList.remove("hidden");

  try {
    const payload = {
      number: currentProblem.number,
      title: currentProblem.title,
      statement: currentProblem.statement,
      approach: approach,
    };
    const result = await callApi("/api/leetcode/review", payload);
    renderContent(lcReviewOutput, result);
    lcReviewOutput.classList.remove("hidden");
  } catch (err) {
    handleApiError(err);
  } finally {
    lcReviewLoading.classList.add("hidden");
    lcReviewBtn.disabled = false;
  }
});

// Run Python Code against Test Cases
lcRunBtn.addEventListener("click", async () => {
  const code = lcCodeEditor.value.trim();
  if (!code) {
    showFieldError(lcCodeEditor, lcCodeErrorEl, "Please write or paste your Python solution before running.");
    return;
  }
  clearFieldError(lcCodeEditor, lcCodeErrorEl);

  if (!currentProblem) {
    showToast("Please fetch a problem first.", "warning");
    return;
  }

  lcRunBtn.disabled = true;
  lcTestResults.classList.add("hidden");
  lcRunLoading.classList.remove("hidden");

  try {
    const payload = {
      code,
      number: currentProblem.number,
    };
    const resp = await callApi("/api/leetcode/run", payload);

    if (resp.error) {
      showToast(resp.error, "error");
    }

    // Render test summary
    testSummaryBadge.textContent = resp.summary || (resp.all_passed ? "All Test Cases Passed ✅" : "Test Cases Failed ❌");
    testSummaryBadge.className = `test-summary-badge ${resp.all_passed ? "all-passed" : "failed"}`;

    const testCases = resp.test_cases || [];
    let totalRuntime = 0;
    testCases.forEach(tc => { totalRuntime += (tc.runtime_ms || 0); });
    testRuntimeLabel.textContent = testCases.length > 0 ? `Total Runtime: ${totalRuntime.toFixed(2)} ms` : "";

    // Render test cases
    testCasesList.innerHTML = "";
    if (testCases.length === 0 && resp.error) {
      const errCard = document.createElement("div");
      errCard.className = "tc-card failed";
      errCard.innerHTML = `
        <div class="tc-header">
          <span>Execution Message</span>
          <span class="tc-badge failed">Error</span>
        </div>
        <div class="tc-io-val error">${resp.error}</div>
        ${resp.details ? `<pre class="test-stdout">${resp.details}</pre>` : ""}
      `;
      testCasesList.appendChild(errCard);
    } else {
      testCases.forEach((tc, idx) => {
        const card = document.createElement("div");
        card.className = `tc-card ${tc.passed ? "passed" : "failed"}`;
        card.innerHTML = `
          <div class="tc-header">
            <span>Case ${idx + 1}</span>
            <span class="tc-badge ${tc.passed ? "passed" : "failed"}">
              ${tc.passed ? "Passed ✓" : "Failed ✗"} (${tc.runtime_ms !== undefined ? tc.runtime_ms + " ms" : ""})
            </span>
          </div>
          ${tc.input ? `<div class="tc-io-row"><span class="tc-io-label">Input:</span><span class="tc-io-val">${tc.input}</span></div>` : ""}
          ${tc.expected ? `<div class="tc-io-row"><span class="tc-io-label">Expected:</span><span class="tc-io-val">${tc.expected}</span></div>` : ""}
          ${tc.actual !== undefined && tc.actual !== null ? `<div class="tc-io-row"><span class="tc-io-label">Output:</span><span class="tc-io-val">${tc.actual}</span></div>` : ""}
          ${tc.error ? `<div class="tc-io-row"><span class="tc-io-label">Error:</span><span class="tc-io-val error">${tc.error}</span></div>` : ""}
        `;
        testCasesList.appendChild(card);
      });
    }

    // Render stdout if any
    if (resp.stdout && resp.stdout.trim()) {
      testStdout.textContent = "Stdout:\n" + resp.stdout;
      testStdout.classList.remove("hidden");
    } else {
      testStdout.classList.add("hidden");
    }

    lcTestResults.classList.remove("hidden");
    lcTestResults.scrollIntoView({ behavior: "smooth", block: "nearest" });

    if (resp.all_passed) {
      showToast("Great job! All test cases passed!", "success");
    } else if (resp.passed_count !== undefined) {
      showToast(`${resp.passed_count} of ${resp.total_count} test cases passed.`, "warning");
    }
  } catch (err) {
    handleApiError(err);
  } finally {
    lcRunLoading.classList.add("hidden");
    lcRunBtn.disabled = false;
  }
});
