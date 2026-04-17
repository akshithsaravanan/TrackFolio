# TrackFolio — Multi-Currency Portfolio Tracker

A full-stack web application that tracks stock portfolios across multiple markets (India, US, UAE) with real-time prices, portfolio analytics, and AI-powered insights.

> **Live Demo:** _[Add your deployed URL here]_
> **GitHub:** _[Add your GitHub repo URL here]_

---

## About

TrackFolio lets investors manage holdings across different brokers and currencies in one place. It fetches live stock prices, computes portfolio performance, visualises allocation, and uses an LLM to answer natural-language questions about the portfolio.

**Key capabilities:**
- Add and manage stock holdings across multiple brokers
- Real-time price fetching from Yahoo Finance
- Multi-currency support — INR (India), USD (US), AED (UAE)
- Portfolio analytics: allocation breakdown, benchmark vs Nifty 50 / S&P 500
- AI Insights — ask questions like "What is my most overweight position?"
- Transaction log — buy, sell, dividend tracking with FIFO P&L
- CSV import from ICICI Direct, SBI Securities, CBQ, HSBC broker exports
- Google OAuth + email/password authentication
- Responsive design — works on desktop and mobile

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Frontend** | React 19 + Vite | UI framework and build tool |
| **Routing** | React Router v7 | Client-side page routing |
| **Charts** | Recharts | Portfolio allocation and performance charts |
| **Backend** | Python 3.11 + FastAPI | REST API server |
| **Database** | Supabase (PostgreSQL) | User data, holdings, transactions |
| **Authentication** | Supabase Auth | JWT tokens, Google OAuth |
| **Price Data** | Yahoo Finance (yfinance) | Real-time and historical stock prices |
| **AI / LLM** | Groq API (LLaMA 3.3 70B) | Portfolio analysis and Q&A |
| **HTTP Client** | requests | API calls (prices, LLM, FX rates) |
| **FX Rates** | open.er-api.com | Currency conversion (INR, AED → USD) |
| **Frontend Deploy** | Vercel | Static site hosting + CDN |
| **Backend Deploy** | Railway | Python server hosting |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (React)                      │
│   Dashboard · Holdings · Analytics · AI Insights        │
└────────────────────┬────────────────────────────────────┘
                     │  HTTPS  (VITE_API_URL)
                     ▼
