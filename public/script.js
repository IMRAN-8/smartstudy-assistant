(function () {
  "use strict";

  var APP = document.getElementById("app");
  var QUALITY = { AGAIN: 2, HARD: 3, GOOD: 4, EASY: 5 };
  var STEP_ORDER = ["explanation", "exam", "results", "recall"];
  var STEP_LABEL = { explanation: "Lesson", exam: "Exam", results: "Results", recall: "Recall" };

  var CURATED_SYLLABUS = [
    {
      domain: "Molecular Biology",
      topic: "CRISPR-Cas9 Mechanism and Genetic Engineering",
      meta: "PAM Recognition · R-Loop Formation · NHEJ vs HDR"
    },
    {
      domain: "Computer Architecture",
      topic: "Cache Coherence, MESI Protocol, and Bus Interface Architecture",
      meta: "MESI States · Write-Back Snooping · Bus Arbitration"
    },
    {
      domain: "Quantum Mechanics",
      topic: "Quantum Superposition, Entanglement, and Qubit States",
      meta: "Hilbert Space · Unitary Operators · Decoherence"
    },
    {
      domain: "Macroeconomics",
      topic: "Monetary Policy, Central Banking, and Inflation Dynamics",
      meta: "Taylor Rule · Liquidity Traps · Yield Curve Control"
    }
  ];

  var state = {
    screen: "gate", // Starts on Login Gate first until authenticated
    userId: null,
    displayName: null,
    userPhoto: null,
    history: null,
    entryMode: "topic",
    topicInput: "",
    pdfFile: null,
    loadingMessage: "",
    error: null,
    sessionId: null,
    topic: "",
    explanation: null,
    assessmentId: null,
    questions: [],
    currentCard: 0,
    answers: {},
    submission: null,
    openFeedback: {},
    reteachLessons: [],
    revealedMini: {},
    recallDue: [],
    recallRevealed: {}
  };

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function todayStamp() {
    return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();
  }

  function daysFromNow(iso) {
    var diff = Math.ceil((new Date(iso) - new Date()) / 86400000);
    if (diff <= 0) return "today";
    if (diff === 1) return "tomorrow";
    return "in " + diff + " days";
  }

  async function api(path, options) {
    options = options || {};
    var isForm = options.body instanceof FormData;
    var opts = Object.assign({}, options);
    if (!isForm) {
      opts.headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    } else {
      opts.headers = Object.assign({}, options.headers || {});
    }

    if (window.FirebaseAuth && typeof window.FirebaseAuth.getToken === "function") {
      var token = await window.FirebaseAuth.getToken();
      if (token) {
        opts.headers["Authorization"] = "Bearer " + token;
      }
    }

    var res = await fetch(path, opts);
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401) {
      if (window.FirebaseAuth && typeof window.FirebaseAuth.signOut === "function") {
        window.FirebaseAuth.signOut();
      }
      signOut();
      throw new Error(data.error || "Please sign in again.");
    }
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  function signOut() {
    Object.assign(state, {
      userId: null, displayName: null, userPhoto: null, history: null, screen: "gate", error: null,
      sessionId: null, topic: "", explanation: null, assessmentId: null,
      questions: [], answers: {}, submission: null, recallDue: []
    });
    updateBadge(0);
    render();
  }

  var NAV_FOR_SCREEN = { entry: "home", recall: "recall", history: "history", about: "about" };

  function renderChrome() {
    var nav = document.getElementById("main-nav");
    var userArea = document.getElementById("user-area");
    var signedIn = !!state.userId;

    if (nav) {
      nav.hidden = !signedIn;
      var active = NAV_FOR_SCREEN[state.screen] || null;
      Array.prototype.forEach.call(nav.querySelectorAll(".nav-tab"), function (tab) {
        var isActive = tab.dataset.nav === active;
        tab.classList.toggle("is-active", isActive);
      });
    }

    if (userArea) {
      var displayName = state.displayName || "Student";
      var initial = (displayName.charAt(0) || "S").toUpperCase();
      userArea.innerHTML = signedIn
        ? '<div class="user-chip">' +
            (state.userPhoto
              ? '<img class="avatar" src="' + escapeHtml(state.userPhoto) + '" alt="" style="object-fit:cover;" />'
              : '<span class="avatar" aria-hidden="true">' + escapeHtml(initial) + "</span>") +
            '<span class="user-name">' + escapeHtml(displayName) + "</span>" +
            '<button class="link-btn" data-action="switch-user">Sign out</button>' +
          "</div>"
        : "";
    }
  }

  function render() {
    APP.innerHTML = '<div class="view">' + screenInnerHtml() + "</div>";
    renderChrome();
    attachBehaviors();
  }

  function showError(message, fallbackScreen) {
    state.error = message;
    state.screen = fallbackScreen || (state.screen === "loading" ? "entry" : state.screen);
    render();
  }

  function setLoading(message) {
    state.loadingMessage = message;
    state.error = null;
    state.screen = "loading";
    render();
  }

  function goto(screen, extra) {
    Object.assign(state, extra || {}, { screen: screen, error: null });
    render();
  }

  function resetToEntry() {
    Object.assign(state, {
      screen: "entry", entryMode: "topic", topicInput: "", pdfFile: null, error: null,
      sessionId: null, topic: "", explanation: null, assessmentId: null, questions: [],
      currentCard: 0, answers: {}, submission: null, openFeedback: {}, reteachLessons: [],
      revealedMini: {}
    });
    render();
  }

  // API Actions
  async function startTopicSession() {
    var topic = state.topicInput.trim();
    if (!topic) return showError("Enter a topic before starting.", "entry");
    try {
      setLoading("Initializing study session…");
      var data = await api("/api/session/topic", { method: "POST", body: JSON.stringify({ topic: topic }) });
      state.sessionId = data.sessionId;
      state.topic = data.topic;
      await generateExplanation();
    } catch (e) { showError(e.message, "entry"); }
  }

  async function startPdfSession() {
    if (!state.pdfFile) return showError("Attach a PDF before starting.", "entry");
    try {
      setLoading("Reading PDF document…");
      var fd = new FormData();
      fd.append("pdf", state.pdfFile);
      if (state.topicInput.trim()) fd.append("topic", state.topicInput.trim());
      var data = await api("/api/session/pdf", { method: "POST", body: fd });
      state.sessionId = data.sessionId;
      state.topic = data.topic;
      await generateExplanation();
    } catch (e) { showError(e.message, "entry"); }
  }

  async function generateExplanation() {
    try {
      setLoading("Synthesizing structured academic lesson…");
      var data = await api("/api/explanation", { method: "POST", body: JSON.stringify({ sessionId: state.sessionId }) });
      state.explanation = data.explanation;
      goto("explanation");
    } catch (e) { showError(e.message, "entry"); }
  }

  async function generateExam() {
    try {
      setLoading("Preparing 8-question diagnostic exam…");
      var data = await api("/api/assessment", { method: "POST", body: JSON.stringify({ sessionId: state.sessionId }) });
      state.assessmentId = data.assessmentId;
      state.questions = data.questions;
      state.currentCard = 0;
      state.answers = {};
      goto("exam");
    } catch (e) { showError(e.message, "explanation"); }
  }

  async function submitExam() {
    try {
      setLoading("Grading responses and diagnosing weak concepts…");
      var answers = state.questions.map(function (q) {
        return { questionId: q.id, answer: state.answers[q.id] || "" };
      });
      var data = await api("/api/submit", {
        method: "POST",
        body: JSON.stringify({ assessmentId: state.assessmentId, answers: answers })
      });
      state.submission = data;
      state.openFeedback = {};
      goto("results");
    } catch (e) { showError(e.message, "exam"); }
  }

  async function generateReteach() {
    try {
      setLoading("Re-teaching weak sub-concepts…");
      var data = await api("/api/reteach", { method: "POST", body: JSON.stringify({ sessionId: state.sessionId }) });
      state.reteachLessons = data.lessons;
      state.revealedMini = {};
      goto("reteach");
    } catch (e) { showError(e.message, "results"); }
  }

  async function loadRecall() {
    try {
      setLoading("Checking spaced-recall queue…");
      var data = await api("/api/recall/due");
      state.recallDue = data.due || [];
      state.recallRevealed = {};
      updateBadge(state.recallDue.length);
      goto("recall");
    } catch (e) { showError(e.message, "entry"); }
  }

  async function reviewRecall(id, quality) {
    try {
      await api("/api/recall/" + id + "/review", {
        method: "POST",
        body: JSON.stringify({ quality: quality })
      });
      state.recallDue = state.recallDue.filter(function (d) { return d.id !== id; });
      updateBadge(state.recallDue.length);
      render();
    } catch (e) { showError(e.message, "recall"); }
  }

  async function loadHistory() {
    try {
      setLoading("Loading study archive…");
      var data = await api("/api/sessions");
      state.history = data.sessions || [];
      goto("history");
    } catch (e) { showError(e.message, "entry"); }
  }

  async function resumeSession(id, topic) {
    state.sessionId = id;
    state.topic = topic || "";
    await generateExplanation();
  }

  async function refreshBadgeOnLoad() {
    try {
      var data = await api("/api/recall/due");
      updateBadge((data.due || []).length);
    } catch (e) {}
  }

  function updateBadge(count) {
    var badge = document.getElementById("due-badge");
    if (!badge) return;
    if (count > 0) {
      badge.hidden = false;
      badge.textContent = String(count);
    } else {
      badge.hidden = true;
    }
  }

  function buildStepper(screen) {
    if (!state.sessionId) return "";
    var activeKey = screen === "reteach" ? "results" : screen;
    var idx = STEP_ORDER.indexOf(activeKey);
    if (idx === -1) return "";
    return '<div class="stepper">' + STEP_ORDER.map(function (key, i) {
      var cls = i === idx ? "is-active" : i < idx ? "is-done" : "";
      return '<span class="step ' + cls + '">' + STEP_LABEL[key] + "</span>";
    }).join("") + "</div>";
  }

  function errorHtml() {
    return state.error ? '<div class="error-banner">' + escapeHtml(state.error) + "</div>" : "";
  }

  function screenInnerHtml() {
    // Always enforce Login Gate first if user is not signed in
    if (!state.userId && state.screen !== "loading") return errorHtml() + gateHtml();
    switch (state.screen) {
      case "gate": return errorHtml() + gateHtml();
      case "about": return errorHtml() + aboutHtml();
      case "history": return errorHtml() + historyHtml();
      case "loading": return loadingHtml();
      case "explanation": return buildStepper("explanation") + errorHtml() + explanationHtml();
      case "exam": return buildStepper("exam") + errorHtml() + examHtml();
      case "results": return buildStepper("results") + errorHtml() + resultsHtml();
      case "reteach": return buildStepper("reteach") + errorHtml() + reteachHtml();
      case "recall": return errorHtml() + recallHtml();
      default: return errorHtml() + entryHtml();
    }
  }

  // Dedicated Login Gate (Shown first before Workspace)
  function gateHtml() {
    return (
      '<div class="gate">' +
        '<div class="card">' +
          '<div class="gate-icon" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M3 8.5 12 4l9 4.5-9 4.5-9-4.5Z"/><path d="M7 11v5.2c0 .6.3 1.1.9 1.4 1.2.6 2.7 1 4.1 1s2.9-.4 4.1-1c.6-.3.9-.8.9-1.4V11"/>' +
            "</svg>" +
          "</div>" +
          '<div class="card-eyebrow"><span>Secure Sign In</span><span>' + todayStamp() + "</span></div>" +
          '<h1 class="card-title">Welcome to SmartStudy</h1>' +
          '<p class="card-body">Sign in with your Google account to access your adaptive lessons, weak-spot diagnosis, and spaced-recall queue.</p>' +
          '<div class="btn-row" style="margin-top: 2rem;">' +
            '<button class="btn btn-stamp" data-action="google-sign-in" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 12px; padding: 13px 20px;">' +
              '<svg style="width: 20px; height: 20px; background: #fff; border-radius: 50%; padding: 2px;" viewBox="0 0 24 24">' +
                '<path fill="#EA4335" d="M12 5c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.64 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>' +
                '<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>' +
                '<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>' +
                '<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>' +
              "</svg>" +
              "<span>Continue with Google</span>" +
            "</button>" +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  // Academic Studio Home View
  function entryHtml() {
    var isTopic = state.entryMode === "topic";
    var fileName = state.pdfFile ? state.pdfFile.name : "";
    return (
      '<div class="studio-hero">' +
        '<div class="studio-kicker">Academic Mastery Studio</div>' +
        '<h1 class="studio-heading">What concept are we mastering today?</h1>' +
        '<p class="studio-sub">Enter any subject or attach lecture notes to synthesize a clear study guide, take an 8-question diagnostic exam, and schedule spaced recall.</p>' +
      "</div>" +
      '<div class="card">' +
        '<div class="card-eyebrow"><span>New Session</span><span>' + todayStamp() + "</span></div>" +
        '<div class="mode-toggle">' +
          '<button class="mode-tab ' + (isTopic ? "is-active" : "") + '" data-action="entry-mode" data-mode="topic">Topic Study</button>' +
          '<button class="mode-tab ' + (!isTopic ? "is-active" : "") + '" data-action="entry-mode" data-mode="pdf">Upload a PDF</button>' +
        "</div>" +
        (isTopic
          ? '<label class="field-label" for="topic-input">Topic or Research Question</label>' +
            '<input class="text-input" id="topic-input" type="text" placeholder="e.g. Photosynthesis, the French Revolution, Big-O notation…" value="' + escapeHtml(state.topicInput) + '" />' +
            '<div class="btn-row is-end"><button class="btn btn-stamp" data-action="start-topic">Start studying →</button></div>'
          : '<div class="dropzone" data-action="trigger-file" role="button" tabindex="0">' +
              (fileName
                ? '<span class="file-chip">' + escapeHtml(fileName) + "</span>"
                : "<strong>Click to attach a PDF</strong>, or drag and drop here") +
            "</div>" +
            '<input type="file" id="pdf-file-input" accept="application/pdf" class="visually-hidden" />' +
            '<label class="field-label" for="topic-input">Session title (optional)</label>' +
            '<input class="text-input" id="topic-input" type="text" placeholder="Leave blank to use the PDF file name" value="' + escapeHtml(state.topicInput) + '" />' +
            '<div class="btn-row is-end"><button class="btn btn-stamp" data-action="start-pdf">Start studying →</button></div>'
        ) +
      "</div>" +
      '<div class="bento-section">' +
        '<div class="bento-head">' +
          '<span class="bento-kicker">Curated Academic Syllabi</span>' +
          '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">Click a track to populate</span>' +
        "</div>" +
        '<div class="bento-grid">' +
          CURATED_SYLLABUS.map(function (item, idx) {
            return (
              '<button class="bento-card" data-action="pick-syllabus" data-idx="' + idx + '">' +
                '<div class="bento-domain">' + escapeHtml(item.domain) + "</div>" +
                '<div class="bento-title">' + escapeHtml(item.topic) + "</div>" +
                '<div class="bento-meta">' + escapeHtml(item.meta) + "</div>" +
              "</button>"
            );
          }).join("") +
        "</div>" +
      "</div>"
    );
  }

  function aboutHtml() {
    return (
      '<div class="about-grid">' +
        '<div class="card">' +
          '<div class="card-eyebrow"><span>Creator &amp; Lead Engineer</span><span>Portfolio</span></div>' +
          '<h1 class="card-title">Md. Imran Hosen</h1>' +
          '<p class="card-body">Full-Stack AI Engineer &amp; Systems Architect building diagnostic learning workflows, structured LLM pipelines, and resilient cloud backends.</p>' +
          '<div class="creator-links">' +
            '<a class="creator-link" href="https://imran-8.github.io/" target="_blank" rel="noopener noreferrer">Portfolio </a>' +
            '<a class="creator-link" href="https://github.com/imran-8" target="_blank" rel="noopener noreferrer">GitHub </a>' +
            '<a class="creator-link" href="https://www.linkedin.com/in/md-imranhosen/" target="_blank" rel="noopener noreferrer">Linkdin  </a>' +
            '<a class="creator-link" href="mailto:imranhosen3315@gmail.com">Email</a>' +
          "</div>" +
        "</div>" +
        '<div class="card">' +
          '<div class="card-eyebrow"><span>System Architecture</span><span>5-Stage Pipeline</span></div>' +
          '<h2 class="card-title">How SmartStudy Works</h2>' +
          '<p class="card-body">1. <strong>Explain</strong>: First-principles synthesis from any topic or PDF.<br/>2. <strong>Examine</strong>: 8-question diagnostic check (5 MCQ + 3 short answer).<br/>3. <strong>Diagnose</strong>: Pinpoints weak sub-concepts.<br/>4. <strong>Re-teach</strong>: Targeted remediation with fresh analogies.<br/>5. <strong>Recall</strong>: SM-2 spaced repetition persisted in Supabase PostgreSQL.</p>' +
        "</div>" +
      "</div>"
    );
  }

  function loadingHtml() {
    return (
      '<div class="card loading-card">' +
        '<div class="stamp-spinner" aria-hidden="true"></div>' +
        '<span>' + escapeHtml(state.loadingMessage) + "</span>" +
      "</div>"
    );
  }

  function explanationHtml() {
    var ex = state.explanation || {};
    return (
      '<div class="card">' +
        '<div class="card-eyebrow"><span>' + escapeHtml(state.topic) + "</span><span>Lesson</span></div>" +
        '<h1 class="card-title">' + escapeHtml(ex.title || state.topic) + "</h1>" +
        '<div class="card-body"><p>' + escapeHtml(ex.overview || "") + "</p></div>" +
        (ex.examples && ex.examples.length
          ? '<div class="section-heading">Examples</div><ul class="example-list">' +
            ex.examples.map(function (e) { return "<li>" + escapeHtml(e) + "</li>"; }).join("") + "</ul>"
          : "") +
        (ex.commonMistakes && ex.commonMistakes.length
          ? '<div class="section-heading">Common mistakes</div><ul class="mistake-list">' +
            ex.commonMistakes.map(function (m) { return "<li>" + escapeHtml(m) + "</li>"; }).join("") + "</ul>"
          : "") +
        (ex.summary ? '<div class="section-heading">Summary</div><div class="card-body"><p>' + escapeHtml(ex.summary) + "</p></div>" : "") +
        '<div class="btn-row is-end">' +
          '<button class="btn btn-ghost" data-action="go-entry">Study something new</button>' +
          '<button class="btn btn-stamp" data-action="start-exam">Take the exam →</button>' +
        "</div>" +
      "</div>"
    );
  }

  function examHtml() {
    var qs = state.questions;
    var i = state.currentCard;
    var q = qs[i];
    if (!q) return '<div class="card"><p class="card-body">No questions loaded.</p></div>';
    var answered = qs.map(function (qq) { return !!(state.answers[qq.id] && String(state.answers[qq.id]).trim()); });
    var isLast = i === qs.length - 1;
    var body;
    if (q.question_type === "mcq") {
      var opts = q.options || [];
      var letters = "ABCDEFGH";
      body = '<ul class="option-list">' + opts.map(function (opt, idx) {
        var checked = state.answers[q.id] === opt;
        var inputId = "opt-" + q.id + "-" + idx;
        return (
          '<li class="option-row">' +
            '<input type="radio" name="q-' + q.id + '" id="' + inputId + '" value="' + escapeHtml(opt) + '" ' +
              (checked ? "checked" : "") + ' data-action="select-mcq" data-qid="' + q.id + '" />' +
            '<label class="option-label ' + (checked ? "is-checked" : "") + '" for="' + inputId + '">' +
              '<span class="option-letter">' + letters[idx] + "</span><span>" + escapeHtml(opt) + "</span>" +
            "</label>" +
          "</li>"
        );
      }).join("") + "</ul>";
    } else {
      body = '<textarea class="text-input" id="short-answer-input" data-qid="' + q.id + '" rows="4" placeholder="Write your answer…">' +
        escapeHtml(state.answers[q.id] || "") + "</textarea>";
    }
    return (
      '<div class="exam-progress">' +
        '<span class="exam-counter tabular-nums">QUESTION ' + (i + 1) + " / " + qs.length + "</span>" +
        '<div class="exam-dots">' + qs.map(function (_, idx) {
          var cls = idx === i ? "is-current" : answered[idx] ? "is-answered" : "";
          return '<button class="exam-dot ' + cls + '" data-action="exam-goto" data-index="' + idx + '"></button>';
        }).join("") + "</div>" +
      "</div>" +
      '<div class="card">' +
        '<div class="card-eyebrow"><span>' + (q.question_type === "mcq" ? "Multiple choice" : "Short answer") + "</span></div>" +
        '<h1 class="card-title">' + escapeHtml(q.question_text) + "</h1>" +
        body +
        '<div class="btn-row is-end">' +
          '<button class="btn btn-ghost" data-action="exam-prev" ' + (i === 0 ? "disabled" : "") + ">Back</button>" +
          (isLast
            ? '<button class="btn btn-stamp" data-action="exam-submit">Submit exam</button>'
            : '<button class="btn btn-stamp" data-action="exam-next">Next Question →</button>') +
        "</div>" +
      "</div>"
    );
  }

  function resultsHtml() {
    var sub = state.submission;
    if (!sub) return "";
    var hasWeak = (sub.weakConcepts || []).length > 0;
    return (
      '<div class="card">' +
        '<div class="card-eyebrow"><span>' + escapeHtml(state.topic) + '</span><span>Exam Results</span></div>' +
        '<h1 class="card-title tabular-nums">Score: ' + sub.score + "%</h1>" +
        '<p class="card-body">' +
          (hasWeak
            ? sub.weakConcepts.length + " sub-concept(s) flagged for targeted remediation and spaced recall."
            : "Every sub-concept tested came back clean.") +
        "</p>" +
        '<div class="btn-row is-end">' +
          '<button class="btn btn-ghost" data-action="go-entry">Study something new</button>' +
          (hasWeak ? '<button class="btn btn-stamp" data-action="go-reteach">Re-teach my weak areas →</button>' : "") +
        "</div>" +
      "</div>"
    );
  }

  function reteachHtml() {
    var lessons = state.reteachLessons || [];
    return (
      '<div class="card">' +
        '<div class="card-eyebrow"><span>Targeted Remediation</span><span>Re-teach</span></div>' +
        '<h1 class="card-title">Rebuilding weak sub-concepts</h1>' +
        lessons.map(function (l, i) {
          var revealed = !!state.revealedMini[i];
          return (
            '<div class="reteach-block">' +
              '<div class="section-heading" style="margin-top:0;">' + escapeHtml(l.conceptTag || "Concept " + (i + 1)) + "</div>" +
              '<div class="card-body"><p>' + escapeHtml(l.explanation || "") + "</p></div>" +
              (l.example ? '<div class="card-body"><em>Example: ' + escapeHtml(l.example) + "</em></div>" : "") +
              '<div style="margin-top:8px;"><strong>Quick check:</strong> ' + escapeHtml(l.miniQuestion || "") +
                (revealed
                  ? '<div class="card-body" style="color:var(--gold);margin-top:6px;">' + escapeHtml(l.miniAnswer || "") + "</div>"
                  : '<div class="btn-row"><button class="btn btn-ghost" data-action="reveal-mini" data-index="' + i + '">Reveal answer</button></div>') +
              "</div>" +
            "</div>"
          );
        }).join("") +
        '<div class="btn-row is-end">' +
          '<button class="btn btn-ghost" data-action="go-results">Back to results</button>' +
          '<button class="btn btn-stamp" data-action="go-recall">Open Review Queue →</button>' +
        "</div>" +
      "</div>"
    );
  }

  function recallHtml() {
    var due = state.recallDue || [];
    return (
      '<div class="card">' +
        '<div class="card-eyebrow"><span>Spaced Repetition</span><span class="tabular-nums">' + due.length + " due</span></div>" +
        '<h1 class="card-title">' + (due.length ? "Due for review" : "All caught up") + "</h1>" +
        (due.length
          ? due.map(function (item) {
              return (
                '<div class="reteach-block" data-recall-id="' + item.id + '">' +
                  '<div class="section-heading" style="margin-top:0;">' + escapeHtml(item.concept_tag) + " · due " + daysFromNow(item.due_at) + "</div>" +
                  '<div class="card-body"><p>' + escapeHtml(item.diagnosis) + "</p></div>" +
                  '<div class="quality-row">' +
                    '<button class="btn-quality" data-action="review-recall" data-id="' + item.id + '" data-quality="' + QUALITY.AGAIN + '">Again</button>' +
                    '<button class="btn-quality" data-action="review-recall" data-id="' + item.id + '" data-quality="' + QUALITY.HARD + '">Hard</button>' +
                    '<button class="btn-quality" data-action="review-recall" data-id="' + item.id + '" data-quality="' + QUALITY.GOOD + '">Good</button>' +
                    '<button class="btn-quality" data-action="review-recall" data-id="' + item.id + '" data-quality="' + QUALITY.EASY + '">Easy</button>' +
                  "</div>" +
                "</div>"
              );
            }).join("")
          : '<p class="card-body">Nothing is due right now. Complete a diagnostic exam to schedule new recall items.</p>') +
        '<div class="btn-row is-end"><button class="btn btn-ghost" data-action="go-entry">Back to Workspace</button></div>' +
      "</div>"
    );
  }

  function historyHtml() {
    var rows = state.history || [];
    return (
      '<div class="card">' +
        '<div class="card-eyebrow"><span>Session Archive</span><span class="tabular-nums">' + rows.length + " sessions</span></div>" +
        '<h1 class="card-title">Study History</h1>' +
        (rows.length
          ? '<div class="history-list">' + rows.map(function (row) {
              var score = row.score == null ? null : Number(row.score);
              var when = new Date(row.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
              return (
                '<div class="history-row" data-action="resume-session" data-id="' + escapeHtml(row.id) + '" data-topic="' + escapeHtml(row.topic) + '" role="button" tabindex="0">' +
                  '<div>' +
                    '<div class="history-topic">' + escapeHtml(row.topic) + "</div>" +
                    '<div class="history-meta">' + when + " · " + (row.source_type === "pdf" ? "PDF" : "Topic") + "</div>" +
                  "</div>" +
                  '<span class="score-pill tabular-nums">' + (score == null ? "In progress" : score + "%") + "</span>" +
                "</div>"
              );
            }).join("") + "</div>"
          : '<p class="card-body">No sessions recorded yet. Start one from the Home tab.</p>') +
      "</div>"
    );
  }

  function attachBehaviors() {
    var topicInput = document.getElementById("topic-input");
    if (topicInput) {
      topicInput.addEventListener("input", function (e) { state.topicInput = e.target.value; });
    }
    var shortAnswer = document.getElementById("short-answer-input");
    if (shortAnswer) {
      shortAnswer.addEventListener("input", function (e) {
        state.answers[e.target.dataset.qid] = e.target.value;
        var dot = APP.querySelector(".exam-dot.is-current");
        if (dot) dot.classList.toggle("is-answered", !!e.target.value.trim());
      });
    }
    var fileInput = document.getElementById("pdf-file-input");
    if (fileInput) {
      fileInput.addEventListener("change", function (e) {
        state.pdfFile = e.target.files[0] || null;
        render();
      });
    }
  }

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-action]");
    if (!el) return;
    var action = el.dataset.action;

    switch (action) {
      case "google-sign-in":
        if (window.FirebaseAuth && typeof window.FirebaseAuth.signIn === "function") {
          setLoading("Signing in with Google…");
          window.FirebaseAuth.signIn()
            .then(function (result) {
              var user = result.user;
              state.userId = user.uid;
              state.displayName = user.displayName;
              state.userPhoto = user.photoURL;
              resetToEntry();
              refreshBadgeOnLoad();
            })
            .catch(function (err) {
              showError(err.message, "gate");
            });
        } else {
          showError("Firebase Auth is not initialized yet. Check that /api/config/firebase is available on your server.js.", "gate");
        }
        break;

      case "switch-user":
        if (window.FirebaseAuth && typeof window.FirebaseAuth.signOut === "function") {
          window.FirebaseAuth.signOut();
        }
        signOut();
        break;

      case "entry-mode":
        state.entryMode = el.dataset.mode;
        render();
        break;

      case "pick-syllabus": {
        var item = CURATED_SYLLABUS[Number(el.dataset.idx)];
        if (item) {
          state.entryMode = "topic";
          state.topicInput = item.topic;
          render();
          var input = document.getElementById("topic-input");
          if (input) input.focus();
        }
        break;
      }

      case "trigger-file": {
        var fileEl = document.getElementById("pdf-file-input");
        if (fileEl) fileEl.click();
        break;
      }

      case "start-topic": startTopicSession(); break;
      case "start-pdf": startPdfSession(); break;
      case "start-exam": generateExam(); break;

      case "select-mcq": {
        state.answers[el.dataset.qid] = el.value;
        var optionList = el.closest(".option-list");
        if (optionList) {
          optionList.querySelectorAll(".option-label").forEach(function (lbl) {
            lbl.classList.remove("is-checked");
          });
          var selectedLabel = optionList.querySelector('label[for="' + el.id + '"]');
          if (selectedLabel) selectedLabel.classList.add("is-checked");
        }
        var currentDot = APP.querySelector(".exam-dot.is-current");
        if (currentDot) currentDot.classList.add("is-answered");
        break;
      }

      case "exam-prev":
        state.currentCard = Math.max(0, state.currentCard - 1);
        render();
        break;
      case "exam-next":
        state.currentCard = Math.min(state.questions.length - 1, state.currentCard + 1);
        render();
        break;
      case "exam-goto":
        state.currentCard = Number(el.dataset.index);
        render();
        break;
      case "exam-submit": submitExam(); break;
      case "go-reteach": generateReteach(); break;
      case "go-results": goto("results"); break;
      case "reveal-mini":
        state.revealedMini[el.dataset.index] = true;
        render();
        break;
      case "review-recall":
        reviewRecall(el.dataset.id, Number(el.dataset.quality));
        break;
      case "go-recall": loadRecall(); break;
      case "go-entry": resetToEntry(); break;

      case "nav-home": if (state.userId) resetToEntry(); break;
      case "nav-review": if (state.userId) loadRecall(); break;
      case "nav-history": if (state.userId) loadHistory(); break;
      case "nav-about": if (state.userId) goto("about"); break;
      case "resume-session": resumeSession(el.dataset.id, el.dataset.topic); break;
    }
  });

  function startAppWithUser(user) {
    if (user) {
      state.userId = user.uid;
      state.displayName = user.displayName;
      state.userPhoto = user.photoURL;
      state.screen = "entry";
      render();
      refreshBadgeOnLoad();
    } else {
      state.userId = null;
      state.displayName = null;
      state.userPhoto = null;
      state.screen = "gate";
      render();
    }
  }

  (function boot() {
    state.screen = "gate";
    render();
    if (window.FirebaseAuth && window.FirebaseAuth.isReady) {
      window.FirebaseAuth.onAuthStateChanged(startAppWithUser);
    } else {
      window.addEventListener("firebase-ready", function () {
        window.FirebaseAuth.onAuthStateChanged(startAppWithUser);
      });
    }
  })();
})();