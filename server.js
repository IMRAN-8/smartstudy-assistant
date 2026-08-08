/**
 * SmartStudy Assistant (SSA)
 * A single Node.js + Express server that:
 *   - serves the web UI (public/index.html)
 *   - exposes the API (explain / exam / grade / diagnose / re-teach / spaced recall)
 *   - talks to an LLM through OpenRouter
 *   - stores everything in Supabase / PostgreSQL
 *
 * Everything lives in this one file to keep the project simple.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const OpenAI = require("openai");

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
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

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

// With strict JSON schemas the provider constrains decoding, so the response
// is already a bare JSON object. This is just a seatbelt for the rare case a
// fallback provider wraps it in markdown fences.
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

// Used if the primary model (LLM_MODEL) keeps failing with a transient
// error through all its retries — a smaller sibling that speaks the exact
// same prompts and schemas, so the request still succeeds instead of dying.
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "openai/gpt-oss-20b";
const DEFAULT_MODEL = process.env.LLM_MODEL || "openai/gpt-oss-120b";

// Provider routing. The SAME model runs at wildly different speeds depending
// on who hosts it — for gpt-oss-120b it ranges from 23 tps to 448 tps, so
// leaving this to price-based default routing can make a 2s call take 30s.
//
// Every provider listed here was checked to support response_format +
// structured_outputs. Amazon Bedrock and SambaNova are fast but do NOT, so
// they are deliberately excluded — routing there would silently break JSON
// mode. require_parameters is the belt-and-braces version of that check: it
// tells OpenRouter to skip any provider that can't honour the parameters we
// send, rather than quietly ignoring them.
const PROVIDER_ROUTING = {
  order: ["Groq", "Cerebras", "DeepInfra"],
  allow_fallbacks: true,
  require_parameters: true,
};

// gpt-oss models expose a reasoning budget. Schema-shaped generation needs
// almost none of it, so "low" keeps latency and token spend down. Grading a
// free-text answer is the one place judgement actually matters.
const EFFORT = { generate: "low", grade: "medium" };

// Only reasoning-capable models accept a reasoning budget. Sending one to a
// model that doesn't (e.g. Granite) combined with require_parameters would
// leave ZERO eligible providers and fail the request — so gate it on the
// model. Set REASONING_EFFORT=off to disable entirely.
const REASONING_MODELS = /gpt-oss|gpt-5|o[34]-|gemini-2\.5|qwen3-.*thinking|deepseek-r/i;
function reasoningFor(model, effort) {
  if (process.env.REASONING_EFFORT === "off") return undefined;
  return REASONING_MODELS.test(model) ? { effort } : undefined;
}


// Pull the human-readable reason out of an OpenRouter/OpenAI SDK error.
function describeApiError(err) {
  return (
    err?.error?.message ||
    err?.response?.data?.error?.message ||
    err?.message ||
    "unknown upstream error"
  );
}

// Turn an upstream status into a message that says what to actually fix.
// These are the four ways this app dies in production, in order of likelihood.
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

// Strict output schemas. These are what let us stop *asking* for JSON and
// start *guaranteeing* it — the provider constrains token selection to the
// shape below, so malformed or reshaped output is no longer a failure mode.
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
            // Always an array — empty for short-answer. A nullable union here
            // would be rejected by some providers' schema engines.
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

/**
 * Call the LLM and get back a parsed object matching `schema`.
 *
 * opts: { schema, schemaName, maxTokens, effort, model, attempt }
 */
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
      // Pin to fast, schema-capable providers instead of taking whatever
      // price-sorted routing hands us.
      provider: PROVIDER_ROUTING,
      // Keep the reasoning budget small for shape-constrained generation.
      // Omitted entirely for models that don't support it.
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
    // Transient upstream issues (rate limits, provider hiccups, timeouts) —
    // worth a short backoff and retry rather than failing the whole request.
    const status = apiErr?.status || apiErr?.response?.status;
    const isTransient = status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
    // A model that OpenRouter rejects outright (unknown slug, deprecated
    // ":free" variant, not enabled for this account) fails instantly with
    // 400/404. Retrying the same model is pointless, but the fallback model
    // is a different slug and usually works — so fall back on these too.
    const isBadModel = status === 400 || status === 404;

    if (isTransient && attempt < 4) {
      await sleep(500 * Math.pow(2, attempt - 1)); // 0.5s, 1s, 2s
      return generateJson(system, user, { ...opts, attempt: attempt + 1 });
    }
    // Retries exhausted (or the model itself is unusable). If we weren't
    // already on the fallback, try it once before giving up entirely.
    if ((isTransient || isBadModel) && model !== FALLBACK_MODEL) {
      console.warn(
        `generateJson: model "${model}" failed (status ${status}: ${describeApiError(apiErr)}) — falling back to ${FALLBACK_MODEL}`
      );
      return generateJson(system, user, { ...opts, model: FALLBACK_MODEL, attempt: 1 });
    }
    // Nothing left to try. Re-throw with the upstream reason attached so the
    // route can log it AND report something actionable to the client.
    apiErr.llmStatus = status;
    apiErr.llmModel = model;
    apiErr.llmDetail = describeApiError(apiErr);
    apiErr.userMessage = explainLlmFailure(status, apiErr.llmDetail, model);
    throw apiErr;
  }

  const choice = response.choices?.[0];
  const raw = choice?.message?.content || "";

  // The schema guarantees shape, but it cannot guarantee the response had
  // room to finish. A hard token cut-off is the one remaining way to get
  // unparseable output, so retry that case once with more headroom.
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
  // Note: output shape is enforced by SCHEMAS, not by these prompts. They only
  // carry teaching intent — what makes the content *good*, not what makes it
  // parseable.
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

