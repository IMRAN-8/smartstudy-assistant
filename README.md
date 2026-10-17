# 🎓 SmartStudy Assistant (SSA)

> **An AI-powered adaptive learning and self-assessment platform built to replace passive cramming with active recall, automated blindspot diagnosis, and spaced repetition.**

---

## 📌 Overview

**SmartStudy Assistant** turns any topic or lecture PDF into an interactive five-stage cognitive mastery cycle. Rather than generating generic summaries, it isolates individual sub-concepts, diagnoses where the learner's understanding breaks down, and schedules targeted reviews using the scientifically proven **SM-2 Spaced Repetition Algorithm**.

---

## ▶️ Preview

LIVE DEMO : https://smartstudy-assistant.onrender.com

---

## 🔄 The 5-Stage Cognitive Learning Cycle

1. **Structured Explanation**: Breaks down topics or uploaded PDFs into essential core principles, concrete worked examples, common misconceptions, and synthesis with zero fluff.
2. **Diagnostic Assessment**: Generates custom 8-question exams (5 multiple-choice questions with plausible distractors + 3 conceptual short-answer questions).
3. **Deep Diagnosis**: Short answers are evaluated semantically for true comprehension rather than keyword matching. Missed sub-concepts are tagged with high or medium severity.
4. **Targeted Re-Teaching**: Rather than forcing students to re-read entire chapters, the system generates custom mini-lessons and quick checks addressing only the specific missed sub-concepts.
5. **Spaced Recall (SM-2)**: Weak concepts are filed into an algorithmic review queue with dynamic intervals (1 day, 2 days, 4 days, 1 week, etc.) based on user confidence ratings.

---

## ✨ Key Features

- **Google Authentication**: Secure, one-click sign-in using Firebase Auth and cryptographically verified server-side JWT tokens.
- **Multi-Modal Input**: Study any free-text topic or upload lecture PDF slides and handouts.
- **Study Pulse HUD**: Real-time home dashboard displaying active study streak, concepts mastered, and average exam accuracy.
- **Instant Sparks**: One-click curated starter topics spanning biotechnology, computer science, physics, and world history.
- **Smooth Exam UX**: Instant MCQ selection and question navigation without jarring page flickers or re-renders.
- **Reliable LLM Fallback Routing**: Robust OpenRouter provider routing with exponential backoff and automatic model fallback.
- **Creator Profile & Connect**: Built-in developer portfolio integration linking directly to developer socials.

---

## 🛠️ Tech Stack

- **Frontend**: Vanilla JavaScript (ES6+), HTML5, Custom Glassmorphic CSS3
- **Backend**: Node.js, Express.js
- **Authentication**: Firebase Authentication & Firebase Admin SDK
- **Database**: PostgreSQL on Supabase (Session Pooler)
- **AI Engine**: OpenRouter API (Strict JSON Schema output with reasoning models)
- **File Processing**: Multer & pdf-parse
- **Hosting**: Render Cloud Platform

---

## 📁 Project Structure

```text
smartstudy-assistant/
│
├── public/                          # Client-side web application
│   ├── index.html                   # Single-page application entry & Firebase Auth loader
│   ├── script.js                    # State machine, API client, views, & UI interactions
│   └── style.css                    # Dark-mode theme, HUD grid, and glassmorphic styling
│
├── server.js                        # Express API server, LLM prompts, SM-2 engine, & Postgres client
├── schema.sql                       # PostgreSQL database schema (users, sessions, exams, recall)
├── package.json                     # Node.js project manifest and dependency definitions
├── package-lock.json                # Locked dependency tree
└── README.md                        # Project documentation and architectural overview
```
##👨‍💻 Creator & Developer
Imran Hosen
Portfolio: imran-8.github.io
GitHub: [@imran-8](https://github.com/IMRAN-8)
Email: shahriarimran3315@gmail.com

##📄 License
This project is licensed under the MIT License.

