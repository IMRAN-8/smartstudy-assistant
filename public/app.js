/* SmartStudy Assistant v2
   Frontend app logic for the new HTML shell.
   Compatible with the current backend:
   - GET  /api/health
   - POST /api/session/topic
   - POST /api/explanation
   - POST /api/assessment
   - POST /api/submit
*/

const API_BASE_URL = "";

let selectedPdf = null;
let loadingInterval = null;
let currentSessionId = null;
let currentTopic = "";
let currentLessonMarkdown = "";
let currentAssessmentId = null;
let currentQuestions = [];

/* =========================
   ELEMENTS
========================= */

const themeButton = document.getElementById("themeButton");
const themeIcon = document.getElementById("themeIcon");
const assistantStatus = document.getElementById("assistantStatus");
const assistantStatusText = document.getElementById("assistantStatusText");
const topicInput = document.getElementById("topicInput");
const pdfInput = document.getElementById("pdfInput");
const uploadBox = document.getElementById("uploadBox");
const fileName = document.getElementById("fileName");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingTitle = document.getElementById("loadingTitle");
const loadingMessage = document.getElementById("loadingMessage");
const toast = document.getElementById("toast");
const lessonSection = document.getElementById("lessonSection");
const examSection = document.getElementById("examSection");
const takeExamButton = document.getElementById("takeExamButton");

/* =========================
   INIT
========================= */

function init() {
  injectExtraStyles();
  initializeTheme();
  bindEvents();
  checkAssistantStatus();
  setTakeExamVisible(false);
}

function bindEvents() {
  themeButton?.addEventListener("click", toggleTheme);

  topicInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") generateLesson();
  });

  pdfInput?.addEventListener("change", handlePdfSelect);

  ["dragenter", "dragover"].forEach((eventName) => {
    uploadBox?.addEventListener(eventName, (event) => {
      event.preventDefault();
      uploadBox.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    uploadBox?.addEventListener(eventName, (event) => {
      event.preventDefault();
      uploadBox.classList.remove("dragging");
    });
  });

  uploadBox?.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!isPdf(file)) {
      showToast("Please drop a PDF file.", "error");
      return;
    }
    selectedPdf = file;
    fileName.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  });
}

/* =========================
   THEME
========================= */

function getSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme) {
  document.body.classList.toggle("light", theme === "light");
  themeIcon.innerHTML = theme === "light"
    ? `
      <circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.8" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    `
    : `
      <path d="M20.2 15.2A8 8 0 0 1 8.8 3.8A8.7 8.7 0 1 0 20.2 15.2Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
    `;
}

function initializeTheme() {
  const savedTheme = localStorage.getItem("ssa-theme");
  applyTheme(savedTheme || getSystemTheme());
}

function toggleTheme() {
  const currentTheme = document.body.classList.contains("light") ? "light" : "dark";
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  localStorage.setItem("ssa-theme", nextTheme);
  applyTheme(nextTheme);
}

/* =========================
   NETWORK / STATUS
========================= */

