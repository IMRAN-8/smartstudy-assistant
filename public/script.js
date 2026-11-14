const CURATED_SYLLABUS = [
  {
    domain: "Computer Science",
    topic: "Asymptotic Complexity & Dynamic Programming Memoization",
    meta: "Recurrence relations · Master Theorem · Optimal substructure"
  },
  {
    domain: "Molecular Biology",
    topic: "Photosynthetic Light-Dependent Reactions & ATP Synthase",
    meta: "Z-scheme electron transport · Chemiosmosis · Calvin cycle coupling"
  },
  {
    domain: "Macroeconomics",
    topic: "Monetary Transmission & Taylor Rule Interest Rate Dynamics",
    meta: "Central bank policy · Liquidity traps · Real vs. nominal rates"
  },
  {
    domain: "Linear Algebra",
    topic: "Spectral Decomposition, Eigenvalues & Singular Value Decomposition",
    meta: "Orthogonal projections · Low-rank matrix approximation"
  }
];

const state = {
  user: null,
  authReady: false,
  view: "home", // home | lesson | exam | results | reteach | review | history | about
  inputMode: "topic", // topic | pdf
  topicDraft: "",
  pdfFile: null,
  loading: false,
  error: "",
  session: null,
  answers: {},
  grading: null,
  reteachContent: null,
  reviewDue: [],
  reviewIndex: 0,
  reviewRevealed: false,
  history: []
};

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (window.FirebaseAuth && window.FirebaseAuth.currentUser) {
    const token = await window.FirebaseAuth.currentUser.getIdToken();
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function initAuth() {
  try {
    const cfg = await fetch("/api/config/firebase").then(r => r.json());
    if (cfg && cfg.apiKey && window.firebase) {
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      window.FirebaseAuth = firebase.auth();
      window.FirebaseAuth.onAuthStateChanged(async (user) => {
        state.user = user;
        state.authReady = true;
        if (user) {
          await Promise.all([loadReviewQueue(), loadHistory()]);
        }
        render();
      });
      return;
    }
  } catch (e) {
    console.warn("Firebase config unavailable, running in guest mode:", e);
  }
  state.authReady = true;
  render();
}

async function loadReviewQueue() {
  try {
    const data = await api("/api/review/due");
    state.reviewDue = data.cards || data.items || [];
  } catch (_) {}
}

async function loadHistory() {
  try {
    const data = await api("/api/sessions");
    state.history = data.sessions || data || [];
  } catch (_) {}
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTopBar() {
  const dueCount = state.reviewDue.length;
  return `
    <header class="topbar">
      <div class="brand" data-action="nav" data-view="home">
        <div class="brand-mark">S</div>
        <div>
          <div class="brand-title">SmartStudy</div>
          <div class="brand-sub">explained · diagnosed · retained</div>
        </div>
      </div>

      <nav class="nav-cluster">
        <button class="nav-tab ${state.view === "home" ? "active" : ""}" data-action="nav" data-view="home">
          Workspace
        </button>
        <button class="nav-tab ${state.view === "review" ? "active" : ""}" data-action="nav" data-view="review">
          Review
          ${dueCount > 0 ? `<span class="nav-count tabular-nums">${dueCount}</span>` : ""}
        </button>
        <button class="nav-tab ${state.view === "history" ? "active" : ""}" data-action="nav" data-view="history">
          History
        </button>
        <button class="nav-tab ${state.view === "about" ? "active" : ""}" data-action="nav" data-view="about">
          About &amp; System
        </button>
      </nav>

      <div class="user-cluster">
        ${state.user ? `
          <div class="user-pill">
            ${state.user.photoURL
              ? `<img class="user-avatar" src="${escapeHtml(state.user.photoURL)}" alt="" />`
              : `<div class="user-avatar">${escapeHtml((state.user.displayName || "U")[0])}</div>`
            }
            <span class="user-name">${escapeHtml(state.user.displayName || state.user.email)}</span>
            <button class="btn-signout" data-action="signout">Sign out</button>
          </div>
        ` : `
          <button class="btn-secondary" data-action="signin">Sign in with Google</button>
        `}
      </div>
    </header>
  `;
}

function renderHome() {
  const dueCount = state.reviewDue.length;
  const completedCount = state.history.length;
  const dateLabel = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();

  return `
    <main class="studio-container">
      <div class="editorial-header">
        <div class="editorial-kicker">Academic Mastery Studio</div>
        <h1 class="editorial-title">What concept are we mastering today?</h1>
        <p class="editorial-subtitle">
          Structured first-principles synthesis, diagnostic comprehension testing, targeted gap remediation, and SM-2 spaced recall.
        </p>
      </div>

      <div class="retention-strip tabular-nums">
        <span class="retention-metric">
          <span class="status-dot"></span>
          <span>Due for Recall: <strong class="retention-value">${dueCount}</strong></span>
        </span>
        <span class="retention-sep">·</span>
        <span class="retention-metric">
          <span>Archive Sessions: <strong class="retention-value">${completedCount}</strong></span>
        </span>
        ${dueCount > 0 ? `
          <span class="retention-sep">·</span>
          <button class="retention-action" data-action="nav" data-view="review">
            Start Recall Queue →
          </button>
        ` : ""}
      </div>

      <section class="command-card">
        <div class="command-top">
          <div class="mode-switch">
            <button class="mode-btn ${state.inputMode === "topic" ? "active" : ""}" data-action="set-mode" data-mode="topic">
              Topic Study
            </button>
            <button class="mode-btn ${state.inputMode === "pdf" ? "active" : ""}" data-action="set-mode" data-mode="pdf">
              Upload a PDF
            </button>
          </div>
          <span class="session-date tabular-nums">NEW SESSION · ${dateLabel}</span>
        </div>

        ${state.inputMode === "topic" ? `
          <label class="field-label" for="topic-input">Topic or Research Question</label>
          <input
            id="topic-input"
            class="topic-input"
            type="text"
            placeholder="e.g. Photosynthesis, the French Revolution, Big-O notation..."
            value="${escapeHtml(state.topicDraft)}"
          />
        ` : `
          <label class="field-label">Lecture Notes or Research Paper (PDF)</label>
          <label class="pdf-dropzone" for="pdf-file-input">
            <div style="font-weight:500;color:var(--text-primary);margin-bottom:4px;">
              ${state.pdfFile ? escapeHtml(state.pdfFile.name) : "Click to select a PDF document"}
            </div>
            <div style="font-size:12px;color:var(--text-secondary);">
              Extracts core concepts, builds a structured lesson, and generates a diagnostic exam
            </div>
            <input id="pdf-file-input" type="file" accept="application/pdf" style="display:none" />
          </label>
        `}

        ${state.error ? `<p style="color:var(--crimson);font-size:13px;margin-top:12px;">${escapeHtml(state.error)}</p>` : ""}

        <div class="command-footer">
          <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">
            5-STAGE PIPELINE · EXPLAIN → EXAMINE → DIAGNOSE → RE-TEACH → RECALL
          </span>
          <button class="btn-gold" data-action="start-session" ${state.loading ? "disabled" : ""}>
            ${state.loading ? "Synthesizing Session..." : "Start Studying →"}
          </button>
        </div>
      </section>

      <section>
        <div class="section-head">
          <span class="section-kicker">Curated Academic Syllabi</span>
          <span class="section-hint">Select a track to populate studio</span>
        </div>
        <div class="bento-grid">
          ${CURATED_SYLLABUS.map((item, idx) => `
            <button class="bento-card" data-action="pick-syllabus" data-idx="${idx}">
              <div class="bento-domain">${escapeHtml(item.domain)}</div>
              <div class="bento-title">${escapeHtml(item.topic)}</div>
              <div class="bento-meta">${escapeHtml(item.meta)}</div>
            </button>
          `).join("")}
        </div>
      </section>
    </main>
  `;
}

function renderAbout() {
  return `
    <div class="about-grid">
      <section class="workspace-panel" style="margin:0;">
        <div class="panel-kicker">Creator &amp; Lead Engineer</div>
        <h2 class="panel-title">Imran Hosen</h2>
        <p style="color:var(--text-secondary);font-size:14px;margin-bottom:16px;">
          Full-Stack AI Engineer &amp; Systems Architect focused on high-retention cognitive learning systems, diagnostic assessment pipelines, and resilient cloud backends.
        </p>
        <div class="creator-links">
          <a class="creator-link" href="https://imran-8.github.io/" target="_blank" rel="noopener noreferrer">
            Portfolio · imran-8.github.io ↗
          </a>
          <a class="creator-link" href="https://github.com/imran-8" target="_blank" rel="noopener noreferrer">
            GitHub · github.com/imran-8 ↗
          </a>
          <a class="creator-link" href="mailto:shahriarimran3315@gmail.com">
            shahriarimran3315@gmail.com
          </a>
        </div>
      </section>

      <section class="workspace-panel" style="margin:0;">
        <div class="panel-kicker">System Architecture</div>
        <h2 class="panel-title">5-Stage Mastery Engine</h2>
        <div class="pipeline-step">
          <div class="pipeline-step-title">01 · EXPLAIN</div>
          <div style="font-size:13px;color:var(--text-secondary);">First-principles synthesis from any topic or uploaded PDF.</div>
        </div>
        <div class="pipeline-step">
          <div class="pipeline-step-title">02 · EXAMINE</div>
          <div style="font-size:13px;color:var(--text-secondary);">Mixed-format diagnostic exam (MCQ, short answer, deep transfer).</div>
        </div>
        <div class="pipeline-step">
          <div class="pipeline-step-title">03 · DIAGNOSE &amp; 04 · RE-TEACH</div>
          <div style="font-size:13px;color:var(--text-secondary);">Pinpoints conceptual gaps and rebuilds weak sub-skills with fresh analogies.</div>
        </div>
        <div class="pipeline-step">
          <div class="pipeline-step-title">05 · SPACED RECALL</div>
          <div style="font-size:13px;color:var(--text-secondary);">SM-2 interval scheduling persisted in Supabase PostgreSQL + Firebase Auth.</div>
        </div>
      </section>
    </div>
  `;
}

function render() {
  const root = document.getElementById("app");
  if (!root) return;

  let bodyHtml = "";
  if (state.view === "home") bodyHtml = renderHome();
  else if (state.view === "about") bodyHtml = renderAbout();
  else if (state.view === "history") {
    bodyHtml = `
      <section class="workspace-panel">
        <div class="panel-kicker">Session Archive</div>
        <h2 class="panel-title">Study History</h2>
        ${state.history.length === 0
          ? `<p style="color:var(--text-secondary);font-size:14px;">No archived sessions yet. Start a topic on the Workspace tab.</p>`
          : state.history.map(s => `
            <div class="q-block" style="display:flex;justify-content:space-between;align-items:center;">
              <div>
                <div style="font-weight:600;color:var(--text-primary);">${escapeHtml(s.topic || s.title)}</div>
                <div style="font-size:12px;color:var(--text-secondary);">${escapeHtml(s.created_at || "")}</div>
              </div>
              <span class="nav-count tabular-nums">${s.score != null ? `${s.score}%` : "Completed"}</span>
            </div>
          `).join("")
        }
      </section>
    `;
  } else if (state.view === "review") {
    const card = state.reviewDue[state.reviewIndex];
    bodyHtml = `
      <section class="workspace-panel">
        <div class="panel-kicker">SM-2 Spaced Repetition</div>
        <h2 class="panel-title">Recall Queue</h2>
        ${!card
          ? `<p style="color:var(--text-secondary);font-size:14px;">All caught up! Zero cards due right now.</p>`
          : `
            <div class="q-block">
              <div class="q-meta">CARD ${state.reviewIndex + 1} OF ${state.reviewDue.length}</div>
              <div class="q-prompt">${escapeHtml(card.front || card.question)}</div>
              ${state.reviewRevealed ? `
                <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border-hairline);color:var(--text-secondary);">
                  ${escapeHtml(card.back || card.answer)}
                </div>
              ` : `
                <button class="btn-secondary" data-action="reveal-card">Reveal Answer</button>
              `}
            </div>
          `
        }
      </section>
    `;
  }

  root.innerHTML = `
    <div class="app-shell">
      ${renderTopBar()}
      ${bodyHtml}
      <footer class="studio-footer">
        SmartStudy Assistant · explain → examine → diagnose → re-teach → recall
      </footer>
    </div>
  `;

  const topicEl = document.getElementById("topic-input");
  if (topicEl) {
    topicEl.addEventListener("input", (e) => {
      state.topicDraft = e.target.value;
    });
  }
  const pdfEl = document.getElementById("pdf-file-input");
  if (pdfEl) {
    pdfEl.addEventListener("change", (e) => {
      state.pdfFile = e.target.files[0] || null;
      render();
    });
  }
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;

  switch (action) {
    case "nav":
      state.view = btn.dataset.view;
      state.error = "";
      render();
      break;

    case "set-mode":
      state.inputMode = btn.dataset.mode;
      state.error = "";
      render();
      break;

    case "pick-syllabus": {
      const item = CURATED_SYLLABUS[Number(btn.dataset.idx)];
      if (item) {
        state.inputMode = "topic";
        state.topicDraft = item.topic;
        render();
        const input = document.getElementById("topic-input");
        if (input) input.focus();
      }
      break;
    }

    case "select-mcq": {
      // Smooth DOM-only selection update so the exam view never blinks
      const qid = btn.dataset.qid;
      const opt = btn.dataset.opt;
      state.answers[qid] = opt;
      const container = btn.closest(".mcq-list");
      if (container) {
        container.querySelectorAll(".mcq-option").forEach(el => {
          el.classList.toggle("selected", el.dataset.opt === opt);
        });
      }
      break;
    }

    case "reveal-card":
      state.reviewRevealed = true;
      render();
      break;

    case "signin":
      if (window.FirebaseAuth && window.firebase) {
        const provider = new firebase.auth.GoogleAuthProvider();
        await window.FirebaseAuth.signInWithPopup(provider);
      }
      break;

    case "signout":
      if (window.FirebaseAuth) {
        await window.FirebaseAuth.signOut();
      }
      break;
  }
});

initAuth();