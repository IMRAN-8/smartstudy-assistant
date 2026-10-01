/**
 * SmartStudy Assistant (SSA)
 * A single Node.js + Express server that:
 *   - serves the web UI (public/index.html)
 *   - exposes the API (explain / exam / grade / diagnose / re-teach / spaced recall)
 *   - talks to an LLM through OpenRouter
 *   - authenticates students securely via Firebase Google Sign-In
 *   - stores everything in Supabase / PostgreSQL
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const OpenAI = require("openai");
const admin = require("firebase-admin");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ dest: "uploads/", limits: { fileSize: 8 * 1024 * 1024 } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false,
});

// ---------------------------------------------------------------------------
// Firebase Admin Initialization (Render Secret File or Local File)
// ---------------------------------------------------------------------------
try {
  const secretPath = fs.existsSync("/etc/secrets/serviceAccountKey.json")
    ? "/etc/secrets/serviceAccountKey.json"
    : path.join(__dirname, "serviceAccountKey.json");

  if (fs.existsSync(secretPath)) {
    const serviceAccount = require(secretPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase Admin initialized successfully from", secretPath);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
    console.log("Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT env var.");
  } else {
    console.warn("Warning: serviceAccountKey.json not found. Token verification will fail until configured.");
  }
} catch (err) {
  console.error("Firebase Admin initialization error:", err.message);
}

// ---------------------------------------------------------------------------
// LLM helper (OpenRouter, OpenAI-compatible)
// ---------------------------------------------------------------------------
function llmClient() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("Missing OPENROUTER_API_KEY");
  return new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  });
}

function parseJson(raw) {
  const text = String(raw || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    return JSON.parse(first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "openai/gpt-oss-20b";
const DEFAULT_MODEL = process.env.LLM_MODEL || "openai/gpt-oss-120b";

const PROVIDER_ROUTING = {
  order: ["Groq", "Cerebras", "DeepInfra"],
  allow_fallbacks: true,
  require_parameters: true,
};

const EFFORT = { generate: "low", grade: "medium" };

const REASONING_MODELS = /gpt-oss|gpt-5|o[34]-|gemini-2\.5|qwen3-.*thinking|deepseek-r/i;
function reasoningFor(model, effort) {
  if (process.env.REASONING_EFFORT === "off") return undefined;
  return REASONING_MODELS.test(model) ? { effort } : undefined;
}

function describeApiError(err) {
  return (
    err?.error?.message ||
    err?.response?.data?.error?.message ||
    err?.message ||
    "unknown upstream error"
  );
}

function explainLlmFailure(status, detail, model) {
  if (status === 401)
    return "The AI provider rejected the API key (401). Check OPENROUTER_API_KEY in your Render environment — it is missing, expired, or was revoked.";
  if (status === 402)
    return "The AI provider refused the request for billing reasons (402). Your OpenRouter account is out of credits or has hit its spend limit.";
  if (status === 403)
    return `The AI provider denied access to "${model}" (403). Your account may need to enable this model or accept its terms.`;
  if (status === 400 || status === 404)
    return `The AI provider does not recognise the model "${model}" (${status}). Fix the LLM_MODEL environment variable — the slug is wrong, deprecated, or no longer offered.`;
  if (status === 429)
    return "The AI provider is rate-limiting this key (429). Wait, slow down requests, or switch to a paid model.";
  return `The AI provider call failed${status ? ` (${status})` : ""}: ${detail}`;
}

const SCHEMAS = {
  explanation: {
    type: "object",
    properties: {
      title: { type: "string" },
      overview: { type: "string" },
      examples: { type: "array", items: { type: "string" } },
      commonMistakes: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
    },
    required: ["title", "overview", "examples", "commonMistakes", "summary"],
    additionalProperties: false,
  },
  assessment: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["mcq", "short"] },
            question: { type: "string" },
            options: { type: "array", items: { type: "string" } },
            correctAnswer: { type: "string" },
            conceptTag: { type: "string" },
            explanation: { type: "string" },
          },
          required: ["type", "question", "options", "correctAnswer", "conceptTag", "explanation"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  grading: {
    type: "object",
    properties: {
      score: { type: "number" },
      isCorrect: { type: "boolean" },
      feedback: { type: "string" },
    },
    required: ["score", "isCorrect", "feedback"],
    additionalProperties: false,
  },
  reteach: {
    type: "object",
    properties: {
      concept: { type: "string" },
      explanation: { type: "string" },
      example: { type: "string" },
      miniQuestion: { type: "string" },
      miniAnswer: { type: "string" },
    },
    required: ["concept", "explanation", "example", "miniQuestion", "miniAnswer"],
    additionalProperties: false,
  },
};

async function generateJson(system, user, opts = {}) {
  const {
    schema,
    schemaName = "response",
    maxTokens = 1800,
    effort = EFFORT.generate,
    model = DEFAULT_MODEL,
    attempt = 1,
  } = opts;

  const client = llmClient();
  let response;
  try {
    response = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      provider: PROVIDER_ROUTING,
      ...(reasoningFor(model, effort) ? { reasoning: reasoningFor(model, effort) } : {}),
      response_format: schema
        ? { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } }
        : { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: typeof user === "string" ? user : JSON.stringify(user) },
      ],
    });
  } catch (apiErr) {
    const status = apiErr?.status || apiErr?.response?.status;
    const isTransient = status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
    const isBadModel = status === 400 || status === 404;

    if (isTransient && attempt < 4) {
      await sleep(500 * Math.pow(2, attempt - 1));
      return generateJson(system, user, { ...opts, attempt: attempt + 1 });
    }
    if ((isTransient || isBadModel) && model !== FALLBACK_MODEL) {
      console.warn(
        `generateJson: model "${model}" failed (status ${status}: ${describeApiError(apiErr)}) — falling back to ${FALLBACK_MODEL}`
      );
      return generateJson(system, user, { ...opts, model: FALLBACK_MODEL, attempt: 1 });
    }
    apiErr.llmStatus = status;
    apiErr.llmModel = model;
    apiErr.llmDetail = describeApiError(apiErr);
    apiErr.userMessage = explainLlmFailure(status, apiErr.llmDetail, model);
    throw apiErr;
  }

  const choice = response.choices?.[0];
  const raw = choice?.message?.content || "";

  if (choice?.finish_reason === "length" && attempt === 1) {
    console.warn(`generateJson: response hit the ${maxTokens}-token ceiling, retrying with more room`);
    return generateJson(system, user, {
      ...opts,
      maxTokens: Math.min(maxTokens * 2, 8000),
      attempt: attempt + 1,
    });
  }

  try {
    return parseJson(raw);
  } catch (parseErr) {
    throw new Error(`LLM returned unparseable JSON (model ${model}): ${parseErr.message}`);
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const PROMPTS = {
  explanation:
    "You are SmartStudy Assistant, an expert teacher writing a concise study guide. Explain the " +
    "given topic or study material clearly enough that a student could learn the essentials with " +
    "no other resource — prioritize the most important points over exhaustive coverage, but every " +
    "sentence must still teach something (no padding or repetition). " +
    "overview: 4-6 sentences covering what the topic is, why it matters, and how its pieces relate. " +
    "examples: 2-3 concrete worked examples, each explained in enough detail to be instructive on " +
    "its own rather than a one-line label. " +
    "commonMistakes: 2-3 specific mistakes, each with why it is wrong and what to do instead. " +
    "summary: 2-3 sentences reinforcing the core takeaway. " +
    "Write plain prose — do not use #, *, -, or other markdown syntax inside any value.",

  assessment:
    "Create an exam from the explanation provided. Make exactly 5 questions of type \"mcq\" and 3 " +
    "of type \"short\", and each question must test ONE specific sub-concept. " +
    "For mcq: give exactly 4 options, and correctAnswer MUST be the verbatim text of one of them. " +
    "Write plausible distractors — wrong options a student who half-understands would actually " +
    "consider, never obvious throwaways. " +
    "For short: options must be an empty array, and correctAnswer is a one-sentence model answer. " +
    "conceptTag is a short sub-concept name. explanation is why the answer is right, under 12 words.",

  grading:
    "You grade a student's short answer fairly. Award credit for correct understanding even when " +
    "the wording differs from the model answer; do not reward confident restatement of the " +
    "question. score is 0.0-1.0, isCorrect is true when score >= 0.7, feedback is one short " +
    "sentence naming the specific gap or confirming what they got right.",

  reteach:
    "Re-teach ONLY the given weak sub-concept to a confused student, briefly. " +
    "explanation: 2-3 sentences giving the correct understanding while addressing the likely point " +
    "of confusion. example: one short concrete example. miniQuestion + miniAnswer: a single quick " +
    "check for understanding. No filler, no restating the question.",
};

function isValidExplanation(e) {
  return (
    !!e &&
    typeof e.title === "string" &&
    e.title.trim().length > 0 &&
    typeof e.overview === "string" &&
    e.overview.trim().length > 0
  );
}

async function generateExplanationWithRetry(input) {
  let lastError = null;

  async function attempt() {
    try {
      return await generateJson(PROMPTS.explanation, input, {
        schema: SCHEMAS.explanation,
        schemaName: "explanation",
        maxTokens: 4096,
      });
    } catch (err) {
      lastError = err;
      console.warn("Explanation generation attempt failed:", err.message);
      return null;
    }
  }

  let explanation = await attempt();
  if (!isValidExplanation(explanation)) {
    console.warn("Explanation came back empty, retrying once");
    explanation = await attempt();
  }
  if (!isValidExplanation(explanation)) {
    if (lastError) throw lastError;
    throw new Error("The AI returned an empty explanation twice in a row. Try again, or switch LLM_MODEL to a stronger model.");
  }
  return explanation;
}

// ---------------------------------------------------------------------------
// Diagnosis + spaced-recall (SM-2) logic
// ---------------------------------------------------------------------------
function diagnoseWeakConcepts(graded) {
  const weak = new Map();
  for (const item of graded) {
    if (item.isCorrect && Number(item.score) >= 0.7) continue;
    const severity = Number(item.score) < 0.4 ? "high" : "medium";
    const existing = weak.get(item.conceptTag);
    if (!existing) {
      weak.set(item.conceptTag, {
        conceptTag: item.conceptTag,
        diagnosis: `The learner struggled with "${item.conceptTag}". ${item.feedback || "Review this sub-concept."}`,
        severity,
      });
    } else if (severity === "high") {
      existing.severity = "high";
    }
  }
  return Array.from(weak.values());
}

function firstDueDate(severity) {
  const due = new Date();
  due.setDate(due.getDate() + (severity === "high" ? 1 : severity === "medium" ? 2 : 4));
  return due;
}

function sm2(prev, quality) {
  let { ease, interval_days: interval, repetitions } = prev;
  ease = Number(ease) || 2.5;
  interval = Number(interval) || 0;
  repetitions = Number(repetitions) || 0;

  if (quality < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * ease);
    repetitions += 1;
  }
  ease = ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (ease < 1.3) ease = 1.3;

  const due = new Date();
  due.setDate(due.getDate() + interval);
  return { ease: Number(ease.toFixed(2)), interval_days: interval, repetitions, due_at: due };
}

function sendFailure(res, err, fallbackMessage) {
  if (isSchemaError(err)) return sendDbFailure(res, err, fallbackMessage);
  const message = err?.userMessage || fallbackMessage;
  const body = { error: message };
  if (err?.llmStatus) body.upstreamStatus = err.llmStatus;
  if (err?.llmModel) body.model = err.llmModel;
  if (err?.llmDetail) body.detail = err.llmDetail;
  return res.status(err?.llmStatus ? 502 : 500).json(body);
}

// ---------------------------------------------------------------------------
// Schema drift error handling
// ---------------------------------------------------------------------------
const SCHEMA_ERROR_CODES = new Set(["42P01", "42703"]);
const SCHEMA_HINT =
  "The database is missing tables or columns this version needs. Run the latest schema.sql " +
  "in Supabase -> SQL Editor, then try again. Visit /api/diag/db to see exactly what is missing.";

function isSchemaError(err) {
  return !!err && SCHEMA_ERROR_CODES.has(err.code);
}

function sendDbFailure(res, err, fallbackMessage) {
  if (isSchemaError(err)) {
    return res.status(503).json({ error: SCHEMA_HINT, detail: `${err.code}: ${err.message}` });
  }
  return res.status(500).json({ error: fallbackMessage });
}

// ---------------------------------------------------------------------------
// Users + Google Firebase Authentication
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ensureUser(userId, displayName) {
  await pool.query(
    `INSERT INTO users(id, display_name) VALUES($1,$2)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW(),
       display_name = COALESCE(EXCLUDED.display_name, users.display_name)`,
    [userId, displayName || null]
  );
}

// Every protected data route sits behind this: verified Google token required
async function requireUser(req, res, next) {
  const authHeader = req.header("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "No authentication token sent. Please sign in with Google." });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userId = decodedToken.uid;
    const displayName = decodedToken.name || (decodedToken.email ? decodedToken.email.split("@")[0] : "Student");

    await ensureUser(userId, displayName);
    req.userId = userId;
    req.userEmail = decodedToken.email;
    next();
  } catch (err) {
    console.error("Auth token verification failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired session. Please sign in again." });
  }
}

async function getOwnedSession(sessionId, userId) {
  if (!UUID_RE.test(String(sessionId || ""))) return null;
  const r = await pool.query("SELECT * FROM study_sessions WHERE id=$1 AND user_id=$2", [
    sessionId,
    userId,
  ]);
  return r.rows[0] || null;
}

const NOT_YOURS = { error: "That study session was not found in your account." };

// ---------------------------------------------------------------------------
// Exam validation
// ---------------------------------------------------------------------------
function validateQuestions(rawQuestions) {
  const kept = [];
  const dropped = [];

  for (const q of rawQuestions || []) {
    const question = String(q.question || "").trim();
    const correct = String(q.correctAnswer ?? "").trim();
    const type = q.type === "mcq" ? "mcq" : "short";

    if (!question || !correct) {
      dropped.push({ question: question || "(blank)", reason: "missing question or answer" });
      continue;
    }

    if (type === "short") {
      kept.push({ ...q, type, question, correctAnswer: correct, options: [] });
      continue;
    }

    const options = (q.options || []).map((o) => String(o).trim()).filter(Boolean);
    if (options.length < 2) {
      dropped.push({ question, reason: `only ${options.length} option(s)` });
      continue;
    }

    const match = options.find((o) => o.toLowerCase() === correct.toLowerCase());
    if (!match) {
      dropped.push({ question, reason: "correctAnswer is not one of the options" });
      continue;
    }

    kept.push({ ...q, type, question, options, correctAnswer: match });
  }

  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Serves Firebase public config from Render environment variables to the frontend
app.get("/api/config/firebase", (_req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
    appId: process.env.FIREBASE_APP_ID || "",
  });
});

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "SmartStudy Assistant" }));

// Diagnostics
app.get("/api/diag/llm", async (_req, res) => {
  const model = DEFAULT_MODEL;
  const keyPresent = Boolean(process.env.OPENROUTER_API_KEY);
  if (!keyPresent) {
    return res.status(503).json({
      ok: false,
      keyPresent: false,
      model,
      error: "OPENROUTER_API_KEY is not set in this environment.",
    });
  }
  try {
    const client = llmClient();
    const r = await client.chat.completions.create({
      model,
      max_tokens: 5,
      provider: PROVIDER_ROUTING,
      ...(reasoningFor(model, EFFORT.generate)
        ? { reasoning: reasoningFor(model, EFFORT.generate) }
        : {}),
      messages: [{ role: "user", content: "ping" }],
    });
    res.json({
      ok: true,
      keyPresent: true,
      model,
      modelUsed: r.model || model,
      servedBy: r.provider || "unknown",
      routing: PROVIDER_ROUTING,
      fallbackModel: FALLBACK_MODEL,
    });
  } catch (err) {
    const status = err?.status || err?.response?.status || null;
    const detail = describeApiError(err);
    res.status(502).json({
      ok: false,
      keyPresent: true,
      model,
      upstreamStatus: status,
      detail,
      error: explainLlmFailure(status, detail, model),
    });
  }
});

app.get("/api/diag/db", async (_req, res) => {
  const REQUIRED = {
    users: ["id", "display_name", "created_at"],
    study_sessions: ["id", "user_id", "topic"],
    recall_schedules: ["id", "user_id", "due_at"],
    questions: ["id", "position", "assessment_id"],
    explanations: ["session_id", "content"],
    assessments: ["session_id"],
    submissions: ["session_id", "score"],
    weak_concepts: ["session_id", "concept_tag"],
    reteach_lessons: ["weak_concept_id", "content"],
  };
  try {
    const r = await pool.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"
    );
    const found = new Map();
    for (const row of r.rows) {
      if (!found.has(row.table_name)) found.set(row.table_name, new Set());
      found.get(row.table_name).add(row.column_name);
    }
    const missing = [];
    for (const [table, columns] of Object.entries(REQUIRED)) {
      if (!found.has(table)) {
        missing.push(`table "${table}" is missing entirely`);
        continue;
      }
      for (const col of columns) {
        if (!found.get(table).has(col)) missing.push(`${table}.${col}`);
      }
    }
    if (missing.length) {
      return res.status(503).json({ ok: false, missing, error: SCHEMA_HINT });
    }
    res.json({ ok: true, message: "Database schema is up to date." });
  } catch (err) {
    console.error("diag/db", err);
    res.status(500).json({ ok: false, error: "Could not reach the database.", detail: err.message });
  }
});

// Profile / Current User
app.get("/api/user", requireUser, async (req, res) => {
  try {
    const r = await pool.query("SELECT id, display_name, created_at FROM users WHERE id=$1", [req.userId]);
    res.json({ user: r.rows[0] });
  } catch (err) {
    console.error("user", err);
    return sendDbFailure(res, err, "Could not load user profile.");
  }
});

// Study history
app.get("/api/sessions", requireUser, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.topic, s.source_type, s.created_at,
              (SELECT ROUND(sub.score * 100) FROM submissions sub
                WHERE sub.session_id = s.id ORDER BY sub.created_at DESC LIMIT 1) AS score,
              (SELECT COUNT(*) FROM weak_concepts wc WHERE wc.session_id = s.id) AS weak_count
         FROM study_sessions s
        WHERE s.user_id = $1
        ORDER BY s.created_at DESC
        LIMIT 50`,
      [req.userId]
    );
    res.json({ sessions: r.rows });
  } catch (err) {
    console.error("sessions", err);
    return sendDbFailure(res, err, "Failed to load your history");
  }
});

// Start session: topic
app.post("/api/session/topic", requireUser, async (req, res) => {
  try {
    const topic = String(req.body.topic || "").trim();
    if (!topic) return res.status(400).json({ error: "Topic is required" });
    const r = await pool.query(
      "INSERT INTO study_sessions(user_id, topic, source_type) VALUES($1,$2,'topic') RETURNING id, topic",
      [req.userId, topic]
    );
    res.status(201).json({ sessionId: r.rows[0].id, topic: r.rows[0].topic });
  } catch (err) {
    console.error("session/topic", err);
    return sendDbFailure(res, err, "Failed to create session");
  }
});

// Start session: PDF
app.post("/api/session/pdf", requireUser, upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required" });
    const pdfParse = require("pdf-parse");
    const buffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(buffer);
    const text = String(data.text || "").replace(/\s+/g, " ").trim();
    if (!text) return res.status(400).json({ error: "Could not read text from that PDF" });
    const topic = String(req.body.topic || req.file.originalname || "PDF Study Session").trim();
    const r = await pool.query(
      "INSERT INTO study_sessions(user_id, topic, source_type, source_text) VALUES($1,$2,'pdf',$3) RETURNING id, topic",
      [req.userId, topic, text.slice(0, 50000)]
    );
    res.status(201).json({ sessionId: r.rows[0].id, topic: r.rows[0].topic });
  } catch (err) {
    console.error("session/pdf", err);
    res.status(500).json({ error: "Failed to process PDF" });
  } finally {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true });
  }
});

// Explanation
app.post("/api/explanation", requireUser, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const session = await getOwnedSession(sessionId, req.userId);
    if (!session) return res.status(404).json(NOT_YOURS);

    const cached = await pool.query(
      "SELECT id, content FROM explanations WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1",
      [sessionId]
    );
    if (cached.rowCount)
      return res.json({ explanationId: cached.rows[0].id, explanation: cached.rows[0].content });

    const input = session.source_text || session.topic;
    const explanation = await generateExplanationWithRetry(input);
    const saved = await pool.query(
      "INSERT INTO explanations(session_id, content) VALUES($1,$2) RETURNING id, content",
      [sessionId, explanation]
    );
    res.json({ explanationId: saved.rows[0].id, explanation: saved.rows[0].content });
  } catch (err) {
    console.error("explanation", err);
    return sendFailure(res, err, "Failed to generate explanation");
  }
});

// Assessment
app.post("/api/assessment", requireUser, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const session = await getOwnedSession(sessionId, req.userId);
    if (!session) return res.status(404).json(NOT_YOURS);

    const ex = await pool.query(
      "SELECT content FROM explanations WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1",
      [sessionId]
    );
    if (!ex.rowCount) return res.status(404).json({ error: "Generate an explanation first" });

    const a = await pool.query("INSERT INTO assessments(session_id) VALUES($1) RETURNING id", [sessionId]);
    const assessmentId = a.rows[0].id;
    const scrap = async () => pool.query("DELETE FROM assessments WHERE id=$1", [assessmentId]);

    let generated;
    try {
      generated = await generateJson(PROMPTS.assessment, ex.rows[0].content, {
        schema: SCHEMAS.assessment,
        schemaName: "assessment",
        maxTokens: 4096,
      });
    } catch (genErr) {
      await scrap();
      throw genErr;
    }

    const { kept, dropped } = validateQuestions(generated.questions);
    if (dropped.length) {
      console.warn(
        `assessment ${assessmentId}: dropped ${dropped.length} invalid question(s):`,
        dropped.map((d) => `${d.reason} — "${d.question.slice(0, 60)}"`)
      );
    }
    if (!kept.length) {
      await scrap();
      return res.status(502).json({
        error: "The AI returned an unusable exam. Please try again.",
        detail: dropped.length ? dropped[0].reason : "no questions generated",
      });
    }

    for (let i = 0; i < kept.length; i++) {
      const q = kept[i];
      await pool.query(
        `INSERT INTO questions(assessment_id, position, question_type, question_text, options, correct_answer, concept_tag, explanation)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          assessmentId,
          i,
          q.type,
          q.question,
          q.options && q.options.length ? JSON.stringify(q.options) : null,
          q.correctAnswer,
          q.conceptTag || "General",
          q.explanation || "",
        ]
      );
    }

    const questions = await pool.query(
      "SELECT id, question_type, question_text, options FROM questions WHERE assessment_id=$1 ORDER BY position",
      [assessmentId]
    );
    res.status(201).json({ assessmentId, questions: questions.rows, droppedQuestions: dropped.length });
  } catch (err) {
    console.error("assessment", err);
    return sendFailure(res, err, "Failed to generate exam");
  }
});

// Submit answers -> grade, diagnose weak concepts, schedule spaced recall
app.post("/api/submit", requireUser, async (req, res) => {
  try {
    const { assessmentId, answers = [] } = req.body;
    if (!assessmentId) return res.status(400).json({ error: "assessmentId is required" });
    if (!UUID_RE.test(String(assessmentId))) return res.status(404).json({ error: "Exam not found" });

    const qRows = await pool.query(
      `SELECT q.*, a.session_id FROM questions q
         JOIN assessments a ON a.id = q.assessment_id
         JOIN study_sessions s ON s.id = a.session_id
        WHERE q.assessment_id = $1 AND s.user_id = $2
        ORDER BY q.position`,
      [assessmentId, req.userId]
    );
    if (!qRows.rowCount) return res.status(404).json({ error: "Exam not found in your account" });

    const answerMap = new Map(answers.map((x) => [x.questionId, String(x.answer || "").trim()]));

    // Parallelize grading for fast responses
    const graded = await Promise.all(
      qRows.rows.map(async (q) => {
        const studentAnswer = answerMap.get(q.id) || "";
        let result;
        if (q.question_type === "mcq") {
          const correct = studentAnswer.toLowerCase() === String(q.correct_answer).trim().toLowerCase();
          result = {
            score: correct ? 1 : 0,
            isCorrect: correct,
            feedback: correct ? "Correct." : `Correct answer: ${q.correct_answer}`,
          };
        } else {
          result = await generateJson(
            PROMPTS.grading,
            { question: q.question_text, correctAnswer: q.correct_answer, studentAnswer },
            {
              schema: SCHEMAS.grading,
              schemaName: "grading",
              effort: EFFORT.grade,
              maxTokens: 800,
            }
          );
        }
        return {
          questionId: q.id,
          question: q.question_text,
          conceptTag: q.concept_tag,
          correctAnswer: q.correct_answer,
          studentAnswer,
          ...result,
        };
      })
    );

    const sessionId = qRows.rows[0].session_id;
    const score = graded.length
      ? graded.reduce((sum, x) => sum + Number(x.score || 0), 0) / graded.length
      : 0;

    const sub = await pool.query(
      "INSERT INTO submissions(assessment_id, session_id, score) VALUES($1,$2,$3) RETURNING id",
      [assessmentId, sessionId, score]
    );
    for (const g of graded) {
      await pool.query(
        "INSERT INTO answers(submission_id, question_id, student_answer, is_correct, score, feedback) VALUES($1,$2,$3,$4,$5,$6)",
        [sub.rows[0].id, g.questionId, g.studentAnswer, g.isCorrect, g.score, g.feedback]
      );
    }

    const weak = diagnoseWeakConcepts(graded);
    for (const w of weak) {
      const savedWeak = await pool.query(
        "INSERT INTO weak_concepts(session_id, concept_tag, diagnosis, severity) VALUES($1,$2,$3,$4) RETURNING id",
        [sessionId, w.conceptTag, w.diagnosis, w.severity]
      );
      await pool.query(
        "INSERT INTO recall_schedules(user_id, weak_concept_id, session_id, concept_tag, due_at) VALUES($1,$2,$3,$4,$5)",
        [req.userId, savedWeak.rows[0].id, sessionId, w.conceptTag, firstDueDate(w.severity)]
      );
    }

    res.status(201).json({
      submissionId: sub.rows[0].id,
      score: Math.round(score * 100),
      graded,
      weakConcepts: weak,
    });
  } catch (err) {
    console.error("submit", err);
    return sendFailure(res, err, "Failed to grade exam");
  }
});

// Re-teach lessons
app.post("/api/reteach", requireUser, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const session = await getOwnedSession(sessionId, req.userId);
    if (!session) return res.status(404).json(NOT_YOURS);

    const weak = await pool.query(
      "SELECT * FROM weak_concepts WHERE session_id=$1 ORDER BY created_at DESC",
      [sessionId]
    );

    const lessons = await Promise.all(
      weak.rows.map(async (c) => {
        const existing = await pool.query(
          "SELECT content FROM reteach_lessons WHERE weak_concept_id=$1 LIMIT 1",
          [c.id]
        );
        if (existing.rowCount) return existing.rows[0].content;

        const lesson = await generateJson(
          PROMPTS.reteach,
          { conceptTag: c.concept_tag, diagnosis: c.diagnosis },
          { schema: SCHEMAS.reteach, schemaName: "reteach", maxTokens: 700 }
        );
        await pool.query("INSERT INTO reteach_lessons(weak_concept_id, content) VALUES($1,$2)", [
          c.id,
          lesson,
        ]);
        return lesson;
      })
    );

    res.json({ lessons });
  } catch (err) {
    console.error("reteach", err);
    return sendFailure(res, err, "Failed to generate re-teaching");
  }
});

// Spaced-recall due items
app.get("/api/recall/due", requireUser, async (req, res) => {
  try {
    const due = await pool.query(
      `SELECT rs.id, rs.concept_tag, rs.due_at, rs.repetitions, rs.interval_days,
              wc.diagnosis, wc.severity,
              (SELECT content FROM reteach_lessons WHERE weak_concept_id = wc.id LIMIT 1) AS reteach
       FROM recall_schedules rs
       JOIN weak_concepts wc ON wc.id = rs.weak_concept_id
       WHERE rs.user_id = $1 AND rs.due_at <= NOW()
       ORDER BY rs.due_at ASC`,
      [req.userId]
    );
    res.json({ due: due.rows });
  } catch (err) {
    console.error("recall/due", err);
    return sendDbFailure(res, err, "Failed to load recall items");
  }
});

// Review recall item
app.post("/api/recall/:id/review", requireUser, async (req, res) => {
  try {
    const quality = Number(req.body.quality);
    if (![2, 3, 4, 5].includes(quality))
      return res.status(400).json({ error: "quality must be 2, 3, 4 or 5" });
    if (!UUID_RE.test(String(req.params.id)))
      return res.status(404).json({ error: "Recall item not found" });

    const cur = await pool.query("SELECT * FROM recall_schedules WHERE id=$1 AND user_id=$2", [
      req.params.id,
      req.userId,
    ]);
    if (!cur.rowCount) return res.status(404).json({ error: "Recall item not found in your account" });

    const next = sm2(cur.rows[0], quality);
    const updated = await pool.query(
      `UPDATE recall_schedules
       SET ease=$1, interval_days=$2, repetitions=$3, due_at=$4, last_reviewed_at=NOW()
       WHERE id=$5 AND user_id=$6 RETURNING *`,
      [next.ease, next.interval_days, next.repetitions, next.due_at, req.params.id, req.userId]
    );
    res.json({ recall: updated.rows[0] });
  } catch (err) {
    console.error("recall/review", err);
    return sendDbFailure(res, err, "Failed to update recall item");
  }
});

// Fallback: serve UI
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`SmartStudy Assistant running on port ${PORT}`));
