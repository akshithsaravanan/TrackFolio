"""
routes/markets.py — Live market indices and institutional flow data.

Provides the "Markets" widgets on the Dashboard:
  - Index ticker bar (Nifty 50, Sensex, Bank Nifty, S&P 500, Nasdaq, Gold)
  - FII/DII net institutional flow chart (sourced from NSE India)

Endpoints:
  GET /markets/indices  → live price + daily change for major indices (cached 15 min)
  GET /markets/fiidii   → FII/DII net flow for last 20 trading days (cached 4 hours)
"""

import json
import os
import sqlite3
import time

import pandas as pd
import requests
from fastapi import APIRouter, Depends

from auth import get_current_user
from yf_lock import YF_LOCK as _YF_LOCK

router = APIRouter(prefix="/markets", tags=["Markets"])

# Shared SQLite cache path (same DB used by analytics module)
_CACHE_DB = os.path.join(os.path.dirname(__file__), "..", "price_cache.db")

# ── Index metadata ────────────────────────────────────────────────────────────
# Each entry defines the Yahoo Finance symbol, display name, and chart colour
# used by the frontend index bar component.
_INDEX_META = [
    {"symbol": "^NSEI",    "yf": "^NSEI",    "name": "NIFTY 50",   "color": "#3b82f6"},
    {"symbol": "^BSESN",   "yf": "^BSESN",   "name": "SENSEX",     "color": "#8b5cf6"},
    {"symbol": "^NSEBANK", "yf": "^NSEBANK",  "name": "BANK NIFTY", "color": "#ef4444"},
    {"symbol": "^GSPC",    "yf": "^GSPC",     "name": "S&P 500",    "color": "#10b981"},
    {"symbol": "^IXIC",    "yf": "^IXIC",     "name": "NASDAQ",     "color": "#f59e0b"},
    {"symbol": "GC=F",     "yf": "GC=F",      "name": "Gold",       "color": "#fbbf24"},
]


@router.get("/indices")
def markets_indices(user_id: str = Depends(get_current_user)):
    """
    Return live prices and daily percentage change for major market indices.

    Cached 15 minutes in SQLite so repeated Dashboard loads don't hammer yfinance.
    All 6 symbols are downloaded in a single batch call under _YF_LOCK.

    Returns list of:
      {symbol, name, color, price, change_pct, change_abs}
    None values indicate the price could not be fetched.
    """
    conn = sqlite3.connect(_CACHE_DB)
    conn.execute("""CREATE TABLE IF NOT EXISTS index_cache
                    (key TEXT PRIMARY KEY, data TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 15 * 60
    now       = time.time()

    row = conn.execute(
        "SELECT data, ts FROM index_cache WHERE key='__all__'"
    ).fetchone()
    if row and (now - row[1]) < cache_ttl:
        conn.close()
        return json.loads(row[0])

    result = []
    try:
        import yfinance as yf

        syms = [m["yf"] for m in _INDEX_META]
        # Passing a list always yields a MultiIndex DataFrame with Close keyed by symbol
        with _YF_LOCK:
            raw = yf.download(
                syms, period="5d", interval="1d",
                auto_adjust=False, progress=False, threads=False,
            )
        close = raw["Close"]   # DataFrame keyed by ticker when list is passed

        for m in _INDEX_META:
            try:
                prices     = close[m["yf"]].dropna().tolist()
                if len(prices) >= 2:
                    curr       = prices[-1]
                    prev       = prices[-2]
                    change_abs = round(curr - prev, 2)
                    change_pct = round((curr - prev) / prev * 100, 2)
                    result.append({
                        **m,
                        "price":      round(curr, 2),
                        "change_pct": change_pct,
                        "change_abs": change_abs,
                    })
                else:
                    result.append({**m, "price": None, "change_pct": None, "change_abs": None})
            except Exception:
                result.append({**m, "price": None, "change_pct": None, "change_abs": None})
    except Exception:
        result = [{**m, "price": None, "change_pct": None, "change_abs": None} for m in _INDEX_META]

    conn.execute(
        "INSERT OR REPLACE INTO index_cache VALUES (?,?,?)",
        ("__all__", json.dumps(result), now),
    )
    conn.commit()
    conn.close()
    return result


@router.get("/fiidii")
def markets_fiidii(user_id: str = Depends(get_current_user)):
    """
    Return FII (Foreign Institutional Investors) and DII (Domestic Institutional Investors)
    net buy/sell flow data for the last 20 trading days.

    Data is scraped from the NSE India public API with a browser-like session
    (headers + cookie seeding) to avoid 403 responses.

    Cached 4 hours — NSE updates this data once per trading day.

    Returns:
      data   — [{date, fii_net, dii_net}] (last 20 entries, newest last)
      source — "nse" if fetch succeeded, "unavailable" otherwise
    """
    conn = sqlite3.connect(_CACHE_DB)
    conn.execute("""CREATE TABLE IF NOT EXISTS fiidii_cache
                    (key TEXT PRIMARY KEY, data TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 4 * 3600
    now       = time.time()

    row = conn.execute(
        "SELECT data, ts FROM fiidii_cache WHERE key='fiidii'"
    ).fetchone()
    if row and (now - row[1]) < cache_ttl:
        conn.close()
        return json.loads(row[0])

    payload = {"data": [], "source": "unavailable"}

    try:
        session = requests.Session()
        session.headers.update({
            "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) "
                               "Chrome/120.0.0.0 Safari/537.36",
            "Accept":          "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer":         "https://www.nseindia.com/",
        })
        # Seed cookies so NSE doesn't reject the API call
        session.get("https://www.nseindia.com", timeout=8)
        session.get("https://www.nseindia.com/market-data/fii-dii-activity", timeout=8)

        resp = session.get("https://www.nseindia.com/api/fiidiiTradeReact", timeout=10)
        if resp.status_code == 200:
            raw  = resp.json()
            rows = raw if isinstance(raw, list) else []
            data = []
            for item in rows:
                try:
                    def _n(v):
                        return float(
                            str(v).replace(",", "").replace("−", "-").strip() or "0"
                        )
                    data.append({
                        "date":    item.get("date", ""),
                        "fii_net": _n(item.get("fiiNetDIITurnover", item.get("fii_net_turnover", 0))),
                        "dii_net": _n(item.get("diiNetDIITurnover", item.get("dii_net_turnover", 0))),
                    })
                except Exception:
                    pass
            if data:
                payload = {"data": data[-20:], "source": "nse"}
    except Exception:
        pass

    conn.execute(
        "INSERT OR REPLACE INTO fiidii_cache VALUES (?,?,?)",
        ("fiidii", json.dumps(payload), now),
    )
    conn.commit()
    conn.close()
    return payload
