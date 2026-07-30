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
    baseURL: "https://openrouter.ai/api/v1",
  });
}

// Extract a JSON object from an LLM response even if it is wrapped in text/fences.
function extractJson(raw) {
  const cleaned = String(raw || "").replace(/```json/g, "").replace(/```/g, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  return first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned;
}

async function generateJson(system, user, maxTokens = 1800, attempt = 1) {
  const client = llmClient();
  const response = await client.chat.completions.create({
    model: process.env.LLM_MODEL || "openai/gpt-4o-mini",
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: typeof user === "string" ? user : JSON.stringify(user) },
    ],
  });
  const choice = response.choices?.[0];
  const raw = choice?.message?.content || "";
  const truncated = choice?.finish_reason === "length";

  try {
    return JSON.parse(extractJson(raw));
  } catch (parseErr) {
    // The model's JSON came back malformed or cut off mid-string. If it was
    // cut off (finish_reason "length"), give it more room next time; either
    // way, retry a couple of times before giving up — a fresh sample is
    // often well-formed even when the last one wasn't.
    if (attempt < 3) {
      const nextMaxTokens = truncated ? Math.min(maxTokens * 2, 8000) : maxTokens;
      return generateJson(system, user, nextMaxTokens, attempt + 1);
    }
    throw new Error(`LLM did not return valid JSON after ${attempt} attempts: ${parseErr.message}`);
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const PROMPTS = {
  explanation:
    "You are SmartStudy Assistant, an expert teacher writing a concise study guide. Explain the given " +
    "topic or study material clearly enough that a student could learn the essentials with no other " +
    "resource — prioritize the most important points over exhaustive coverage, but every sentence must " +
    "still teach something (no padding or repetition). Respond with a single JSON object and nothing " +
    'else — no markdown, no code fences, no extra commentary, and do NOT wrap the explanation in a ' +
    'single "markdown" field. The JSON object must have exactly these top-level keys: ' +
    '{"title":"short plain-text title","overview":"4-6 plain sentences giving a clear conceptual ' +
    'introduction — what the topic is, why it matters, and how its pieces relate, no markdown syntax",' +
    '"examples":["a concrete, worked example explained in enough detail to be instructive on its own, ' +
    'not just a one-line label"] (2-3 items), ' +
    '"commonMistakes":["a specific mistake plus a clear explanation of why it\'s wrong and what to do ' +
    'instead"] (2-3 items), ' +
    '"summary":"2-3 plain sentences tying the topic together and reinforcing the core takeaway"}. ' +
    "Do not use #, *, -, or other markdown syntax anywhere inside the string values.",

  assessment:
    "Create an exam from the explanation JSON provided. Return ONLY valid JSON: " +
    '{"questions":[{"type":"mcq","question":"...","options":["a","b","c","d"],' +
    '"correctAnswer":"exact text of the correct option","conceptTag":"short sub-concept name",' +
    '"explanation":"why, in under 12 words"},{"type":"short","question":"...","options":null,' +
    '"correctAnswer":"model answer, one short sentence","conceptTag":"...",' +
    '"explanation":"why, in under 12 words"}]}. ' +
    "Make exactly 5 MCQ and 3 short-answer questions. Each question tests ONE specific sub-concept. " +
    "For MCQ, correctAnswer MUST be the exact text of one of the options. Keep every field brief — " +
    "no filler, no restating the question.",

  grading:
    "You grade a student's short answer fairly. Return ONLY valid JSON: " +
    '{"score":0.0-1.0,"isCorrect":true/false,"feedback":"one short sentence"}. ' +
    "isCorrect is true when score >= 0.7.",

  reteach:
    "Re-teach ONLY the given weak sub-concept to a confused student. Return ONLY valid JSON: " +
    '{"concept":"...","simpleExplanation":"...","whyConfusing":"...","correctUnderstanding":"...",' +
    '"example":"...","miniQuestion":"...","miniAnswer":"..."}.',
};

// Minimum shape check for an explanation object before we trust and save it.
function isValidExplanation(e) {
  return (
    !!e &&
    typeof e.title === "string" &&
    e.title.trim().length > 0 &&
    typeof e.overview === "string" &&
    e.overview.trim().length > 0
  );
}

// Generate an explanation, and retry once (with a stricter reminder) if the
// model ignores the requested shape (e.g. returns { markdown: "..." }).
async function generateExplanationWithRetry(input) {
  async function attempt(system) {
    try {
      return await generateJson(system, input, 4096);
    } catch (err) {
      // Covers both network/API errors and JSON.parse failures from a
      // response that got cut off mid-generation before it was valid JSON.
      console.warn("Explanation generation attempt failed:", err.message);
      return null;
    }
  }

  let explanation = await attempt(PROMPTS.explanation);
  if (!isValidExplanation(explanation)) {
    console.warn("Explanation missing required keys or invalid, retrying:", explanation);
    explanation = await attempt(
      PROMPTS.explanation +
        " Your previous response was invalid or incomplete — respond again using exactly the keys " +
        "title, overview, examples, commonMistakes, summary, with no other keys, and make " +
        "sure the JSON is complete and properly closed with no truncation."
    );
  }
  if (!isValidExplanation(explanation)) {
    throw new Error("The AI could not generate a valid explanation for this topic after two attempts.");
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "SmartStudy Assistant" }));

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
    res.status(500).json({ error: "Failed to generate explanation" });
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
      generated = await generateJson(PROMPTS.assessment, ex.rows[0].content, 4096);
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
          q.options ? JSON.stringify(q.options) : null,
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
    res.status(500).json({ error: "Failed to generate exam" });
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
          400
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
    res.status(500).json({ error: "Failed to grade exam" });
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
    const lessons = [];
    for (const c of weak.rows) {
      const existing = await pool.query(
        "SELECT content FROM reteach_lessons WHERE weak_concept_id=$1 LIMIT 1",
        [c.id]
      );
      if (existing.rowCount) {
        lessons.push(existing.rows[0].content);
        continue;
      }
      const lesson = await generateJson(
        PROMPTS.reteach,
        { conceptTag: c.concept_tag, diagnosis: c.diagnosis },
        1200
      );
      await pool.query("INSERT INTO reteach_lessons(weak_concept_id, content) VALUES($1,$2)", [
        c.id,
        lesson,
      ]);
      lessons.push(lesson);
    }
    res.json({ lessons });
  } catch (err) {
    console.error("reteach", err);
    res.status(500).json({ error: "Failed to generate re-teaching" });
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
