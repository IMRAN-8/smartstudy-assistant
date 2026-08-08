-- SmartStudy Assistant database schema
-- Run this in Supabase -> SQL Editor (or any PostgreSQL database).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
-- Identity WITHOUT authentication: a person types a user ID and owns whatever
-- is filed under it. There is no password, so this SEPARATES users' data --
-- it does not PROTECT it. Anyone who knows an ID can use it. Add real auth
-- before this holds anything sensitive.
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  display_name TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

-- A single study session (one topic or one uploaded PDF).
CREATE TABLE IF NOT EXISTS study_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  topic       TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('topic', 'pdf')),
  source_text TEXT,                              -- extracted PDF text (null for topic sessions)
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Generated explanation for a session (stored as JSON).
CREATE TABLE IF NOT EXISTS explanations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES study_sessions(id) ON DELETE CASCADE,
  content    JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One generated exam per attempt.
CREATE TABLE IF NOT EXISTS assessments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES study_sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Questions belonging to an exam.
CREATE TABLE IF NOT EXISTS questions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id  UUID REFERENCES assessments(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 0,
  question_type  TEXT NOT NULL CHECK (question_type IN ('mcq', 'short')),
  question_text  TEXT NOT NULL,
  options        JSONB,                          -- array for mcq, null for short
  correct_answer TEXT NOT NULL,
  concept_tag    TEXT NOT NULL,
  explanation    TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- A graded submission for an exam.
CREATE TABLE IF NOT EXISTS submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID REFERENCES assessments(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES study_sessions(id) ON DELETE CASCADE,
  score         NUMERIC,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Per-question grading detail.
CREATE TABLE IF NOT EXISTS answers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  UUID REFERENCES submissions(id) ON DELETE CASCADE,
  question_id    UUID REFERENCES questions(id) ON DELETE CASCADE,
  student_answer TEXT,
  is_correct     BOOLEAN,
  score          NUMERIC,
  feedback       TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Diagnosed weak sub-concepts for a session.
CREATE TABLE IF NOT EXISTS weak_concepts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID REFERENCES study_sessions(id) ON DELETE CASCADE,
  concept_tag TEXT NOT NULL,
  diagnosis   TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Targeted re-teaching lessons for weak concepts (stored as JSON).
CREATE TABLE IF NOT EXISTS reteach_lessons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weak_concept_id UUID REFERENCES weak_concepts(id) ON DELETE CASCADE,
  content         JSONB NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Spaced-recall schedule (SM-2 algorithm). One row per weak concept, rescheduled on each review.
CREATE TABLE IF NOT EXISTS recall_schedules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  weak_concept_id  UUID REFERENCES weak_concepts(id) ON DELETE CASCADE,
  session_id       UUID REFERENCES study_sessions(id) ON DELETE CASCADE,
  concept_tag      TEXT NOT NULL,
  ease             NUMERIC DEFAULT 2.5,
  interval_days    INTEGER DEFAULT 0,
  repetitions      INTEGER DEFAULT 0,
  due_at           TIMESTAMPTZ NOT NULL,
  last_reviewed_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recall_due ON recall_schedules(due_at);
CREATE INDEX IF NOT EXISTS idx_questions_assessment ON questions(assessment_id);

-- ---------------------------------------------------------------------------
-- Migration for databases created before these columns existed.
-- Safe to run repeatedly; safe on a brand-new database too.
-- ---------------------------------------------------------------------------
ALTER TABLE study_sessions   ADD COLUMN IF NOT EXISTS user_id  TEXT;
ALTER TABLE recall_schedules ADD COLUMN IF NOT EXISTS user_id  TEXT;
ALTER TABLE questions        ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;

-- Rows created before user accounts existed have user_id = NULL and are simply
-- invisible to every user, which is the correct outcome: they were shared
-- globally and belong to nobody.

CREATE INDEX IF NOT EXISTS idx_sessions_user     ON study_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_recall_user_due   ON recall_schedules(user_id, due_at);
CREATE INDEX IF NOT EXISTS idx_questions_order   ON questions(assessment_id, position);
