# Local Setup Checklist

Quick reference for getting TrackFolio running on your machine. See README.md for full details.

---

## What You Need First

- [ ] Node.js installed (`node --version` should show v18+)
- [ ] Python installed (`python --version` should show 3.11+)
- [ ] A Supabase account and project → [supabase.com](https://supabase.com)
- [ ] A Groq API key → [console.groq.com](https://console.groq.com)

---

## One-Time Database Setup (Supabase)

1. Open your Supabase project
2. Go to **SQL Editor → New query**
3. Paste and run the SQL from **README.md → Step 4**
4. Confirm three tables exist: `brokers`, `holdings`, `transactions`

---

## Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux
pip install -r requirements.txt
```

Create `backend/.env` — paste your keys:

```
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
GROQ_API_KEY=gsk_...
```

Start:

```bash
uvicorn main:app --reload --port 8000
```

**Test it:** Open `http://localhost:8000/docs` — you should see the API documentation page.

---

## Frontend

```bash
cd frontend-react
npm install
```

Create `frontend-react/.env.local`:

```
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
VITE_API_URL=http://localhost:8000
```

Start:

```bash
npm run dev
```

**Test it:** Open `http://localhost:5173` — login page should appear.

---

## Verify Everything Works

- [ ] Login with email/password (sign up first)
- [ ] Add a broker (e.g. "ICICI Direct")
- [ ] Add a holding (search "TCS" → select TCS.NS → enter quantity and price)
- [ ] Holdings page loads with a live price
- [ ] Analytics page shows allocation chart
- [ ] AI Insights page generates a portfolio analysis

---

## Git — Push to Your GitHub

```bash
# (Already done — initial commit exists)
# Just add your GitHub remote and push:

git remote add origin https://github.com/<your-username>/trackfolio.git
git branch -M main
git push -u origin main
```

---

## Git — Workflow Going Forward

```bash
# After making any change:
git add .
git commit -m "describe what you changed"
git push
```

Keep commits small and descriptive. Examples:
- `Add portfolio history chart to dashboard`
- `Fix price fetch timeout for NSE tickers`
- `Improve AI insights prompt for better recommendations`

---

## Environment Variables Summary

| Variable | Used In | Where to Find |
|---|---|---|
| `SUPABASE_URL` | Backend + Frontend | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Backend only | Supabase → Project Settings → API → service_role (secret) |
| `SUPABASE_ANON_KEY` | Frontend only | Supabase → Project Settings → API → anon public |
| `GROQ_API_KEY` | Backend only | console.groq.com → API Keys |
| `VITE_API_URL` | Frontend only | `http://localhost:8000` locally, Railway URL in production |

---

## Common Issues

| Problem | Fix |
|---|---|
| `ModuleNotFoundError` | Make sure `.venv` is activated before running uvicorn |
| `SUPABASE_URL not set` | Check `.env` file exists in `backend/` folder |
| Frontend shows blank page | Check browser console (F12) for errors; verify `.env.local` exists |
| Holdings show `—` for price | Yahoo Finance couldn't find the ticker — check the symbol (add `.NS` for NSE stocks) |
| `401 Unauthorized` from API | Session expired — sign out and sign back in |
| Port 8000 already in use | `uvicorn main:app --reload --port 8001` and update `VITE_API_URL` |
