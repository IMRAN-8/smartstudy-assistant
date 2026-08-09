(function () {
  "use strict";

  var APP = document.getElementById("app");
  var REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var QUALITY = { AGAIN: 2, HARD: 3, GOOD: 4, EASY: 5 };
  // Human-framed milestones the Leitner box visualizes an interval against.
  var SLOTS = [
    { days: 1, label: "Tomorrow" },
    { days: 2, label: "2 days" },
    { days: 4, label: "4 days" },
    { days: 7, label: "1 wk" },
    { days: 14, label: "2 wks" },
    { days: 30, label: "1 mo" },
    { days: Infinity, label: "Mastered" },
  ];
  var STEP_ORDER = ["explanation", "exam", "results", "recall"];
  var STEP_LABEL = { explanation: "Lesson", exam: "Exam", results: "Results", recall: "Recall" };

  var USER_KEY = "smartstudy.userId";

  var state = {
    screen: "entry",
    userId: null,
    userInput: "",
    history: null,
    entryMode: "topic",
    topicInput: "",
    pdfFile: null,
    isDragging: false,
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
    recallRevealed: {},
  };

  // --------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function todayStamp() {
    return new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
    }
    // Identity travels on every request; the server scopes all data to it.
    if (state.userId) {
      opts.headers = Object.assign({}, opts.headers || {}, { "X-User-Id": state.userId });
    }
    var res = await fetch(path, opts);
    var data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (res.status === 401) {
      // The server no longer accepts this identity — send them back to sign in.
      signOut();
      throw new Error(data.error || "Please sign in again.");
    }
    if (!res.ok) throw new Error(data.error || "Something went wrong (" + res.status + ")");
    return data;
  }

  // ------------------------------------------------------------------
  // Session / identity
  // ------------------------------------------------------------------
  async function signIn(rawId) {
    var id = String(rawId || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(id)) {
      return showError("Pick an ID of 3-40 characters: letters, numbers, dot, dash or underscore.", "gate");
    }
    try {
      setLoading("Opening your workspace\u2026");
      state.userId = id;
      await api("/api/user", { method: "POST", body: JSON.stringify({ userId: id }) });
      try { localStorage.setItem(USER_KEY, id); } catch (e) { /* private mode */ }
      resetToEntry();
      refreshBadgeOnLoad();
    } catch (e) {
      state.userId = null;
      showError(e.message, "gate");
    }
  }

  function signOut() {
    try { localStorage.removeItem(USER_KEY); } catch (e) { /* ignore */ }
    Object.assign(state, {
      userId: null, userInput: "", history: null, screen: "gate", error: null,
      sessionId: null, topic: "", explanation: null, assessmentId: null,
      questions: [], answers: {}, submission: null, recallDue: [],
    });
    updateBadge(0);
    render();
  }

  async function loadHistory() {
    try {
      setLoading("Pulling up your history\u2026");
      var data = await api("/api/sessions");
      state.history = data.sessions || [];
      goto("history");
    } catch (e) { showError(e.message, "entry"); }
  }

  // Reopen a past session. The explanation is cached server-side, so this is
  // a database read rather than a fresh generation.
  async function resumeSession(id, topic) {
    state.sessionId = id;
    state.topic = topic || "";
    await generateExplanation();
  }

  var NAV_FOR_SCREEN = { entry: "home", recall: "recall", history: "history" };

  // Keeps the persistent chrome (nav + user chip) in step with the view.
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
        if (isActive) tab.setAttribute("aria-current", "page");
        else tab.removeAttribute("aria-current");
      });
    }

    if (userArea) {
      userArea.innerHTML = signedIn
        ? '<div class="user-chip">' +
            '<span class="avatar" aria-hidden="true">' + escapeHtml(state.userId.charAt(0)) + "</span>" +
            '<span class="user-name" title="' + escapeHtml(state.userId) + '">' + escapeHtml(state.userId) + "</span>" +
            '<button class="link-btn" data-action="switch-user" title="Switch user">Switch</button>' +
          "</div>"
        : "";
    }
  }

  function render() {
    APP.innerHTML = screenHtml();
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

  // --------------------------------------------------------------------
  // Actions (API calls)
  // --------------------------------------------------------------------
  async function startTopicSession() {
    var topic = state.topicInput.trim();
    if (!topic) return showError("Type a topic before starting.", "entry");
    try {
      setLoading("Opening a new file\u2026");
      var data = await api("/api/session/topic", { method: "POST", body: JSON.stringify({ topic: topic }) });
      state.sessionId = data.sessionId;
      state.topic = data.topic;
      await generateExplanation();
    } catch (e) { showError(e.message, "entry"); }
  }

  async function startPdfSession() {
    if (!state.pdfFile) return showError("Attach a PDF before starting.", "entry");
    try {
      setLoading("Reading the PDF\u2026");
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
      setLoading("Writing the lesson\u2026");
      var data = await api("/api/explanation", { method: "POST", body: JSON.stringify({ sessionId: state.sessionId }) });
      state.explanation = data.explanation;
      goto("explanation");
    } catch (e) { showError(e.message, "entry"); }
  }

  async function generateExam() {
    try {
      setLoading("Drawing up the exam\u2026");
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
      setLoading("Grading your answers\u2026");
      var answers = state.questions.map(function (q) {
        return { questionId: q.id, answer: state.answers[q.id] || "" };
      });
      var data = await api("/api/submit", {
        method: "POST",
        body: JSON.stringify({ assessmentId: state.assessmentId, answers: answers }),
      });
      state.submission = data;
      state.openFeedback = {};
      goto("results");
    } catch (e) { showError(e.message, "exam"); }
  }

  async function generateReteach() {
    try {
      setLoading("Re-teaching the weak spots\u2026");
      var data = await api("/api/reteach", { method: "POST", body: JSON.stringify({ sessionId: state.sessionId }) });
      state.reteachLessons = data.lessons;
      state.revealedMini = {};
      goto("reteach");
    } catch (e) { showError(e.message, "results"); }
  }

  async function loadRecall() {
    try {
      setLoading("Checking what's due\u2026");
      var data = await api("/api/recall/due");
      state.recallDue = data.due;
      state.recallRevealed = {};
      updateBadge(data.due.length);
      goto("recall");
    } catch (e) { showError(e.message, "entry"); }
  }

  async function reviewRecall(id, quality) {
    var itemEl = APP.querySelector('[data-recall-id="' + id + '"]');
    try {
      var data = await api("/api/recall/" + id + "/review", {
        method: "POST",
        body: JSON.stringify({ quality: quality }),
      });
      var finish = function () {
        state.recallDue = state.recallDue.filter(function (d) { return d.id !== id; });
        updateBadge(state.recallDue.length);
        render();
      };
      if (itemEl && !REDUCE_MOTION) animateToSlot(itemEl, data.recall.interval_days, finish);
      else finish();
    } catch (e) { showError(e.message, "recall"); }
  }

  async function refreshBadgeOnLoad() {
    try {
      var data = await api("/api/recall/due");
      updateBadge(data.due.length);
    } catch (e) { /* silent — badge is a nicety, not critical */ }
  }

  function updateBadge(count) {
    var badge = document.getElementById("due-badge");
    if (!badge) return;
    if (count > 0) {
      badge.hidden = false;
      badge.classList.remove("visually-hidden");
      badge.textContent = String(count);
    } else {
      badge.hidden = true;
      badge.classList.add("visually-hidden");
    }
  }

  function animateToSlot(itemEl, intervalDays, done) {
    var track = document.getElementById("box-track");
    if (!track) return done();
    var slotIndex = SLOTS.findIndex(function (s) { return intervalDays <= s.days; });
    if (slotIndex === -1) slotIndex = SLOTS.length - 1;
    var slotEl = track.children[slotIndex];
    if (!slotEl) return done();

    var itemRect = itemEl.getBoundingClientRect();
    var slotRect = slotEl.getBoundingClientRect();
    var ghost = document.createElement("div");
    ghost.className = "box-ghost-card";
    ghost.style.left = itemRect.left + "px";
    ghost.style.top = itemRect.top + "px";
    ghost.style.width = Math.min(itemRect.width, 160) + "px";
    document.body.appendChild(ghost);
    itemEl.classList.add("is-filing");

    requestAnimationFrame(function () {
      var dx = slotRect.left + slotRect.width / 2 - itemRect.left - 80;
      var dy = slotRect.top - itemRect.top;
      ghost.style.transform = "translate(" + dx + "px," + dy + "px) scale(0.2)";
      ghost.style.opacity = "0.15";
    });
    setTimeout(function () {
      ghost.remove();
      slotEl.classList.add("slot-pulse");
      setTimeout(function () { slotEl.classList.remove("slot-pulse"); }, 500);
      done();
    }, 650);
  }

  function resetToEntry() {
    Object.assign(state, {
      screen: "entry", entryMode: "topic", topicInput: "", pdfFile: null, error: null,
      sessionId: null, topic: "", explanation: null, assessmentId: null, questions: [],
      currentCard: 0, answers: {}, submission: null, openFeedback: {}, reteachLessons: [],
      revealedMini: {},
    });
    render();
  }

  // --------------------------------------------------------------------
  // Templates
  // --------------------------------------------------------------------
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

  function screenHtml() {
    return '<div class="view">' + screenInnerHtml() + "</div>";
  }

  function screenInnerHtml() {
    if (!state.userId && state.screen !== "loading") return errorHtml() + gateHtml();
    switch (state.screen) {
      case "gate": return errorHtml() + gateHtml();
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

  function gateHtml() {
    return (
      '<div class="gate">' +
        '<div class="card">' +
          '<div class="gate-icon" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M3 8.5 12 4l9 4.5-9 4.5-9-4.5Z"/><path d="M7 11v5.2c0 .6.3 1.1.9 1.4 1.2.6 2.7 1 4.1 1s2.9-.4 4.1-1c.6-.3.9-.8.9-1.4V11"/>' +
            "</svg>" +
          "</div>" +
          '<div class="card-eyebrow"><span>Sign in</span><span>' + todayStamp() + "</span></div>" +
          '<h1 class="card-title">Who\u2019s studying?</h1>' +
          '<p class="card-body">Pick a user ID. Your lessons, results and review queue are kept separately under it, so they stay yours.</p>' +
          '<label class="field-label" for="user-input">User ID</label>' +
          '<input class="text-input" id="user-input" type="text" autocomplete="username" spellcheck="false" ' +
            'placeholder="e.g. imran, sara.k, study-buddy" value="' + escapeHtml(state.userInput) + '" />' +
          '<p class="hint">3-40 characters \u2014 letters, numbers, dot, dash or underscore. New IDs are created automatically.</p>' +
          '<div class="btn-row is-end">' +
            '<button class="btn btn-stamp" data-action="sign-in">Start studying</button>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  function historyHtml() {
    var rows = state.history || [];
    return (
      '<div class="card">' +
        '<div class="card-eyebrow"><span>History</span><span>' + rows.length + " session" + (rows.length === 1 ? "" : "s") + "</span></div>" +
        '<h1 class="card-title">Everything you\u2019ve studied</h1>' +
        (rows.length
          ? '<div class="history-list">' + rows.map(historyRowHtml).join("") + "</div>"
          : '<div class="empty-state">No sessions yet. Start one from Home and it will show up here.</div>') +
        '<div class="btn-row is-end">' +
          '<button class="btn btn-stamp" data-action="go-entry">New session</button>' +
        "</div>" +
      "</div>"
    );
  }

  function historyRowHtml(row) {
    var score = row.score == null ? null : Number(row.score);
    var cls = score == null ? "is-none" : score >= 80 ? "is-good" : score >= 50 ? "is-mid" : "is-low";
    var when = new Date(row.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    var weak = Number(row.weak_count || 0);
    return (
      '<div class="history-row" data-action="resume-session" data-id="' + escapeHtml(row.id) +
        '" data-topic="' + escapeHtml(row.topic) + '" role="button" tabindex="0">' +
        '<div class="history-main">' +
          '<div class="history-topic">' + escapeHtml(row.topic) + "</div>" +
          '<div class="history-meta">' + when + " \u00b7 " + (row.source_type === "pdf" ? "PDF" : "Topic") +
            (weak ? " \u00b7 " + weak + " weak spot" + (weak === 1 ? "" : "s") : "") + "</div>" +
        "</div>" +
        '<span class="score-pill ' + cls + '">' + (score == null ? "Not sat" : score + "%") + "</span>" +
      "</div>"
    );
  }

  function entryHtml() {
    var isTopic = state.entryMode === "topic";
    return (
      '<div class="mode-toggle">' +
        '<button class="mode-tab ' + (isTopic ? "is-active" : "") + '" data-action="entry-mode" data-mode="topic">Type a topic</button>' +
        '<button class="mode-tab ' + (!isTopic ? "is-active" : "") + '" data-action="entry-mode" data-mode="pdf">Upload a PDF</button>' +
      "</div>" +
      '<div class="card">' +
        '<div class="card-eyebrow"><span>New Session</span><span>' + todayStamp() + "</span></div>" +
        '<h1 class="card-title">What are we studying?</h1>' +
        (isTopic ? entryTopicHtml() : entryPdfHtml()) +
        '<div class="btn-row is-end">' +
          '<button class="btn btn-stamp" data-action="' + (isTopic ? "start-topic" : "start-pdf") + '">Start studying</button>' +
        "</div>" +
      "</div>"
    );
  }

  function entryTopicHtml() {
    return (
      '<label class="field-label" for="topic-input">Topic</label>' +
      '<input class="text-input" id="topic-input" type="text" placeholder="e.g. Photosynthesis, the French Revolution, Big-O notation\u2026" value="' +
      escapeHtml(state.topicInput) + '" />'
    );
  }

  function entryPdfHtml() {
    var fileName = state.pdfFile ? state.pdfFile.name : null;
    return (
      '<div class="dropzone ' + (state.isDragging ? "is-drag" : "") + '" data-action="trigger-file" tabindex="0" role="button" aria-label="Attach a PDF">' +
        (fileName
          ? '<span class="file-chip">' + escapeHtml(fileName) + "</span>"
          : "<strong>Click to attach</strong>, or drag a PDF here") +
      "</div>" +
      '<input type="file" id="pdf-file-input" accept="application/pdf" class="visually-hidden" />' +
      '<label class="field-label" style="margin-top:1rem" for="topic-input">Name it (optional)</label>' +
      '<input class="text-input" id="topic-input" type="text" placeholder="Leave blank to use the file name" value="' +
      escapeHtml(state.topicInput) + '" />'
    );
  }

  function loadingHtml() {
    return (
      '<div class="card card-flat loading-card">' +
        '<div class="stamp-spinner" aria-hidden="true"></div>' +
        '<span class="loading-text">' + escapeHtml(state.loadingMessage) + "</span>" +
      "</div>"
    );
  }

  function explanationHtml() {
    var ex = state.explanation || {};
    return (
      '<div class="card">' +
        '<div class="card-eyebrow"><span>' + escapeHtml(state.topic) + '</span><span>Lesson</span></div>' +
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
          '<button class="btn btn-stamp" data-action="start-exam">Take the exam</button>' +
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
      body = '<textarea class="text-input" id="short-answer-input" data-qid="' + q.id + '" rows="4" placeholder="Write your answer\u2026">' +
        escapeHtml(state.answers[q.id] || "") + "</textarea>";
    }

    return (
      '<div class="exam-progress">' +
        '<span class="exam-counter">QUESTION ' + (i + 1) + " / " + qs.length + "</span>" +
        '<div class="exam-dots">' + qs.map(function (_, idx) {
          var cls = idx === i ? "is-current" : answered[idx] ? "is-answered" : "";
          return '<button class="exam-dot ' + cls + '" data-action="exam-goto" data-index="' + idx + '" aria-label="Question ' + (idx + 1) + '"></button>';
        }).join("") + "</div>" +
      "</div>" +
      '<div class="card">' +
        '<div class="card-eyebrow"><span>' + (q.question_type === "mcq" ? "Multiple choice" : "Short answer") + '</span></div>' +
        '<h1 class="card-title">' + escapeHtml(q.question_text) + "</h1>" +
        body +
        '<div class="btn-row">' +
          '<button class="btn btn-ghost" data-action="exam-prev" ' + (i === 0 ? "disabled" : "") + '>Back</button>' +
          (isLast
            ? '<button class="btn btn-stamp" data-action="exam-submit">Submit exam</button>'
            : '<button class="btn btn-stamp" data-action="exam-next">Next card</button>') +
        "</div>" +
      "</div>"
    );
  }

  function groupConcepts(sub) {
    var order = [];
    var byTag = {};
    (sub.graded || []).forEach(function (g) {
      if (!byTag[g.conceptTag]) { byTag[g.conceptTag] = { tag: g.conceptTag, items: [] }; order.push(g.conceptTag); }
      byTag[g.conceptTag].items.push(g);
    });
    var weakByTag = {};
    (sub.weakConcepts || []).forEach(function (w) { weakByTag[w.conceptTag] = w; });
    return order.map(function (tag) {
      return Object.assign({}, byTag[tag], { weak: weakByTag[tag] || null });
    });
  }

  function resultsHtml() {
    var sub = state.submission;
    if (!sub) return "";
    var score = sub.score;
    var scoreClass = score >= 80 ? "is-good" : score >= 50 ? "is-mid" : "";
    var concepts = groupConcepts(sub);
    var hasWeak = (sub.weakConcepts || []).length > 0;

    return (
      '<div class="card">' +
        '<div class="card-eyebrow"><span>' + escapeHtml(state.topic) + '</span><span>Results</span></div>' +
        '<div class="score-ring ' + scoreClass + '" style="--pct:' + score + '">' +
          '<div class="score-ring-inner"><span class="score-value">' + score + "%</span></div>" +
        "</div>" +
        '<p class="score-caption">' + (
          hasWeak ? sub.weakConcepts.length + " sub-concept" + (sub.weakConcepts.length > 1 ? "s" : "") + " flagged for review below."
                   : "Every sub-concept tested came back clean \u2014 nicely done."
        ) + "</p>" +
        '<div class="section-heading">By sub-concept</div>' +
        '<div class="concept-grid">' + concepts.map(function (c) {
          if (c.weak) {
            var cls = c.weak.severity === "high" ? "high" : "medium";
            return '<div class="concept-row"><span class="concept-name">' + escapeHtml(c.tag) + '</span>' +
              '<span class="tag-stamp ' + cls + '">' + (cls === "high" ? "Review soon" : "Review") + "</span></div>";
          }
          return '<div class="concept-row"><span class="concept-name">' + escapeHtml(c.tag) + '</span>' +
            '<span class="tag-stamp filed">Mastered</span></div>';
        }).join("") + "</div>" +
        '<div class="section-heading">Question-by-question</div>' +
        '<div class="feedback-list">' + (sub.graded || []).map(function (g, i) {
          var open = !!state.openFeedback[i];
          return (
            '<div class="feedback-item">' +
              '<button class="feedback-toggle" data-action="toggle-feedback" data-index="' + i + '">' +
                '<span><span class="feedback-icon ' + (g.isCorrect ? "correct" : "incorrect") + '">' + (g.isCorrect ? "\u2713" : "\u2717") + "</span> " +
                escapeHtml(g.question) + "</span>" +
                '<span>' + (open ? "\u2212" : "+") + "</span>" +
              "</button>" +
              (open
                ? '<div class="feedback-detail">' +
                    "<p><strong>Your answer:</strong> " + escapeHtml(g.studentAnswer || "(blank)") + "</p>" +
                    "<p><strong>Correct answer:</strong> " + escapeHtml(g.correctAnswer) + "</p>" +
                    "<p><strong>Feedback:</strong> " + escapeHtml(g.feedback) + "</p>" +
                  "</div>"
                : "") +
            "</div>"
          );
        }).join("") + "</div>" +
        '<div class="btn-row is-end">' +
          '<button class="btn btn-ghost" data-action="go-entry">Study something new</button>' +
          (hasWeak ? '<button class="btn btn-stamp" data-action="go-reteach">Re-teach my weak areas</button>' : "") +
        "</div>" +
      "</div>"
    );
  }

  function reteachHtml() {
    var lessons = state.reteachLessons || [];
    return (
      '<div class="card">' +
        '<div class="card-eyebrow"><span>' + escapeHtml(state.topic) + '</span><span>Re-teach</span></div>' +
        '<h1 class="card-title">Targeted review</h1>' +
        lessons.map(function (l, i) {
          var revealed = !!state.revealedMini[i];
          return (
            '<div class="reteach-block">' +
              '<div class="section-heading">' + escapeHtml(l.concept || "Concept") + "</div>" +
              '<div class="card-body"><p>' + escapeHtml(l.explanation) + "</p></div>" +
              (l.example ? '<div class="section-heading">Example</div><div class="card-body"><p>' + escapeHtml(l.example) + "</p></div>" : "") +
              '<div class="mini-question">' +
                "<strong>Quick check:</strong> " + escapeHtml(l.miniQuestion) +
                (revealed
                  ? '<div class="mini-answer">' + escapeHtml(l.miniAnswer) + "</div>"
                  : '<div class="btn-row"><button class="btn btn-ghost" data-action="reveal-mini" data-index="' + i + '">Reveal answer</button></div>') +
              "</div>" +
            "</div>"
          );
        }).join("") +
        '<div class="btn-row is-end">' +
          '<button class="btn btn-ghost" data-action="go-results">Back to results</button>' +
          '<button class="btn btn-stamp" data-action="go-recall">Check the review queue</button>' +
        "</div>" +
      "</div>"
    );
  }

  function recallHtml() {
    var due = state.recallDue || [];
    return (
      '<div class="card">' +
        '<div class="card-eyebrow"><span>Review queue</span><span>' + due.length + " due</span></div>" +
        '<h1 class="card-title">' + (due.length ? "Due for review" : "All caught up") + "</h1>" +
        (due.length
          ? due.map(function (item) { return recallItemHtml(item); }).join("")
          : '<div class="empty-state">Nothing\u2019s due right now \u2014 the first review after an exam lands 1\u20132 days out. Come back then.</div>') +
        (due.length ? boxTrackHtml() : "") +
        '<div class="btn-row is-end"><button class="btn btn-ghost" data-action="go-entry">Study something new</button></div>' +
      "</div>"
    );
  }

  function recallItemHtml(item) {
    var revealed = !!state.recallRevealed[item.id];
    var reteach = item.reteach;
    return (
      '<div class="reteach-block recall-item" data-recall-id="' + item.id + '">' +
        '<div class="section-heading">' + escapeHtml(item.concept_tag) + " \u2014 due " + daysFromNow(item.due_at) + "</div>" +
        '<div class="card-body"><p>' + escapeHtml(item.diagnosis) + "</p></div>" +
        (reteach
          ? (revealed
              ? '<div class="recall-refresher"><strong>' + escapeHtml(reteach.miniQuestion || "") + "</strong><div class=\"mini-answer\">" + escapeHtml(reteach.miniAnswer || "") + "</div></div>"
              : '<div class="btn-row"><button class="btn btn-ghost" data-action="reveal-recall" data-id="' + item.id + '">Show a quick refresher</button></div>')
          : "") +
        '<div class="section-heading">How did that go?</div>' +
        '<div class="quality-row">' +
          '<button class="btn-quality q-again" data-action="review-recall" data-id="' + item.id + '" data-quality="' + QUALITY.AGAIN + '">Again</button>' +
          '<button class="btn-quality q-hard" data-action="review-recall" data-id="' + item.id + '" data-quality="' + QUALITY.HARD + '">Hard</button>' +
          '<button class="btn-quality q-good" data-action="review-recall" data-id="' + item.id + '" data-quality="' + QUALITY.GOOD + '">Good</button>' +
          '<button class="btn-quality q-easy" data-action="review-recall" data-id="' + item.id + '" data-quality="' + QUALITY.EASY + '">Easy</button>' +
        "</div>" +
      "</div>"
    );
  }

  function boxTrackHtml() {
    return '<div class="box-track" id="box-track">' + SLOTS.map(function (s) {
      return '<div class="box-slot">' + s.label + "</div>";
    }).join("") + "</div>";
  }

  // --------------------------------------------------------------------
  // Event wiring
  // --------------------------------------------------------------------
  function attachBehaviors() {
    var userInput = document.getElementById("user-input");
    if (userInput) {
      userInput.addEventListener("input", function (e) { state.userInput = e.target.value; });
      userInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); signIn(state.userInput); }
      });
      userInput.focus();
    }

    var topicInput = document.getElementById("topic-input");
    if (topicInput) topicInput.addEventListener("input", function (e) { state.topicInput = e.target.value; });

    var shortAnswer = document.getElementById("short-answer-input");
    if (shortAnswer) {
      shortAnswer.addEventListener("input", function (e) {
        state.answers[e.target.dataset.qid] = e.target.value;
        var dot = APP.querySelector('.exam-dot.is-current');
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

    var dropzone = APP.querySelector(".dropzone");
    if (dropzone) {
      dropzone.addEventListener("dragover", function (e) { e.preventDefault(); dropzone.classList.add("is-drag"); });
      dropzone.addEventListener("dragleave", function () { dropzone.classList.remove("is-drag"); });
      dropzone.addEventListener("drop", function (e) {
        e.preventDefault();
        dropzone.classList.remove("is-drag");
        var f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) { state.pdfFile = f; render(); }
      });
    }
  }

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-action]");
    if (!el) return;
    var action = el.dataset.action;

    switch (action) {
      case "entry-mode":
        state.entryMode = el.dataset.mode;
        render();
        break;
      case "trigger-file": {
        var input = document.getElementById("pdf-file-input");
        if (input) input.click();
        break;
      }
      case "start-topic": startTopicSession(); break;
      case "start-pdf": startPdfSession(); break;
      case "start-exam": generateExam(); break;
      case "select-mcq":
        state.answers[el.dataset.qid] = el.value;
        render();
        break;
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
      case "toggle-feedback": {
        var idx = el.dataset.index;
        state.openFeedback[idx] = !state.openFeedback[idx];
        render();
        break;
      }
      case "go-reteach": generateReteach(); break;
      case "go-results": goto("results"); break;
      case "reveal-mini":
        state.revealedMini[el.dataset.index] = true;
        render();
        break;
      case "reveal-recall":
        state.recallRevealed[el.dataset.id] = true;
        render();
        break;
      case "review-recall":
        reviewRecall(el.dataset.id, Number(el.dataset.quality));
        break;
      case "go-recall": loadRecall(); break;
      case "go-entry": resetToEntry(); break;

      // chrome / navigation
      case "sign-in": signIn(state.userInput); break;
      case "switch-user": signOut(); break;
      case "nav-home": if (state.userId) resetToEntry(); break;
      case "nav-review": if (state.userId) loadRecall(); break;
      case "nav-history": if (state.userId) loadHistory(); break;
      case "resume-session": resumeSession(el.dataset.id, el.dataset.topic); break;
      default: break;
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var el = e.target.closest("[data-action]");
    if (!el || el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "INPUT") return;
    e.preventDefault();
    el.click();
  });

  // --------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------
  (function boot() {
    var saved = null;
    try { saved = localStorage.getItem(USER_KEY); } catch (e) { /* private mode */ }
    if (saved && /^[a-z0-9._-]{3,40}$/.test(saved)) {
      state.userId = saved;
      state.screen = "entry";
      render();
      refreshBadgeOnLoad();
    } else {
      state.screen = "gate";
      render();
    }
  })();
})();
