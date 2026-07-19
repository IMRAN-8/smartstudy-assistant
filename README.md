# SmartStudy Assistant (SSA)

An AI-powered adaptive learning and self-assessment platform. Enter a topic or upload a PDF and the app will:

1. **Explain** the topic clearly.
2. **Examine** you with auto-generated MCQ + short-answer questions.
3. **Diagnose** your weak sub-concepts.
4. **Re-teach** only the areas you got wrong.
5. **Spaced recall** — reschedule those concepts (SM-2 algorithm) so you review them before you forget.

It is a single Node.js + Express app that serves both the web page and the API — deploy it exactly like a normal web service (e.g. Render).

## Tech Stack

- Node.js + Express (one `server.js`)
- Plain HTML + CSS + vanilla JavaScript frontend (`public/index.html`, no build step)
- PostgreSQL / Supabase database
- OpenRouter (OpenAI-compatible) LLM API
- `pdf-parse` for PDF text extraction

## Project Structure

```text
smartstudy-assistant/
├── public/
│   └── index.html      Web UI (served by Express)
├── server.js           Express server: UI + API + LLM + database
├── schema.sql          Database tables (run in Supabase)
├── package.json
├── .env.example
├── .gitignore
├── LICENSE
└── README.md
```

## Setup

### 1. Database (Supabase)

1. Create a free project at https://supabase.com
2. Open **SQL Editor** and run the contents of `schema.sql`.
3. Go to **Project Settings → Database → Connection string → URI** and copy it
   (use the **pooler** URI, port `6543`, for hosting).

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

```env
PORT=5000
DATABASE_URL=your_supabase_connection_string
OPENROUTER_API_KEY=your_openrouter_api_key
LLM_MODEL=openai/gpt-4o-mini
NODE_ENV=
```

Get an OpenRouter key at https://openrouter.ai/keys

### 3. Run locally

```bash
npm install
npm start
```

Open http://localhost:5000

## Deploy on Render

1. Push this folder to a GitHub repo.
2. Render → **New → Web Service** → connect the repo.
3. **Build command:** `npm install`
4. **Start command:** `node server.js`
5. Add environment variables: `DATABASE_URL`, `OPENROUTER_API_KEY`, `LLM_MODEL`, and `NODE_ENV=production`.
6. Deploy. Render gives you a live URL.

**Tip:** on Render's free tier the service sleeps when idle. Add the URL to
[UptimeRobot](https://uptimerobot.com) to keep it awake (same trick used in Luna AI).

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/health` | Health check |
| POST | `/api/session/topic` | Start a session from a topic |
| POST | `/api/session/pdf` | Start a session from a PDF upload |
| POST | `/api/explanation` | Generate the explanation |
| POST | `/api/assessment` | Generate the exam |
| POST | `/api/submit` | Grade answers, diagnose, schedule recall |
| POST | `/api/reteach` | Generate targeted re-teaching |
| GET  | `/api/recall/due` | List recall items that are due |
| POST | `/api/recall/:id/review` | Review an item (SM-2 reschedule) |

## What You Must Change

- `.env` → real `DATABASE_URL` and `OPENROUTER_API_KEY`.
- `schema.sql` → run it once in Supabase.
- (Optional) `LLM_MODEL` → any model available on OpenRouter.
- (Optional) prompts inside `server.js` (`PROMPTS` object) to change tone or question counts.

## Author

Imran Hosen — https://github.com/IMRAN-8