async function checkAssistantStatus() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`);
    if (!response.ok) throw new Error("Assistant connection failed");
    await response.json();
    assistantStatus.classList.remove("offline");
    assistantStatus.classList.add("online");
    assistantStatusText.textContent = "Assistant online";
  } catch (error) {
    console.error(error);
    assistantStatus.classList.remove("online");
    assistantStatus.classList.add("offline");
    assistantStatusText.textContent = "Assistant offline";
  }
}

async function apiFetch(url, options = {}) {
  const response = await fetch(`${API_BASE_URL}${url}`, options);
  let bodyText = "";
  let json = null;

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    json = await response.json();
  } else {
    bodyText = await response.text();
  }

  if (!response.ok) {
    const message = json?.error || json?.message || bodyText || `Request failed (${response.status})`;
    throw new Error(message);
  }

  return json ?? bodyText;
}

/* =========================
   TOPIC FLOW
========================= */

function selectTopic(topic) {
  topicInput.value = topic;
  topicInput.focus();
}

async function generateLesson() {
  const topic = topicInput.value.trim();
  if (!topic) {
    showToast("Please enter a topic first.", "error");
    topicInput.focus();
    return;
  }

  currentTopic = topic;
  currentSessionId = null;
  currentAssessmentId = null;
  currentQuestions = [];
  currentLessonMarkdown = "";
  setTakeExamVisible(false);
  clearViews();

  showLoading("Creating your lesson", [
    `Understanding “${topic}”...`,
    "Organizing the important concepts...",
    "Preparing a clear explanation...",
    "Adding examples and common mistakes...",
    "Finalizing your personalized lesson..."
  ]);

  try {
    const sessionData = await apiFetch("/api/session/topic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic })
    });

    currentSessionId = sessionData.sessionId;

    const explanationText = await apiFetch("/api/explanation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId })
    });

    currentLessonMarkdown = String(explanationText || "");
    hideLoading();
    renderLesson(currentTopic, currentLessonMarkdown);
    setTakeExamVisible(true);
  } catch (error) {
    hideLoading();
    showToast(error.message || "Something went wrong.", "error");
  }
}

function renderLesson(topic, markdownText) {
  lessonSection.classList.add("show");
  examSection.classList.remove("show");

  lessonSection.innerHTML = `
    <div class="lesson-header">
      <div class="eyebrow">Your AI lesson</div>
      <h2>${escapeHtml(topic)}</h2>
      <p>Markdown has been rendered into a readable study page. Use the buttons below to copy, go back, or start the exam.</p>
      <div class="lesson-actions">
        <button class="secondary-button" type="button" onclick="copyLesson()">Copy lesson</button>
        <button class="ghost-button" type="button" onclick="showHome()">Back to home</button>
      </div>
    </div>
    <div class="lesson-content" id="lessonContent"></div>
  `;

  const content = document.getElementById("lessonContent");
  const html = marked.parse(markdownText || "");
  content.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });

  highlightCodeBlocks(content);
  renderMath(content);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function highlightCodeBlocks(root) {
  root.querySelectorAll("pre code").forEach((block) => {
    if (window.hljs) hljs.highlightElement(block);
  });
}

function renderMath(root) {
  if (typeof renderMathInElement !== "function") return;
  try {
    renderMathInElement(root, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false }
      ],
      throwOnError: false
    });
  } catch (error) {
    console.warn("KaTeX render failed:", error);
  }
}

async function copyLesson() {
  if (!currentLessonMarkdown) {
    showToast("No lesson to copy yet.", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(currentLessonMarkdown);
    showToast("Lesson copied to clipboard.", "success");
  } catch {
    showToast("Could not copy the lesson.", "error");
  }
}

function setTakeExamVisible(visible) {
  if (!takeExamButton) return;
  takeExamButton.style.display = visible ? "block" : "none";
}

function startExam() {
  if (!currentSessionId) {
    showToast("Generate a lesson first.", "error");
    return;
  }
  generateExam().catch((error) => showToast(error.message || "Could not start exam.", "error"));
}

async function generateExam() {
  showLoading("Creating your exam", [
    "Selecting important sub-concepts...",
    "Writing exam questions...",
    "Balancing MCQs and short answers...",
    "Preparing the answer sheet..."
  ]);

  try {
    const data = await apiFetch("/api/assessment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId })
    });

    currentAssessmentId = data.assessmentId;
    currentQuestions = data.questions || [];
    hideLoading();
    renderExam();
  } catch (error) {
    hideLoading();
    showToast(error.message || "Could not generate exam.", "error");
  }
}

function renderExam() {
  lessonSection.classList.remove("show");
  examSection.classList.add("show");

  const questionCards = currentQuestions.map((q, index) => {
    const options = Array.isArray(q.options) ? q.options : [];
    const inputName = `question-${q.id}`;

    if (q.question_type === "mcq") {
      return `
        <div class="exam-card" style="padding:24px;margin-top:18px;">
          <div class="eyebrow">Question ${index + 1} · MCQ</div>
          <h3 style="margin-top:14px;font-size:20px;">${escapeHtml(q.question_text)}</h3>
          <div style="margin-top:16px;display:grid;gap:10px;">
            ${options.map((opt) => `
              <label style="display:flex;gap:10px;align-items:flex-start;padding:14px;border:1px solid var(--border);border-radius:16px;background:var(--card-secondary);cursor:pointer;">
                <input type="radio" name="${inputName}" value="${escapeAttr(opt)}" style="margin-top:4px;" />
                <span>${escapeHtml(opt)}</span>
              </label>
            `).join("")}
          </div>
        </div>
      `;
    }

    return `
      <div class="exam-card" style="padding:24px;margin-top:18px;">
        <div class="eyebrow">Question ${index + 1} · Short Answer</div>
        <h3 style="margin-top:14px;font-size:20px;">${escapeHtml(q.question_text)}</h3>
        <textarea id="${inputName}" rows="5" style="width:100%;margin-top:16px;padding:16px;border-radius:16px;border:1px solid var(--border);background:var(--background-secondary);color:var(--text);resize:vertical;" placeholder="Type your answer here..."></textarea>
      </div>
    `;
  }).join("");

  examSection.innerHTML = `
    <div class="exam-header">
      <div class="eyebrow">Exam mode</div>
      <h2>${escapeHtml(currentTopic || "Generated exam")}</h2>
      <p>Answer all questions, then submit. Short answers are graded by the backend.</p>
      <div class="exam-actions">
        <button class="secondary-button" type="button" onclick="backToLesson()">Back to lesson</button>
        <button class="primary-button" type="button" onclick="submitExam()">Submit answers</button>
      </div>
    </div>
    <div class="exam-content">${questionCards}</div>
  `;

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function backToLesson() {
  examSection.classList.remove("show");
  lessonSection.classList.add("show");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function submitExam() {
  if (!currentAssessmentId) {
    showToast("No exam is active.", "error");
    return;
  }

  const answers = currentQuestions.map((q) => {
    const questionId = q.id;
    let answer = "";

    if (q.question_type === "mcq") {
      const picked = document.querySelector(`input[name="question-${questionId}"]:checked`);
      answer = picked ? picked.value : "";
    } else {
      const textarea = document.getElementById(`question-${questionId}`);
      answer = textarea ? textarea.value.trim() : "";
    }

    return { questionId, answer };
  });

  showLoading("Checking your answers", [
    "Grading MCQs...",
    "Evaluating short answers...",
    "Finding weak concepts...",
    "Preparing feedback..."
  ]);

  try {
    const result = await apiFetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assessmentId: currentAssessmentId, answers })
    });

    hideLoading();
    renderResults(result);
  } catch (error) {
    hideLoading();
    showToast(error.message || "Could not submit exam.", "error");
  }
}

function renderResults(result) {
  examSection.classList.add("show");
  const graded = result.graded || [];
  const weakConcepts = result.weakConcepts || [];

  examSection.innerHTML = `
    <div class="exam-header">
      <div class="eyebrow">Results</div>
      <h2>Score: ${Number(result.score || 0)}%</h2>
      <p>Your exam has been graded. Review what you got right and the concepts that need more practice.</p>
      <div class="exam-actions">
        <button class="secondary-button" type="button" onclick="backToLesson()">Back to lesson</button>
        <button class="ghost-button" type="button" onclick="showHome()">Go home</button>
      </div>
    </div>

    <div class="lesson-content">
      <h3>Question feedback</h3>
      ${graded.map((g, i) => `
        <div style="margin-top:18px;padding:16px;border:1px solid var(--border);border-radius:16px;background:var(--card-secondary);">
          <strong>Q${i + 1}:</strong> ${escapeHtml(g.question)}<br />
          <div style="margin-top:8px;color:var(--muted);">Your answer: ${escapeHtml(g.studentAnswer || "(blank)")}</div>
          <div style="margin-top:6px;color:${g.isCorrect ? 'var(--success)' : 'var(--danger)'};">${escapeHtml(g.feedback || "")}</div>
        </div>
      `).join("")}

      <h3 style="margin-top:28px;">Weak concepts</h3>
      ${weakConcepts.length ? weakConcepts.map((w) => `
        <div style="margin-top:14px;padding:16px;border:1px solid var(--border);border-radius:16px;background:var(--card-secondary);">
          <strong>${escapeHtml(w.conceptTag || "Concept")}</strong><br />
          <span style="color:var(--muted);">${escapeHtml(w.diagnosis || "")}</span>
        </div>
      `).join("") : '<p style="margin-top:12px;color:var(--muted);">No weak concepts detected. Good work.</p>'}
    </div>
  `;

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* =========================
   PDF PLACEHOLDER
========================= */

function isPdf(file) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function handlePdfSelect() {
  const file = pdfInput.files?.[0];
  if (!file) {
    selectedPdf = null;
    fileName.textContent = "No file selected";
    return;
  }

  if (!isPdf(file)) {
    selectedPdf = null;
    fileName.textContent = "No file selected";
    pdfInput.value = "";
    showToast("Please select a PDF file.", "error");
    return;
  }

  selectedPdf = file;
  fileName.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
}

function studyPdf() {
  showToast("PDF workflow is the next file. This button is ready for the backend route.", "success");
}

/* =========================
   UI HELPERS
========================= */

function clearViews() {
  lessonSection.classList.remove("show");
  examSection.classList.remove("show");
  lessonSection.innerHTML = "";
  examSection.innerHTML = "";
}

function showHome() {
  document.getElementById("homeSection").style.display = "block";
  lessonSection.classList.remove("show");
  examSection.classList.remove("show");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showRecallMessage() {
  showToast("Recall feature will appear after weak concepts are scheduled.", "success");
}

function showLoading(title, messages) {
  loadingTitle.textContent = title;
  let index = 0;
  loadingMessage.textContent = messages[0] || "Working...";
  loadingOverlay.classList.add("show");
  clearInterval(loadingInterval);
  loadingInterval = setInterval(() => {
    index = (index + 1) % messages.length;
    loadingMessage.textContent = messages[index];
  }, 1700);
}

function hideLoading() {
  clearInterval(loadingInterval);
  loadingOverlay.classList.remove("show");
}

function showToast(message, type = "success") {
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(toast.hideTimeout);
  toast.hideTimeout = setTimeout(() => toast.classList.remove("show"), 3500);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function injectExtraStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .exam-content {
      padding: 0 0 8px;
    }
    .exam-card h3 {
      line-height: 1.35;
    }
    .lesson-header .lesson-actions,
    .exam-header .exam-actions {
      margin-top: 18px;
    }
  `;
  document.head.appendChild(style);
}

/* =========================
   GLOBAL EXPORTS
========================= */

window.selectTopic = selectTopic;
window.generateLesson = generateLesson;
window.copyLesson = copyLesson;
window.startExam = startExam;
window.backToLesson = backToLesson;
window.submitExam = submitExam;
window.showHome = showHome;
window.showRecallMessage = showRecallMessage;
window.studyPdf = studyPdf;
window.toggleTheme = toggleTheme;
window.showToast = showToast;
window.showLoading = showLoading;
window.hideLoading = hideLoading;

init();