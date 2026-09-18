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

// ---- Helper to call backend ----
async function callApi(endpoint, payload) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data.result;
}

// ---- Write Code ----
const writeBtn = document.getElementById("write-btn");
const writeLoading = document.getElementById("write-loading");
const writeOutput = document.getElementById("write-output");

writeBtn.addEventListener("click", async () => {
  const description = document.getElementById("write-description").value.trim();
  const language = document.getElementById("write-language").value;
  if (!description) { alert("Please describe what code you want first."); return; }

  writeBtn.disabled = true;
  writeOutput.classList.add("hidden");
  writeLoading.classList.remove("hidden");

  try {
    const result = await callApi("/api/write", { description, language });
    writeOutput.textContent = result;
    writeOutput.classList.remove("hidden");
  } catch (err) {
    writeOutput.textContent = "Error: " + err.message;
    writeOutput.classList.remove("hidden");
  } finally {
    writeLoading.classList.add("hidden");
    writeBtn.disabled = false;
  }
});

// ---- Debug Code ----
const debugBtn = document.getElementById("debug-btn");
const debugLoading = document.getElementById("debug-loading");
const debugOutput = document.getElementById("debug-output");

debugBtn.addEventListener("click", async () => {
  const code = document.getElementById("debug-code").value.trim();
  const errorMessage = document.getElementById("debug-error").value.trim();
  const language = document.getElementById("debug-language").value;
  if (!code) { alert("Please paste some code to debug first."); return; }

  debugBtn.disabled = true;
  debugOutput.classList.add("hidden");
  debugLoading.classList.remove("hidden");

  try {
    const result = await callApi("/api/debug", { code, error_message: errorMessage, language });
    debugOutput.textContent = result;
    debugOutput.classList.remove("hidden");
  } catch (err) {
    debugOutput.textContent = "Error: " + err.message;
    debugOutput.classList.remove("hidden");
  } finally {
    debugLoading.classList.add("hidden");
    debugBtn.disabled = false;
  }
});