┌─────────────────────────────────────────────────────────┐
│              Railway — FastAPI Backend                   │
│                                                          │
│   /holdings      → CRUD for stock positions             │
│   /brokers       → broker account management            │
│   /transactions  → buy / sell / dividend log            │
│   /analytics/*   → allocation, benchmark, sectors       │
│   /analytics/ai  → LLM full portfolio analysis          │
│   /analytics/ask → LLM Q&A on portfolio                 │
│   /sparklines    → 7-day price mini-charts              │
│   /import/csv    → broker CSV parser                    │
└──────┬──────────────┬──────────────┬────────────────────┘
       │              │              │
       ▼              ▼              ▼
  Supabase       Yahoo Finance    Groq API
  (Postgres)     (yfinance)       (LLaMA 3.3)
  Holdings       Live prices      AI insights
  Auth / JWT     Historical data  Portfolio Q&A
```

---

## Project Structure

```
trackfolio/
├── backend/
│   ├── main.py              # FastAPI app — all API endpoints
│   ├── auth.py              # JWT token verification (Supabase)
│   ├── prices.py            # Yahoo Finance price fetching + 15-min cache
│   ├── llm.py               # LLM abstraction layer (Groq / LLaMA)
│   ├── csv_import.py        # Broker CSV parsers (ICICI, SBI, CBQ, HSBC)
│   ├── database.py          # SQLite cache (prices, sectors, sparklines)
│   ├── supabase_client.py   # Supabase SDK initialisation
│   ├── yf_lock.py           # Thread lock for concurrent yfinance calls
│   ├── requirements.txt     # Python dependencies
│   ├── Procfile             # Railway startup command
│   └── tests/               # pytest test suite (51 tests)
│
├── frontend-react/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── AuthPage.jsx         # Login / signup
│   │   │   ├── DashboardPage.jsx    # Portfolio overview + KPIs
│   │   │   ├── HoldingsPage.jsx     # Holdings CRUD + live prices
│   │   │   ├── TransactionsPage.jsx # Trade log (buy/sell/dividend)
│   │   │   ├── AnalyticsPage.jsx    # Allocation charts + benchmark
│   │   │   ├── CopilotPage.jsx      # AI Insights + Q&A
│   │   │   └── SettingsPage.jsx     # User preferences
│   │   ├── components/
│   │   │   ├── layout/    # Sidebar, Topbar, Layout wrapper
│   │   │   ├── holdings/  # HoldingModal, BrokerModal, CSVImport
│   │   │   └── dashboard/ # PortfolioChart
│   │   ├── api/
│   │   │   └── client.js  # All fetch calls to the backend API
│   │   ├── context/
│   │   │   ├── AuthContext.jsx       # Global auth state (Supabase session)
│   │   │   └── HideValuesContext.jsx # Privacy mode toggle
│   │   └── lib/
│   │       └── supabase.js  # Supabase client (frontend)
│   ├── package.json
│   └── vite.config.js
│
├── README.md
└── SETUP_LOCAL.md           # Quick local setup checklist
```

---

## Local Development Setup

### Prerequisites

| Tool | Version | Download |
|---|---|---|
| Node.js | v18 or later | [nodejs.org](https://nodejs.org) |
| Python | 3.11 or later | [python.org](https://python.org) |
| Git | any | [git-scm.com](https://git-scm.com) |

You also need free accounts on:
- [Supabase](https://supabase.com) — database and auth
- [Groq](https://console.groq.com) — AI/LLM API key

---

### Step 1 — Clone the repo

```bash
git clone https://github.com/<your-username>/trackfolio.git
cd trackfolio
```

---

### Step 2 — Backend

```bash
cd backend

# Create and activate virtual environment
python -m venv .venv
source .venv/bin/activate        # macOS / Linux
# .venv\Scripts\activate         # Windows

# Install dependencies
pip install -r requirements.txt
```

Create `backend/.env`:

```env
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci...   # service_role key (keep secret)
GROQ_API_KEY=gsk_...
```

> Find these in: **Supabase → Project Settings → API**

Start the server:

```bash
uvicorn main:app --reload --port 8000
```

- API: `http://localhost:8000`
- Docs: `http://localhost:8000/docs`

---

### Step 3 — Frontend

```bash
cd frontend-react
npm install
```

Create `frontend-react/.env.local`:

```env
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...   # anon/public key
VITE_API_URL=http://localhost:8000
```

Start the dev server:

```bash
npm run dev
```

App: `http://localhost:5173`

---

### Step 4 — Supabase Database

Run the following SQL in **Supabase → SQL Editor → New query**:

```sql
CREATE TABLE brokers (
  id         SERIAL PRIMARY KEY,
  user_id    UUID NOT NULL,
  name       TEXT NOT NULL,
  country    TEXT DEFAULT 'IN',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE holdings (
  id             SERIAL PRIMARY KEY,
  user_id        UUID NOT NULL,
  broker_id      INTEGER REFERENCES brokers(id) ON DELETE CASCADE,
  ticker         TEXT NOT NULL,
  name           TEXT,
  quantity       NUMERIC,
  avg_buy_price  NUMERIC,
  currency       TEXT DEFAULT 'INR',
  purchase_date  DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE transactions (
  id          SERIAL PRIMARY KEY,
  user_id     UUID NOT NULL,
  broker_id   INTEGER REFERENCES brokers(id) ON DELETE SET NULL,
  ticker      TEXT NOT NULL,
  name        TEXT,
  type        TEXT NOT NULL,
  quantity    NUMERIC,
  price       NUMERIC,
  currency    TEXT DEFAULT 'INR',
  trade_date  DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

---

### Step 5 — Run Tests

```bash
cd backend
pytest tests/ -v
```

Expected: **51 tests passing**

---

## Deployment

### Backend → Railway

1. Push code to GitHub
2. [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set **Root Directory** to `backend/`
4. Add environment variables (same as `.env`)
5. Railway reads `Procfile` and deploys automatically

### Frontend → Vercel

1. [vercel.com](https://vercel.com) → Import GitHub repo
2. Set **Root Directory** to `frontend-react/`
3. Add environment variables (`.env.local` values, use Railway URL for `VITE_API_URL`)
4. Deploy

---

## Running Tests

```bash
cd backend
pytest tests/ -v
```

---

## Skills Demonstrated

This project covers the following areas relevant to SWE and ML/AI internship applications:

| Skill | Where |
|---|---|
| REST API design | 25+ FastAPI endpoints with proper HTTP methods and error handling |
| Database design | Relational schema, foreign keys, FIFO cost-basis calculation |
| Authentication | JWT verification on every request, Google OAuth via Supabase |
| External API integration | Yahoo Finance, Groq LLM API, open.er-api FX rates |
| LLM / prompt engineering | Portfolio analysis and Q&A using LLaMA 3.3 70B |
| Data pipeline | CSV parser for 4 broker formats → normalised holdings |
| Caching | SQLite-backed price cache with TTL to reduce API calls |
| Concurrency | Thread-safe yfinance calls, background tracking threads |
| React architecture | Context API, component composition, API abstraction layer |
| Full deployment | Railway + Vercel + Supabase |
