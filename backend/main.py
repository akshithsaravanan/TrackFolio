"""
main.py — FastAPI application entry point.

Responsibility of this file:
  1. Create the FastAPI app instance.
  2. Configure CORS middleware.
  3. Clear stale SQLite caches on startup.
  4. Register all domain routers.

Everything else lives in focused modules:

  models.py            — Pydantic request models + validation constants
  database.py          — SQLite connection + table creation
  supabase_client.py   — Supabase SDK initialisation
  auth.py              — JWT verification, user tracking
  prices.py            — yfinance batch fetching, FX conversion, caching
  csv_import.py        — Broker CSV parsers (ICICI, SBI, CBQ, HSBC)
  llm.py               — Groq API wrapper (LLaMA 3.3 70B / 3.1 8B)
  email_service.py     — Resend API integration
  yf_lock.py           — Shared threading lock for yfinance calls

  routes/
    brokers.py         → GET/POST/DELETE /brokers
    alerts.py          → GET/POST/DELETE /alerts
    holdings.py        → GET/POST/PUT/DELETE /holdings, /holdings/merge-duplicates
    transactions.py    → GET/POST/PUT/DELETE /transactions, /transactions/migrate
    prices.py          → GET /prices/{ticker}, /sparklines, /portfolio/history
    analytics.py       → GET/POST /analytics/*  (AI, benchmark, sectors, 52w, FX, P&L, tax)
    markets.py         → GET /markets/indices, /markets/fiidii
    admin.py           → POST /admin/clear-cache, /import/csv, /search/ticker

Database:
  Supabase PostgreSQL  — brokers, holdings, transactions, price_alerts, user_approvals
  SQLite (local)       — price_cache, week52_cache, sector_cache, index_cache,
                         fiidii_cache, fxhist_cache, fundamentals_cache, tech_scores

Auth:
  Supabase JWT — every endpoint requires Authorization: Bearer <token>
  user_id is extracted from the token; all queries are scoped to it.
"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import create_tables, get_connection

# ── Route modules ──────────────────────────────────────────────────────────────
from routes import brokers, alerts, holdings, transactions
from routes import prices as prices_router
from routes import analytics, markets, admin

# ── App setup ──────────────────────────────────────────────────────────────────
app = FastAPI(title="Portfolio Tracker API", version="2.0.0")

# CORS — in production set FRONTEND_URL to your Vercel domain
# (e.g. https://portfolio.vercel.app). Leave unset locally to allow all origins.
_frontend_url    = os.environ.get("FRONTEND_URL", "")
_allowed_origins = [_frontend_url] if _frontend_url else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialise local SQLite price_cache table (no-op if it already exists)
create_tables()


# ── Startup event ──────────────────────────────────────────────────────────────

@app.on_event("startup")
async def on_startup():
    """
    Clear all stale cache tables on every server restart.

    Why: Cached prices could be hours old after a server restart (e.g. Railway
    cold start, deployment). Clearing on startup guarantees fresh prices are
    fetched immediately — a small one-time latency hit on the first request
    is better than stale data for all users until caches naturally expire.

    Tables cleared:
      price_cache       — 15-min price cache (holdings page)
      week52_cache      — 24h 52-week high/low + technicals
      fxhist_cache      — 24h FX history (quarterly USDINR drag)
      fundamentals_cache — 7-day P/E, P/B, dividend yield cache
    """
    try:
        conn = get_connection()
        conn.execute("DELETE FROM price_cache")

        conn.execute("""CREATE TABLE IF NOT EXISTS week52_cache
                        (ticker TEXT PRIMARY KEY, data TEXT, ts REAL)""")
        conn.execute("DELETE FROM week52_cache")

        conn.execute("""CREATE TABLE IF NOT EXISTS fxhist_cache
                        (key TEXT PRIMARY KEY, data TEXT, ts REAL)""")
        conn.execute("DELETE FROM fxhist_cache")

        conn.execute("""CREATE TABLE IF NOT EXISTS fundamentals_cache
                        (ticker TEXT PRIMARY KEY, data TEXT, ts REAL)""")
        conn.execute("DELETE FROM fundamentals_cache")

        conn.commit()
        conn.close()
    except Exception:
        pass   # Never let a cache failure prevent the server from starting


# ── Register routers ───────────────────────────────────────────────────────────
#
# Each router is an APIRouter instance defined in its own module.
# Registering here wires its routes into the main app without this file
# needing to know anything about the endpoint implementations.

app.include_router(brokers.router)
app.include_router(alerts.router)
app.include_router(holdings.router)
app.include_router(transactions.router)
app.include_router(prices_router.router)
app.include_router(analytics.router)
app.include_router(markets.router)
app.include_router(admin.router)