// The schema guarantees the keys exist; this only checks they carry content.
function isValidExplanation(e) {
  return (
    !!e &&
    typeof e.title === "string" &&
    e.title.trim().length > 0 &&
    typeof e.overview === "string" &&
    e.overview.trim().length > 0
  );
}

// Generate an explanation. Shape is now enforced by the JSON schema, so the
// only thing left to guard against is a technically-valid-but-empty response.
async function generateExplanationWithRetry(input) {
  // Remember why an attempt failed — swallowing this is what previously hid
  // the actual cause (bad key / no credits / bad model) from logs and UI.
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
    if (lastError) throw lastError; // real upstream reason beats a generic message
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

// First review interval based on how badly the concept was missed.
function firstDueDate(severity) {
  const due = new Date();
  due.setDate(due.getDate() + (severity === "high" ? 1 : severity === "medium" ? 2 : 4));
  return due;
}

// SM-2 update. quality: 2=Again, 3=Hard, 4=Good, 5=Easy.
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


// Send a failure response that keeps the actionable reason instead of
// flattening every problem into one generic string.
function sendFailure(res, err, fallbackMessage) {
  const message = err?.userMessage || fallbackMessage;
  const body = { error: message };
  if (err?.llmStatus) body.upstreamStatus = err.llmStatus;
  if (err?.llmModel) body.model = err.llmModel;
  if (err?.llmDetail) body.detail = err.llmDetail;
  // 502: this server is fine, the upstream AI provider is what failed.
  return res.status(err?.llmStatus ? 502 : 500).json(body);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "SmartStudy Assistant" }));

// Diagnostic: proves in one request whether the AI provider is reachable and
// configured, and reports the provider's own error text if it is not.
// Never returns the key itself — only whether one is present.
app.get("/api/diag/llm", async (_req, res) => {
  const model = DEFAULT_MODEL;
  const keyPresent = Boolean(process.env.OPENROUTER_API_KEY);
  if (!keyPresent) {
    return res.status(503).json({
      ok: false,
      keyPresent: false,
      model,
      error: "OPENROUTER_API_KEY is not set in this environment. Add it in Render -> Environment and redeploy.",
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
      // Which host actually served this — the whole point of pinning. If this
      // is not one of the providers below, routing is not being honoured.
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

// Start a session from a typed topic
app.post("/api/session/topic", async (req, res) => {
  try {
    const topic = String(req.body.topic || "").trim();
    if (!topic) return res.status(400).json({ error: "Topic is required" });
    const r = await pool.query(
      "INSERT INTO study_sessions(topic, source_type) VALUES($1,'topic') RETURNING id, topic",
      [topic]
    );
    res.status(201).json({ sessionId: r.rows[0].id, topic: r.rows[0].topic });
  } catch (err) {
    console.error("session/topic", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// Start a session from an uploaded PDF
app.post("/api/session/pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "PDF file is required" });
    const pdfParse = require("pdf-parse"); // required lazily to avoid a known load-time bug
    const buffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(buffer);
    const text = String(data.text || "").replace(/\s+/g, " ").trim();
    if (!text) return res.status(400).json({ error: "Could not read text from that PDF" });
    const topic = String(req.body.topic || req.file.originalname || "PDF Study Session").trim();
    const r = await pool.query(
      "INSERT INTO study_sessions(topic, source_type, source_text) VALUES($1,'pdf',$2) RETURNING id, topic",
      [topic, text.slice(0, 50000)]
    );
    res.status(201).json({ sessionId: r.rows[0].id, topic: r.rows[0].topic });
  } catch (err) {
    console.error("session/pdf", err);
    res.status(500).json({ error: "Failed to process PDF" });
  } finally {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true });
  }
});

// Generate (or return cached) explanation
app.post("/api/explanation", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const cached = await pool.query(
      "SELECT id, content FROM explanations WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1",
      [sessionId]
    );
    if (cached.rowCount)
      return res.json({ explanationId: cached.rows[0].id, explanation: cached.rows[0].content });

    const s = await pool.query("SELECT topic, source_text FROM study_sessions WHERE id=$1", [sessionId]);
    if (!s.rowCount) return res.status(404).json({ error: "Session not found" });

    const input = s.rows[0].source_text || s.rows[0].topic;
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

// Generate an exam for a session
app.post("/api/assessment", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const ex = await pool.query(
      "SELECT content FROM explanations WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1",
      [sessionId]
    );
    if (!ex.rowCount) return res.status(404).json({ error: "Generate an explanation first" });

    const a = await pool.query("INSERT INTO assessments(session_id) VALUES($1) RETURNING id", [sessionId]);
    const assessmentId = a.rows[0].id;

    let generated;
    try {
      generated = await generateJson(PROMPTS.assessment, ex.rows[0].content, {
        schema: SCHEMAS.assessment,
        schemaName: "assessment",
        maxTokens: 4096,
      });
    } catch (genErr) {
      // Don't leave a question-less assessment row behind if generation
      // never succeeded.
      await pool.query("DELETE FROM assessments WHERE id=$1", [assessmentId]);
      throw genErr;
    }
    for (const q of generated.questions || []) {
      await pool.query(
        `INSERT INTO questions(assessment_id, question_type, question_text, options, correct_answer, concept_tag, explanation)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          assessmentId,
          q.type,
          q.question,
          q.options && q.options.length ? JSON.stringify(q.options) : null,
          String(q.correctAnswer ?? ""),
          q.conceptTag || "General",
          q.explanation || "",
        ]
      );
    }
    const questions = await pool.query(
      "SELECT id, question_type, question_text, options FROM questions WHERE assessment_id=$1 ORDER BY created_at",
      [assessmentId]
    );
    res.status(201).json({ assessmentId, questions: questions.rows });
  } catch (err) {
    console.error("assessment", err);
    return sendFailure(res, err, "Failed to generate exam");
  }
});

// Submit answers -> grade, diagnose weak concepts, schedule spaced recall
app.post("/api/submit", async (req, res) => {
  try {
    const { assessmentId, answers = [] } = req.body;
    if (!assessmentId) return res.status(400).json({ error: "assessmentId is required" });

    const qRows = await pool.query(
      "SELECT q.*, a.session_id FROM questions q JOIN assessments a ON a.id=q.assessment_id WHERE q.assessment_id=$1",
      [assessmentId]
    );
    if (!qRows.rowCount) return res.status(404).json({ error: "Exam not found" });

    const answerMap = new Map(answers.map((x) => [x.questionId, String(x.answer || "").trim()]));
    const graded = [];

    for (const q of qRows.rows) {
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
            // Judging a free-text answer is the one call where thinking pays
            // for itself — and at ~40 output tokens it costs almost nothing.
            effort: EFFORT.grade,
            maxTokens: 800,
          }
        );
      }
      graded.push({
        questionId: q.id,
        question: q.question_text,
        conceptTag: q.concept_tag,
        correctAnswer: q.correct_answer,
        studentAnswer,
        ...result,
      });
    }

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

    // Diagnose + schedule spaced recall
    const weak = diagnoseWeakConcepts(graded);
    for (const w of weak) {
      const savedWeak = await pool.query(
        "INSERT INTO weak_concepts(session_id, concept_tag, diagnosis, severity) VALUES($1,$2,$3,$4) RETURNING id",
        [sessionId, w.conceptTag, w.diagnosis, w.severity]
      );
      await pool.query(
        "INSERT INTO recall_schedules(weak_concept_id, session_id, concept_tag, due_at) VALUES($1,$2,$3,$4)",
        [savedWeak.rows[0].id, sessionId, w.conceptTag, firstDueDate(w.severity)]
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

// Generate targeted re-teaching for a session's weak concepts
app.post("/api/reteach", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const weak = await pool.query(
      "SELECT * FROM weak_concepts WHERE session_id=$1 ORDER BY created_at DESC",
      [sessionId]
    );

    // Each concept's re-teach lesson is independent of the others, so
    // generate them all concurrently instead of one-at-a-time — with N
    // weak concepts this cuts wall-clock time roughly by a factor of N
    // instead of paying for each LLM round-trip back to back.
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

// Spaced-recall items that are due now (with their re-teach mini question for re-testing)
app.get("/api/recall/due", async (_req, res) => {
  try {
    const due = await pool.query(
      `SELECT rs.id, rs.concept_tag, rs.due_at, rs.repetitions, rs.interval_days,
              wc.diagnosis, wc.severity,
              (SELECT content FROM reteach_lessons WHERE weak_concept_id = wc.id LIMIT 1) AS reteach
       FROM recall_schedules rs
       JOIN weak_concepts wc ON wc.id = rs.weak_concept_id
       WHERE rs.due_at <= NOW()
       ORDER BY rs.due_at ASC`
    );
    res.json({ due: due.rows });
  } catch (err) {
    console.error("recall/due", err);
    res.status(500).json({ error: "Failed to load recall items" });
  }
});

// Review a recall item -> reschedule with SM-2. body: { quality: 2|3|4|5 }
app.post("/api/recall/:id/review", async (req, res) => {
  try {
    const quality = Number(req.body.quality);
    if (![2, 3, 4, 5].includes(quality))
      return res.status(400).json({ error: "quality must be 2, 3, 4 or 5" });

    const cur = await pool.query("SELECT * FROM recall_schedules WHERE id=$1", [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: "Recall item not found" });

    const next = sm2(cur.rows[0], quality);
    const updated = await pool.query(
      `UPDATE recall_schedules
       SET ease=$1, interval_days=$2, repetitions=$3, due_at=$4, last_reviewed_at=NOW()
       WHERE id=$5 RETURNING *`,
      [next.ease, next.interval_days, next.repetitions, next.due_at, req.params.id]
    );
    res.json({ recall: updated.rows[0] });
  } catch (err) {
    console.error("recall/review", err);
    res.status(500).json({ error: "Failed to update recall item" });
  }
});

// Fallback: serve the single-page UI for any non-API route
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`SmartStudy Assistant running on port ${PORT}`));
