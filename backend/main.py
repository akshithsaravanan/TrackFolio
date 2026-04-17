"""
main.py — FastAPI application.

Database: Supabase PostgreSQL (brokers, holdings) + SQLite (price_cache)
Auth:     Supabase JWT — every endpoint requires a valid token
Multi-user: all queries filtered by user_id extracted from the JWT
"""

from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Form, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from typing import Optional
from datetime import datetime, timezone
import requests
import os
import pandas as pd

from database import create_tables, get_connection
from supabase_client import supabase as db
from auth import get_current_user
from yf_lock import YF_LOCK as _YF_LOCK   # shared lock — all yf.download() calls use this
from prices import (
    get_price_usd, get_prices_batch, convert_to_usd,
    usd_to_local, get_prev_close_usd, get_portfolio_history,
    FX_TICKERS, _get_cached
)
from csv_import import parse_csv
from llm import llm_call

app = FastAPI(title="Portfolio Tracker API", version="2.0.0")

# In production set FRONTEND_URL to your Vercel domain (e.g. https://portfolio.vercel.app)
# Leave unset locally — falls back to allow all origins for LAN/dev access
_frontend_url = os.environ.get("FRONTEND_URL", "")
_allowed_origins = [_frontend_url] if _frontend_url else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create local price_cache table on startup
create_tables()


@app.on_event("startup")
async def on_startup():
    """
    Clear stale price cache on every server restart.
    Guarantees fresh prices are fetched immediately after a restart
    instead of serving potentially hours-old cached values.
    """
    try:
        conn = get_connection()
        conn.execute("DELETE FROM price_cache")

        # Clear ALL 52-week cache entries — forces fresh technicals after any restart.
        # Data is re-fetched in a single batch download on next /analytics/52week request.
        conn.execute("""CREATE TABLE IF NOT EXISTS week52_cache
                        (ticker TEXT PRIMARY KEY, data TEXT, ts REAL)""")
        conn.execute("DELETE FROM week52_cache")

        # Clear FX history cache
        conn.execute("""CREATE TABLE IF NOT EXISTS fxhist_cache
                        (key TEXT PRIMARY KEY, data TEXT, ts REAL)""")
        conn.execute("DELETE FROM fxhist_cache")

        # Clear fundamentals cache so industry field is always fresh
        conn.execute("""CREATE TABLE IF NOT EXISTS fundamentals_cache
                        (ticker TEXT PRIMARY KEY, data TEXT, ts REAL)""")
        conn.execute("DELETE FROM fundamentals_cache")

        conn.commit()
        conn.close()
    except Exception:
        pass


# ─────────────────────────────────────────────
#  VALIDATION CONSTANTS
# ─────────────────────────────────────────────

VALID_CURRENCIES  = {"INR", "USD", "AED"}
VALID_ASSET_TYPES = {"stock", "etf", "mf"}
VALID_PERIODS     = {"7d", "30d", "90d", "ytd", "1y"}


# ─────────────────────────────────────────────
#  PYDANTIC MODELS
# ─────────────────────────────────────────────

class BrokerIn(BaseModel):
    name:     str
    currency: str

class HoldingIn(BaseModel):
    broker_id:     int
    ticker:        str
    name:          str           = ""
    quantity:      float
    avg_buy_price: float
    currency:      str
    asset_type:    str           = "stock"
    purchase_date: Optional[str] = None   # "YYYY-MM-DD" — when the holding was first bought
    notes:         str           = ""

    @field_validator("ticker")
    @classmethod
    def ticker_uppercase(cls, v):
        return v.strip().upper()

    @field_validator("currency")
    @classmethod
    def currency_valid(cls, v):
        v = v.strip().upper()
        if v not in VALID_CURRENCIES:
            raise ValueError(f"currency must be one of {VALID_CURRENCIES}")
        return v

    @field_validator("asset_type")
    @classmethod
    def asset_type_valid(cls, v):
        v = v.strip().lower()
        if v not in VALID_ASSET_TYPES:
            raise ValueError(f"asset_type must be one of {VALID_ASSET_TYPES}")
        return v

    @field_validator("quantity")
    @classmethod
    def quantity_positive(cls, v):
        if v <= 0:
            raise ValueError("quantity must be greater than 0")
        return v

    @field_validator("avg_buy_price")
    @classmethod
    def price_non_negative(cls, v):
        if v < 0:
            raise ValueError("avg_buy_price cannot be negative")
        return v


class AlertIn(BaseModel):
    ticker:       str
    name:         str   = ""
    target_price: float
    condition:    str             # "above" or "below"
    currency:     str   = "INR"

    @field_validator("condition")
    @classmethod
    def validate_condition(cls, v):
        if v not in ("above", "below"):
            raise ValueError("condition must be 'above' or 'below'")
        return v

    @field_validator("target_price")
    @classmethod
    def validate_price(cls, v):
        if v <= 0:
            raise ValueError("target_price must be positive")
        return v


# ─────────────────────────────────────────────
#  BROKERS
# ─────────────────────────────────────────────

@app.get("/brokers")
def list_brokers(user_id: str = Depends(get_current_user)):
    result = db.table("brokers").select("id, name, currency").eq("user_id", user_id).order("name").execute()
    return result.data


@app.post("/brokers", status_code=201)
def create_broker(broker: BrokerIn, user_id: str = Depends(get_current_user)):
    try:
        result = db.table("brokers").insert({
            "user_id":  user_id,
            "name":     broker.name.strip(),
            "currency": broker.currency.strip().upper(),
        }).execute()
        return result.data[0]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not create broker: {e}")


@app.delete("/brokers/{broker_id}")
def delete_broker(broker_id: int, user_id: str = Depends(get_current_user)):
    result = db.table("brokers").delete().eq("id", broker_id).eq("user_id", user_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Broker not found")
    return {"deleted": True}


# ─────────────────────────────────────────────
#  PRICE ALERTS
# ─────────────────────────────────────────────
#
#  Run this once in Supabase SQL editor to create the table:
#
#  CREATE TABLE IF NOT EXISTS price_alerts (
#      id           BIGSERIAL PRIMARY KEY,
#      user_id      TEXT         NOT NULL,
#      ticker       TEXT         NOT NULL,
#      name         TEXT         DEFAULT '',
#      target_price FLOAT        NOT NULL,
#      condition    TEXT         NOT NULL CHECK (condition IN ('above','below')),
#      currency     TEXT         DEFAULT 'INR',
#      created_at   TIMESTAMPTZ  DEFAULT NOW()
#  );
#  CREATE INDEX IF NOT EXISTS price_alerts_user_idx ON price_alerts(user_id);

@app.get("/alerts")
def list_alerts(user_id: str = Depends(get_current_user)):
    result = db.table("price_alerts").select("*").eq("user_id", user_id).order("created_at", desc=True).execute()
    # Enrich with current price so frontend can show triggered status
    alerts = result.data
    if alerts:
        tickers = list({a["ticker"] for a in alerts})
        ccy_map = {a["ticker"]: a["currency"] for a in alerts}
        pairs   = [(t, ccy_map[t]) for t in tickers]
        prices  = get_prices_batch(pairs)
        for a in alerts:
            cp = prices.get(a["ticker"])
            a["current_price"] = cp
            if cp is not None:
                if a["condition"] == "above":
                    a["is_triggered"] = cp >= a["target_price"]
                else:
                    a["is_triggered"] = cp <= a["target_price"]
            else:
                a["is_triggered"] = False
    return alerts


@app.post("/alerts", status_code=201)
def create_alert(alert: AlertIn, user_id: str = Depends(get_current_user)):
    try:
        result = db.table("price_alerts").insert({
            "user_id":      user_id,
            "ticker":       alert.ticker.upper().strip(),
            "name":         alert.name.strip() or alert.ticker.upper().strip(),
            "target_price": alert.target_price,
            "condition":    alert.condition,
            "currency":     alert.currency.upper(),
        }).execute()
        return result.data[0]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not create alert: {e}")


@app.delete("/alerts/{alert_id}")
def delete_alert(alert_id: int, user_id: str = Depends(get_current_user)):
    result = db.table("price_alerts").delete().eq("id", alert_id).eq("user_id", user_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"deleted": True}


# ─────────────────────────────────────────────
#  HOLDINGS
# ─────────────────────────────────────────────

@app.get("/holdings")
def list_holdings(
    broker_id: Optional[int] = None,
    user_id:   str = Depends(get_current_user)
):
    # Fetch holdings with broker name via JOIN
    query = db.table("holdings").select("*, brokers(name)").eq("user_id", user_id)
    if broker_id:
        query = query.eq("broker_id", broker_id)
    result = query.order("broker_id").order("ticker").execute()

    # Flatten nested broker object → broker_name
    holdings = []
    for h in result.data:
        broker_info      = h.pop("brokers", {}) or {}
        h["broker_name"] = broker_info.get("name", "Unknown")
        holdings.append(h)

    # Build a map of ticker → earliest BUY transaction date for this user.
    # Used to populate effective_purchase_date when purchase_date is not set manually.
    try:
        txn_rows = (
            db.table("transactions")
            .select("ticker, trade_date")
            .eq("user_id", user_id)
            .eq("type", "buy")
            .execute()
        )
        earliest_buy: dict[str, str] = {}
        for t in txn_rows.data:
            d = t.get("trade_date")
            if d:
                tk = t["ticker"]
                if tk not in earliest_buy or d < earliest_buy[tk]:
                    earliest_buy[tk] = d
    except Exception:
        earliest_buy = {}

    for h in holdings:
        # effective_purchase_date: manual date takes priority; fall back to
        # earliest recorded BUY transaction for the same ticker.
        h["effective_purchase_date"] = (
            h.get("purchase_date") or earliest_buy.get(h["ticker"])
        )

    # Batch fetch live prices
    ticker_currency_pairs = [(h["ticker"], h["currency"]) for h in holdings]
    prices = get_prices_batch(ticker_currency_pairs)

    result_list = []
    for h in holdings:
        price_usd  = prices.get(h["ticker"])
        cost_usd   = convert_to_usd(h["avg_buy_price"], h["currency"])
        price_local = usd_to_local(price_usd, h["currency"]) if price_usd else None

        h["current_price_usd"]   = price_usd
        h["current_price_local"] = price_local

        if price_usd is not None and cost_usd is not None:
            market_value_usd   = round(h["quantity"] * price_usd, 2)
            cost_basis_usd     = round(h["quantity"] * cost_usd,  2)
            gain_loss_usd      = round(market_value_usd - cost_basis_usd, 2)
            gain_pct           = round(gain_loss_usd / cost_basis_usd * 100, 2) if cost_basis_usd > 0 else 0.0
            market_value_local = round(h["quantity"] * price_local, 2) if price_local else None
            gain_loss_local    = round(market_value_local - h["quantity"] * h["avg_buy_price"], 2) if market_value_local else None

            prev_usd = get_prev_close_usd(h["ticker"], h["currency"])
            if prev_usd is not None:
                daily_change_usd   = round((price_usd - prev_usd) * h["quantity"], 2)
                daily_change_pct   = round((price_usd - prev_usd) / prev_usd * 100, 2)
                prev_local         = usd_to_local(prev_usd, h["currency"])
                daily_change_local = round((price_local - prev_local) * h["quantity"], 2) \
                                     if (price_local and prev_local) else None
            else:
                daily_change_usd   = None
                daily_change_pct   = None
                daily_change_local = None

            h["market_value_usd"]   = market_value_usd
            h["cost_basis_usd"]     = cost_basis_usd
            h["gain_loss_usd"]      = gain_loss_usd
            h["gain_loss_pct"]      = gain_pct
            h["market_value_local"] = market_value_local
            h["gain_loss_local"]    = gain_loss_local
            h["daily_change_usd"]   = daily_change_usd
            h["daily_change_pct"]   = daily_change_pct
            h["daily_change_local"] = daily_change_local
        else:
            h["market_value_usd"]   = None
            h["cost_basis_usd"]     = None
            h["gain_loss_usd"]      = None
            h["gain_loss_pct"]      = None
            h["market_value_local"] = None
            h["gain_loss_local"]    = None
            h["daily_change_usd"]   = None
            h["daily_change_pct"]   = None
            h["daily_change_local"] = None

        result_list.append(h)

    # Totals by currency
    by_currency = {}
    for h in result_list:
        ccy = h["currency"]
        if ccy not in by_currency:
            by_currency[ccy] = {"value_usd": 0, "cost_usd": 0, "value_local": 0, "count": 0}
        if h["market_value_usd"] is not None:
            by_currency[ccy]["value_usd"]   += h["market_value_usd"]
            by_currency[ccy]["cost_usd"]    += h["cost_basis_usd"]
            by_currency[ccy]["value_local"] += h["market_value_local"] or 0
            by_currency[ccy]["count"]       += 1

    currency_totals = []
    for ccy, data in by_currency.items():
        gain = round(data["value_usd"] - data["cost_usd"], 2)
        pct  = round(gain / data["cost_usd"] * 100, 2) if data["cost_usd"] else 0
        currency_totals.append({
            "currency":           ccy,
            "market_value_usd":   round(data["value_usd"],   2),
            "market_value_local": round(data["value_local"], 2),
            "gain_loss_usd":      gain,
            "gain_loss_pct":      pct,
            "count":              data["count"],
        })

    all_values  = [h["market_value_usd"] for h in result_list if h["market_value_usd"] is not None]
    all_costs   = [h["cost_basis_usd"]   for h in result_list if h["cost_basis_usd"]   is not None]
    total_value = round(sum(all_values), 2) if all_values else None
    total_cost  = round(sum(all_costs),  2) if all_costs  else None
    total_gain  = round(total_value - total_cost, 2) if (total_value and total_cost) else None
    total_pct   = round(total_gain / total_cost * 100, 2) if (total_gain and total_cost) else None

    fx_rates_display = {}
    for currency, fx_ticker in FX_TICKERS.items():
        rate = _get_cached(fx_ticker)
        if rate:
            fx_rates_display[currency] = round(rate, 2)

    from database import get_connection
    conn2 = get_connection()
    latest = conn2.execute("SELECT MAX(fetched_at) as t FROM price_cache").fetchone()
    conn2.close()
    prices_as_of = latest["t"] if latest and latest["t"] else None

    return {
        "holdings": result_list,
        "summary": {
            "total_market_value_usd": total_value,
            "total_cost_basis_usd":   total_cost,
            "total_gain_loss_usd":    total_gain,
            "total_gain_loss_pct":    total_pct,
            "by_currency":            currency_totals,
            "count":                  len(result_list),
            "fx_rates":               fx_rates_display,
            "prices_as_of":           prices_as_of,
        }
    }


@app.post("/holdings", status_code=201)
def create_holding(holding: HoldingIn, user_id: str = Depends(get_current_user)):
    # Verify broker belongs to this user
    broker_check = db.table("brokers").select("id").eq("id", holding.broker_id).eq("user_id", user_id).execute()
    if not broker_check.data:
        raise HTTPException(status_code=404, detail=f"Broker id {holding.broker_id} not found")

    try:
        trade_date = holding.purchase_date or datetime.now(timezone.utc).date().isoformat()

        # Check if a holding already exists for this ticker + broker
        existing = db.table("holdings").select("*") \
            .eq("user_id", user_id) \
            .eq("ticker", holding.ticker) \
            .eq("broker_id", holding.broker_id) \
            .execute()

        if existing.data:
            # Merge: weighted average price, combined quantity
            ex = existing.data[0]
            new_qty = round(ex["quantity"] + holding.quantity, 6)
            new_avg = round(
                (ex["quantity"] * ex["avg_buy_price"] + holding.quantity * holding.avg_buy_price) / new_qty, 4
            )
            result = db.table("holdings").update({
                "quantity":      new_qty,
                "avg_buy_price": new_avg,
                "updated_at":    datetime.now(timezone.utc).isoformat(),
            }).eq("id", ex["id"]).eq("user_id", user_id).execute()
            saved = result.data[0]
        else:
            row = {
                "user_id":       user_id,
                "broker_id":     holding.broker_id,
                "ticker":        holding.ticker,
                "name":          holding.name.strip() or holding.ticker,
                "quantity":      holding.quantity,
                "avg_buy_price": holding.avg_buy_price,
                "currency":      holding.currency,
                "asset_type":    holding.asset_type,
                "notes":         holding.notes.strip(),
            }
            if holding.purchase_date:
                row["purchase_date"] = holding.purchase_date
            result = db.table("holdings").insert(row).execute()
            saved = result.data[0]

        # Always record a BUY transaction for this purchase
        db.table("transactions").insert({
            "user_id":    user_id,
            "ticker":     holding.ticker,
            "name":       holding.name.strip() or holding.ticker,
            "type":       "buy",
            "quantity":   holding.quantity,
            "price":      holding.avg_buy_price,
            "currency":   holding.currency,
            "broker_id":  holding.broker_id,
            "trade_date": trade_date,
            "notes":      holding.notes.strip() or "",
        }).execute()

        return saved
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not create holding: {e}")


@app.put("/holdings/{holding_id}")
def update_holding(holding_id: int, holding: HoldingIn, user_id: str = Depends(get_current_user)):
    # Verify broker belongs to this user
    broker_check = db.table("brokers").select("id").eq("id", holding.broker_id).eq("user_id", user_id).execute()
    if not broker_check.data:
        raise HTTPException(status_code=404, detail=f"Broker id {holding.broker_id} not found")

    update_data = {
        "broker_id":     holding.broker_id,
        "ticker":        holding.ticker,
        "name":          holding.name.strip() or holding.ticker,
        "quantity":      holding.quantity,
        "avg_buy_price": holding.avg_buy_price,
        "currency":      holding.currency,
        "asset_type":    holding.asset_type,
        "notes":         holding.notes.strip(),
        "updated_at":    datetime.now(timezone.utc).isoformat(),
    }
    if holding.purchase_date is not None:
        update_data["purchase_date"] = holding.purchase_date or None
    result = db.table("holdings").update(update_data).eq("id", holding_id).eq("user_id", user_id).execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Holding not found")
    return result.data[0]


@app.delete("/holdings/{holding_id}")
def delete_holding(holding_id: int, user_id: str = Depends(get_current_user)):
    result = db.table("holdings").delete().eq("id", holding_id).eq("user_id", user_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Holding not found")
    return {"deleted": True}


@app.post("/holdings/merge-duplicates")
def merge_duplicate_holdings(user_id: str = Depends(get_current_user)):
    """
    Find all (ticker, broker_id) groups with multiple holding rows, merge them into
    one row using weighted-average price, and create a BUY transaction for each
    original row so the purchase history is preserved.
    """
    from collections import defaultdict

    holdings = db.table("holdings").select("*").eq("user_id", user_id).execute().data
    groups: dict = defaultdict(list)
    for h in holdings:
        groups[(h["ticker"], h.get("broker_id"))].append(h)

    merged_count = 0
    txn_count    = 0

    for (ticker, broker_id), rows in groups.items():
        if len(rows) <= 1:
            continue

        rows.sort(key=lambda x: x.get("id", 0))   # oldest row becomes primary
        total_qty   = sum(r["quantity"] for r in rows)
        weighted_avg = sum(r["quantity"] * r["avg_buy_price"] for r in rows) / total_qty

        # Create a BUY transaction for every original row
        for r in rows:
            trade_date = r.get("purchase_date") or (r.get("created_at") or "")[:10] \
                         or datetime.now(timezone.utc).date().isoformat()
            db.table("transactions").insert({
                "user_id":    user_id,
                "ticker":     ticker,
                "name":       r.get("name", ticker),
                "type":       "buy",
                "quantity":   r["quantity"],
                "price":      r["avg_buy_price"],
                "currency":   r["currency"],
                "broker_id":  broker_id,
                "trade_date": trade_date,
                "notes":      "Merged from duplicate holding",
            }).execute()
            txn_count += 1

        # Update primary row with merged totals
        primary = rows[0]
        db.table("holdings").update({
            "quantity":      round(total_qty, 6),
            "avg_buy_price": round(weighted_avg, 4),
            "updated_at":    datetime.now(timezone.utc).isoformat(),
        }).eq("id", primary["id"]).eq("user_id", user_id).execute()

        # Delete the duplicate rows (all but primary)
        for r in rows[1:]:
            db.table("holdings").delete().eq("id", r["id"]).eq("user_id", user_id).execute()

        merged_count += 1

    return {"merged_groups": merged_count, "transactions_created": txn_count}


# ─────────────────────────────────────────────
#  PORTFOLIO HISTORY
# ─────────────────────────────────────────────

@app.get("/portfolio/history")
def portfolio_history(period: str = "30d", currency: str = "All", user_id: str = Depends(get_current_user)):
    if period not in VALID_PERIODS:
        raise HTTPException(status_code=400, detail=f"period must be one of {VALID_PERIODS}")

    result   = db.table("holdings").select("ticker, quantity, avg_buy_price, currency").eq("user_id", user_id).execute()
    history  = get_portfolio_history(result.data, period, currency)
    return {"period": period, "currency": currency, "history": history}


# ─────────────────────────────────────────────
#  PRICES  (single ticker lookup)
# ─────────────────────────────────────────────

@app.get("/prices/{ticker}")
def get_ticker_price(ticker: str, currency: str = "USD", user_id: str = Depends(get_current_user)):
    ticker   = ticker.strip().upper()
    currency = currency.strip().upper()

    if currency not in VALID_CURRENCIES:
        raise HTTPException(status_code=400, detail=f"currency must be one of {VALID_CURRENCIES}")

    from prices import _get_cached
    was_cached = _get_cached(ticker) is not None
    price      = get_price_usd(ticker, currency)

    if price is None:
        raise HTTPException(status_code=404, detail=f"Could not fetch price for '{ticker}'.")

    return {"ticker": ticker, "price_usd": price, "currency": currency, "from_cache": was_cached}


# ─────────────────────────────────────────────
#  AI ANALYTICS
# ─────────────────────────────────────────────

@app.get("/sparklines")
def get_sparklines(tickers: str = Query(...), user_id: str = Depends(get_current_user)):
    """Return 7-day closing prices for a comma-separated list of tickers."""
    ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    if not ticker_list:
        return {}
    try:
        import yfinance as yf
        with _YF_LOCK:
            data = yf.download(ticker_list, period="10d", interval="1d",
                               auto_adjust=True, progress=False, threads=False)
        result = {}
        close = data["Close"]
        # Flatten MultiIndex columns (newer yfinance returns (Price, Ticker) MultiIndex)
        if hasattr(close, 'columns') and isinstance(close.columns, pd.MultiIndex):
            close.columns = close.columns.get_level_values(-1)  # last level = Ticker
        if len(ticker_list) == 1:
            # Single ticker may come back as Series or single-column DataFrame
            if hasattr(close, 'columns'):
                series = close.iloc[:, 0].dropna()
            else:
                series = close.dropna()
            prices = series.tolist()[-7:]
            result[ticker_list[0]] = [round(p, 2) for p in prices]
        else:
            for t in ticker_list:
                if t in close.columns:
                    prices = close[t].dropna().tolist()[-7:]
                    result[t] = [round(p, 2) for p in prices]
        return result
    except Exception as e:
        return {}


@app.get("/analytics/models")
def list_gemini_models(user_id: str = Depends(get_current_user)):
    api_key = os.getenv("GEMINI_API_KEY")
    r = requests.get(f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}", timeout=10)
    models = r.json().get("models", [])
    return [{"name": m["name"], "methods": m.get("supportedGenerationMethods",[])} for m in models]

# ── Technical Scoring Engine ─────────────────────────────────────────────────
def get_technical_scores(tickers: list) -> dict:
    """
    Compute a 0-100 technical opportunity score for each ticker.
    Signals: 30d return (30%), 90d return (20%), MA cross (20%), RSI-14 (15%), volatility (15%).
    Results are cached in SQLite for 6 hours.
    Returns {ticker: {"score": float, "ret_30d": float, "ret_90d": float,
                       "rsi": float, "vol": float, "ma_signal": str}}
    """
    import sqlite3, time, json
    from statistics import mean, stdev as _stdev
    try:
        import yfinance as yf
    except ImportError:
        return {t: {"score": 50.0} for t in tickers}

    cache_path = os.path.join(os.path.dirname(__file__), "price_cache.db")
    conn = sqlite3.connect(cache_path)
    conn.execute("""CREATE TABLE IF NOT EXISTS tech_scores
                    (ticker TEXT PRIMARY KEY, score REAL, detail TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 6 * 3600
    now       = time.time()
    results   = {}
    to_fetch  = []

    for t in tickers:
        row = conn.execute("SELECT score, detail, ts FROM tech_scores WHERE ticker=?", (t,)).fetchone()
        if row and (now - row[2]) < cache_ttl:
            try:
                results[t] = {"score": row[0], **json.loads(row[1])}
            except Exception:
                results[t] = {"score": row[0]}
        else:
            to_fetch.append(t)

    if to_fetch:
        try:
            with _YF_LOCK:
                raw = yf.download(
                    to_fetch if len(to_fetch) > 1 else to_fetch[0],
                    period="90d", auto_adjust=True, progress=False, threads=False
                )
            # Normalise to dict of {ticker: [price, ...]}
            price_series = {}
            close = raw["Close"]
            # Flatten MultiIndex columns (newer yfinance returns (Price, Ticker) MultiIndex)
            if hasattr(close, 'columns') and isinstance(close.columns, pd.MultiIndex):
                close.columns = close.columns.get_level_values(-1)  # last level = Ticker
            if len(to_fetch) == 1:
                # Single ticker: may be a Series or single-column DataFrame
                if isinstance(close, pd.DataFrame):
                    price_series[to_fetch[0]] = close.iloc[:, 0].dropna().tolist()
                else:
                    price_series[to_fetch[0]] = close.dropna().tolist()
            else:
                for t in to_fetch:
                    try:
                        price_series[t] = close[t].dropna().tolist()
                    except Exception:
                        price_series[t] = []
        except Exception:
            price_series = {t: [] for t in to_fetch}

        def norm_ret(r, lo=-20, hi=60):
            """Map a return% to 0-100, clamped to [lo, hi]."""
            return max(0.0, min(100.0, (max(lo, min(hi, r)) - lo) / (hi - lo) * 100))

        for ticker in to_fetch:
            prices = price_series.get(ticker, [])
            if len(prices) < 20:
                results[ticker] = {"score": 50.0}
                conn.execute("INSERT OR REPLACE INTO tech_scores VALUES (?,?,?,?)",
                             (ticker, 50.0, "{}", now))
                continue
            try:
                # ── 1. Momentum: 30d and 90d returns ─────────────────────
                idx30  = max(0, len(prices) - 31)
                ret30  = (prices[-1] - prices[idx30]) / prices[idx30] * 100
                ret90  = (prices[-1] - prices[0])     / prices[0]     * 100

                # ── 2. Moving-average cross (price vs MA20 & MA50) ───────
                ma20 = mean(prices[-20:])
                ma50 = mean(prices[-min(50, len(prices)):])
                cur  = prices[-1]
                if   cur > ma50 and cur > ma20: ma_score, ma_signal = 100, "above MA20 & MA50"
                elif cur > ma20:                ma_score, ma_signal =  65, "above MA20 only"
                elif cur > ma50:                ma_score, ma_signal =  50, "above MA50 only"
                else:                           ma_score, ma_signal =  15, "below MA20 & MA50"

                # ── 3. RSI-14 ─────────────────────────────────────────────
                changes = [prices[i] - prices[i-1] for i in range(1, len(prices))]
                recent14 = changes[-14:]
                avg_gain = mean([c for c in recent14 if c > 0] or [0])
                avg_loss = mean([-c for c in recent14 if c < 0] or [0.0001])
                rsi = 100 - 100 / (1 + avg_gain / avg_loss)
                if   45 <= rsi <= 65: rsi_score = 100   # ideal range
                elif 35 <= rsi <  45: rsi_score =  70   # slightly oversold — still opportunity
                elif 65 <  rsi <= 75: rsi_score =  55   # approaching overbought
                elif 25 <= rsi <  35: rsi_score =  35   # oversold
                elif rsi > 75:        rsi_score =  20   # overbought
                else:                 rsi_score =  15   # very oversold

                # ── 4. 20-day volatility (annualised daily std dev) ──────
                daily_rets = [(prices[i] - prices[i-1]) / prices[i-1] for i in range(1, len(prices))]
                vol20 = _stdev(daily_rets[-20:]) * 100 if len(daily_rets) >= 2 else 3.0
                if   vol20 < 1.0: vol_score = 95
                elif vol20 < 1.5: vol_score = 85
                elif vol20 < 2.0: vol_score = 72
                elif vol20 < 3.0: vol_score = 55
                elif vol20 < 5.0: vol_score = 30
                else:             vol_score = 12

                # ── Composite ─────────────────────────────────────────────
                score = (
                    norm_ret(ret30) * 0.30 +
                    norm_ret(ret90) * 0.20 +
                    ma_score        * 0.20 +
                    rsi_score       * 0.15 +
                    vol_score       * 0.15
                )
                detail = {
                    "ret_30d":   round(ret30, 1),
                    "ret_90d":   round(ret90, 1),
                    "rsi":       round(rsi,   1),
                    "vol":       round(vol20, 2),
                    "ma_signal": ma_signal,
                }
                results[ticker] = {"score": round(score, 1), **detail}
                conn.execute("INSERT OR REPLACE INTO tech_scores VALUES (?,?,?,?)",
                             (ticker, round(score, 1), json.dumps(detail), now))
            except Exception:
                results[ticker] = {"score": 50.0}
                conn.execute("INSERT OR REPLACE INTO tech_scores VALUES (?,?,?,?)",
                             (ticker, 50.0, "{}", now))

        conn.commit()

    conn.close()
    return results


@app.get("/analytics/ai")
def ai_analytics(user_id: str = Depends(get_current_user)):
    """Analyse the user's portfolio and return insights."""
    # Fetch holdings with prices
    result = db.table("holdings").select("*, brokers(name)").eq("user_id", user_id).execute()
    holdings = []
    for h in result.data:
        broker_info = h.pop("brokers", {}) or {}
        h["broker_name"] = broker_info.get("name", "Unknown")
        holdings.append(h)

    if not holdings:
        return {"insights": "No holdings found. Add some holdings first."}

    ticker_currency_pairs = [(h["ticker"], h["currency"]) for h in holdings]
    prices = get_prices_batch(ticker_currency_pairs)

    enriched = []
    total_value = 0
    total_cost  = 0
    for h in holdings:
        price_usd = prices.get(h["ticker"])
        cost_usd  = convert_to_usd(h["avg_buy_price"], h["currency"])
        if price_usd and cost_usd:
            mv  = round(h["quantity"] * price_usd, 2)
            cb  = round(h["quantity"] * cost_usd,  2)
            gl  = round(mv - cb, 2)
            pct = round(gl / cb * 100, 2) if cb > 0 else 0
            total_value += mv
            total_cost  += cb
            enriched.append({
                "ticker": h["ticker"], "currency": h["currency"],
                "mv": mv, "cb": cb, "pct": pct,
                "price_usd": price_usd, "cost_usd": cost_usd,
            })

    total_gain_pct = round((total_value - total_cost) / total_cost * 100, 2) if total_cost > 0 else 0

    # ── Technical scores (cached 6h) ──────────────────────────────────────
    all_tickers  = [e["ticker"] for e in enriched]
    tech_results = get_technical_scores(all_tickers)
    for e in enriched:
        td = tech_results.get(e["ticker"], {})
        e["tech_score"] = td.get("score", 50.0)
        e["tech_detail"] = td

    # Sort by market value descending; send top 35 as individual rows,
    # summarise the rest — keeps prompt token count manageable at any scale.
    enriched.sort(key=lambda x: x["mv"], reverse=True)
    TOP_N    = 35
    top      = enriched[:TOP_N]
    rest     = enriched[TOP_N:]

    top_rows = [
        f"{e['ticker']} ({e['currency']}): current=${e['price_usd']:.2f}, "
        f"avg_buy=${e['cost_usd']:.2f}, mkt_val=${e['mv']:,.0f}, "
        f"return={e['pct']:+.1f}%, tech_score={e['tech_score']:.0f}/100"
        for e in top
    ]

    rest_block = ""
    if rest:
        rest_val      = sum(e["mv"]  for e in rest)
        rest_avg_pct  = sum(e["pct"] for e in rest) / len(rest)
        rest_block    = (
            f"\n+ {len(rest)} smaller holdings not listed: "
            f"combined ${rest_val:,.0f} ({rest_val/total_value*100:.0f}% of portfolio), "
            f"avg return {rest_avg_pct:+.1f}%"
        )

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    prompt = f"""You are a portfolio AI copilot. Today's date is {today}. Analyse this portfolio and respond ONLY with valid JSON — no markdown, no text outside the JSON.

Return exactly this JSON structure:
{{
  "health_score": <integer 0-100>,
  "health_label": "<Excellent|Good|Fair|Poor>",
  "confidence": <integer 50-95, your confidence in this analysis based on data completeness>,
  "verdict": "<one sharp sentence max 15 words: current state + biggest lever>",
  "plain_summary": {{
    "strong": ["<ticker or theme that is performing well>", "<another strength>"],
    "weak": ["<ticker or theme that is underperforming>", "<another weakness>"],
    "issues": ["<structural issue e.g. overconcentration, currency risk>"],
    "action": "<one imperative sentence: what to do first>"
  }},
  "scores": {{
    "diversification": <integer 0-100>,
    "momentum": <integer 0-100>,
    "risk": <integer 0-100>,
    "value": <integer 0-100>
  }},
  "score_reasons": {{
    "positives": ["<specific positive 1>", "<specific positive 2>", "<specific positive 3>"],
    "negatives": ["<specific negative 1>", "<specific negative 2>", "<specific negative 3>"]
  }},
  "actions": [
    {{"ticker": "<TICKER>", "action": "<BUY|HOLD|REDUCE|WATCH>", "reason": "<one line>", "impact": "<High|Medium|Low>"}}
  ],
  "top_risk": {{
    "ticker": "<single most concerning holding>",
    "reasons": ["<risk 1>", "<risk 2>", "<risk 3>"],
    "consequence": ["<what happens if you do nothing — 2 short bullet points>", "<second consequence>"]
  }},
  "star_pick": "<single best opportunity ticker>",
  "star_pick_reason": "<one sentence conviction>",
  "portfolio_dna": {{
    "type": "<e.g. Growth Heavy|Balanced|Income|Speculative|Defensive>",
    "personality": "<2-4 word investor archetype e.g. Opportunistic Growth Investor>",
    "breakdown": [
      {{"label": "<style e.g. Growth>", "pct": <integer>, "icon": "<single emoji>"}},
      {{"label": "<style e.g. Global Exposure>", "pct": <integer>, "icon": "<single emoji>"}},
      {{"label": "<style e.g. Risk Level>", "pct": <integer>, "icon": "<single emoji>"}}
    ]
  }}
}}

scores: diversification=sector/currency spread (100=very diversified), momentum=holdings showing strength (100=all performing well), risk=inverse concentration (100=low risk), value=return quality (100=all positive returns).
score_reasons: be specific, reference actual tickers or percentages.
actions: YOU MUST include exactly one entry for EVERY ticker listed above — no skipping. BUY=strong conviction to add; HOLD=keep as-is; REDUCE=trim position; WATCH=monitor closely. impact=High only if action materially changes portfolio risk/return.
top_risk: the single most concerning holding (worst risk-adjusted position).
star_pick: MUST be the ticker with the numerically highest positive return% from the list above. If all are negative pick least negative. Must NOT be the same ticker as top_risk.
portfolio_dna.breakdown: 3 items, pcts should sum to ~100, represent portfolio character.
confidence: lower if fewer holdings or missing data, higher if rich complete data.

Portfolio (USD):
Total Value=${total_value:,.0f} | Invested=${total_cost:,.0f} | Return={total_gain_pct:.1f}%
Top {len(top_rows)} holdings by value:
{chr(10).join(top_rows)}{rest_block}"""

    try:
        import json as _json, re as _re
        text  = llm_call(prompt, max_tokens=3500, temperature=0.1, tier="analysis")
        clean = _re.sub(r"```(?:json)?|```", "", text).strip()
        try:
            data = _json.loads(clean)
            # ── Deterministic override: composite technical + return score ──
            # 60% technical momentum score + 40% normalised overall return
            def _composite(e):
                t_score = e.get("tech_score", 50.0)
                # normalise return to 0-100: clamp [-20%, +200%]
                r_norm  = max(0.0, min(100.0, (max(-20, min(200, e["pct"])) + 20) / 220 * 100))
                return t_score * 0.60 + r_norm * 0.40

            risk_ticker = (data.get("top_risk") or {}).get("ticker", "")
            candidates  = [e for e in enriched if e["ticker"] != risk_ticker] or enriched
            best        = max(candidates, key=_composite)

            data["star_pick"] = best["ticker"]

            # Auto-generate a fact-based reason so it always matches the actual pick
            td = best.get("tech_detail", {})
            reason_parts = [f"tech score {best['tech_score']:.0f}/100"]
            if td.get("ret_30d") is not None:
                reason_parts.append(f"{td['ret_30d']:+.1f}% last 30 days")
            if td.get("ma_signal"):
                reason_parts.append(td["ma_signal"])
            if td.get("rsi") is not None:
                reason_parts.append(f"RSI {td['rsi']:.0f}")
            data["star_pick_reason"] = (
                f"Highest composite score ({_composite(best):.0f}/100): "
                + ", ".join(reason_parts)
                + f". Overall return {best['pct']:+.1f}%."
            )
            # Attach tech breakdown so frontend can display it
            data["star_pick_tech"] = {
                "score":     best["tech_score"],
                "ret_30d":   td.get("ret_30d"),
                "ret_90d":   td.get("ret_90d"),
                "rsi":       td.get("rsi"),
                "vol":       td.get("vol"),
                "ma_signal": td.get("ma_signal"),
                "overall_return": best["pct"],
            }
            return {"insights": data}
        except Exception:
            return {"insights": text}
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=502, detail=f"AI analysis failed: {e}")


# ─────────────────────────────────────────────
#  ASK AI — follow-up questions
# ─────────────────────────────────────────────

class AskIn(BaseModel):
    question: str

@app.post("/analytics/ask")
def ask_portfolio_ai(body: AskIn, user_id: str = Depends(get_current_user)):
    """Answer a specific question about the user's portfolio in plain language."""
    if not body.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    # Build brief portfolio context (top 15 by value)
    result   = db.table("holdings").select("*, brokers(name)").eq("user_id", user_id).execute()
    holdings = []
    for h in result.data:
        broker_info  = h.pop("brokers", {}) or {}
        h["broker_name"] = broker_info.get("name", "Unknown")
        holdings.append(h)

    if not holdings:
        return {"answer": "No holdings found in your portfolio."}

    ticker_currency_pairs = [(h["ticker"], h["currency"]) for h in holdings]
    prices     = get_prices_batch(ticker_currency_pairs)
    tech_data  = get_technical_scores([h["ticker"] for h in holdings])
    rows, total_value, total_cost = [], 0, 0
    for h in holdings:
        price = prices.get(h["ticker"])
        cost  = convert_to_usd(h["avg_buy_price"], h["currency"])
        if price and cost:
            mv  = h["quantity"] * price
            cb  = h["quantity"] * cost
            pct = (mv - cb) / cb * 100 if cb > 0 else 0
            total_value += mv
            total_cost  += cb
            td = tech_data.get(h["ticker"], {})
            rows.append({
                "ticker": h["ticker"], "mv": mv, "pct": pct,
                "currency": h["currency"],
                "tech_score": td.get("score", 50),
                "ret_30d": td.get("ret_30d"),
            })

    rows.sort(key=lambda x: x["mv"], reverse=True)
    context_parts = []
    for r in rows[:20]:
        line = f"{r['ticker']} ({r['currency']}): ${r['mv']:,.0f} ({r['pct']:+.1f}% overall), tech={r['tech_score']:.0f}/100"
        if r["ret_30d"] is not None:
            line += f", 30d={r['ret_30d']:+.1f}%"
        context_parts.append(line)
    context = "\n".join(context_parts)
    total_gain_pct = (total_value - total_cost) / total_cost * 100 if total_cost else 0
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    prompt = f"""You are a helpful portfolio analyst. Today is {today}. Answer the following question about this portfolio concisely and specifically (2-4 sentences). Reference actual tickers and numbers from the portfolio. Do not give generic financial advice. Start with a direct answer.

Portfolio: ${total_value:,.0f} total | ${total_cost:,.0f} invested | {total_gain_pct:+.1f}% overall return
Holdings (top 20 by value):
{context}

Question: {body.question}"""

    try:
        return {"answer": llm_call(prompt, max_tokens=400, temperature=0.65, tier="ask")}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ask AI failed: {e}")


# ─────────────────────────────────────────────
#  BENCHMARK COMPARISON
# ─────────────────────────────────────────────

@app.get("/analytics/benchmark")
def analytics_benchmark(user_id: str = Depends(get_current_user)):
    """Return 1Y return for Nifty 50 and S&P 500 for benchmark comparison."""
    try:
        import yfinance as yf
        with _YF_LOCK:
            data = yf.download(["^NSEI", "^GSPC"], period="1y", interval="1d",
                               auto_adjust=True, progress=False, threads=False)
        close = data["Close"] if "Close" in data.columns else data
        # Flatten MultiIndex columns if present (newer yfinance)
        if hasattr(close, 'columns') and isinstance(close.columns, pd.MultiIndex):
            close.columns = close.columns.get_level_values(0)
        result = {}
        for ticker, label in [("^NSEI", "Nifty 50"), ("^GSPC", "S&P 500")]:
            if ticker in close.columns:
                prices = close[ticker].squeeze().dropna()
                if len(prices) >= 2:
                    first_p = float(prices.iloc[0])
                    last_p  = float(prices.iloc[-1])
                    result[label] = round((last_p - first_p) / first_p * 100, 2)
        return result
    except Exception:
        return {}


# ─────────────────────────────────────────────
#  TICKER SEARCH
# ─────────────────────────────────────────────

@app.get("/search/ticker")
def search_ticker(q: str = Query(..., min_length=1), user_id: str = Depends(get_current_user)):
    """
    Search Yahoo Finance for tickers by company name or symbol.
    Returns up to 10 results with ticker, name, exchange, currency.
    """
    if not q.strip():
        return []
    try:
        resp = requests.get(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": q, "lang": "en-US", "quotesCount": 10, "newsCount": 0},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=5,
        )
        resp.raise_for_status()
        quotes = resp.json().get("quotes", [])
        results = []
        for item in quotes:
            qtype = item.get("quoteType", "")
            if qtype not in ("EQUITY", "ETF", "MUTUALFUND"):
                continue
            results.append({
                "ticker":   item.get("symbol", ""),
                "name":     item.get("longname") or item.get("shortname") or item.get("symbol"),
                "exchange": item.get("exchDisp", item.get("exchange", "")),
                "currency": item.get("currency", ""),
                "type":     qtype,
            })
        return results
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Search failed: {e}")


# ─────────────────────────────────────────────
#  CSV IMPORT
# ─────────────────────────────────────────────

@app.post("/import/csv", status_code=201)
async def import_csv(
    broker_id: int        = Form(...),
    file:      UploadFile = File(...),
    replace:   str        = Form("false"),   # "true" = delete all existing holdings first
    user_id:   str        = Depends(get_current_user),
):
    # Verify broker belongs to this user
    broker_result = db.table("brokers").select("id, name, currency").eq("id", broker_id).eq("user_id", user_id).execute()
    if not broker_result.data:
        raise HTTPException(status_code=404, detail=f"Broker id {broker_id} not found")

    broker = broker_result.data[0]

    raw_bytes = await file.read()
    try:
        content = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        content = raw_bytes.decode("latin-1")

    if not content.strip():
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        parsed_holdings = parse_csv(broker["name"], content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not parsed_holdings:
        raise HTTPException(status_code=400, detail="No holdings found in file.")

    # If replace=true, wipe all existing holdings for this broker before inserting
    deleted = 0
    if replace.lower() == "true":
        del_result = db.table("holdings").delete().eq("broker_id", broker_id).eq("user_id", user_id).execute()
        deleted = len(del_result.data) if del_result.data else 0

    imported = 0
    skipped  = 0
    results  = []

    for h in parsed_holdings:
        try:
            existing = db.table("holdings").select("id").eq("broker_id", broker_id).eq("ticker", h["ticker"]).eq("user_id", user_id).execute()

            if existing.data:
                update_row = {
                    "quantity":      h["quantity"],
                    "avg_buy_price": h["avg_buy_price"],
                    "updated_at":    datetime.now(timezone.utc).isoformat(),
                }
                # Only backfill purchase_date if the holding has none yet
                existing_full = db.table("holdings").select("purchase_date").eq("id", existing.data[0]["id"]).execute()
                if h.get("purchase_date") and not (existing_full.data and existing_full.data[0].get("purchase_date")):
                    update_row["purchase_date"] = h["purchase_date"]
                db.table("holdings").update(update_row).eq("id", existing.data[0]["id"]).execute()
                action = "updated"
            else:
                insert_row = {
                    "user_id":       user_id,
                    "broker_id":     broker_id,
                    "ticker":        h["ticker"],
                    "name":          h.get("name", h["ticker"]),
                    "quantity":      h["quantity"],
                    "avg_buy_price": h["avg_buy_price"],
                    "currency":      h.get("currency", broker["currency"]),
                    "asset_type":    "stock",
                }
                if h.get("purchase_date"):
                    insert_row["purchase_date"] = h["purchase_date"]
                db.table("holdings").insert(insert_row).execute()
                action = "inserted"

            imported += 1
            results.append({**h, "action": action})

        except Exception as e:
            skipped += 1
            results.append({**h, "action": "error", "error": str(e)})

    return {"imported": imported, "skipped": skipped, "deleted": deleted, "holdings": results}


# ─────────────────────────────────────────────
#  ANALYTICS — SECTORS
# ─────────────────────────────────────────────

@app.get("/analytics/sectors")
def analytics_sectors(user_id: str = Depends(get_current_user)):
    """Return sector/industry classification for all user holdings. Cached 24 hours."""
    import sqlite3, time, json
    from concurrent.futures import ThreadPoolExecutor

    result  = db.table("holdings").select("ticker").eq("user_id", user_id).execute()
    tickers = list({h["ticker"] for h in result.data})
    if not tickers:
        return {"sectors": {}}

    cache_path = os.path.join(os.path.dirname(__file__), "price_cache.db")
    conn = sqlite3.connect(cache_path)
    conn.execute("""CREATE TABLE IF NOT EXISTS sector_cache
                    (ticker TEXT PRIMARY KEY, sector TEXT, industry TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 24 * 3600
    now       = time.time()
    results   = {}
    to_fetch  = []

    for t in tickers:
        row = conn.execute("SELECT sector, industry, ts FROM sector_cache WHERE ticker=?", (t,)).fetchone()
        if row and (now - row[2]) < cache_ttl:
            results[t] = {"sector": row[0] or "Unknown", "industry": row[1] or "Unknown"}
        else:
            to_fetch.append(t)

    if to_fetch:
        try:
            import yfinance as yf

            def _fetch_one(ticker):
                try:
                    info = yf.Ticker(ticker).info
                    return ticker, {
                        "sector":   info.get("sector")   or info.get("sectorKey")   or "Unknown",
                        "industry": info.get("industry") or info.get("industryKey") or "Unknown",
                    }
                except Exception:
                    return ticker, {"sector": "Unknown", "industry": "Unknown"}

            with ThreadPoolExecutor(max_workers=8) as exe:
                for ticker, data in exe.map(_fetch_one, to_fetch):
                    results[ticker] = data
                    conn.execute("INSERT OR REPLACE INTO sector_cache VALUES (?,?,?,?)",
                                 (ticker, data["sector"], data["industry"], now))
        except Exception:
            for t in to_fetch:
                results[t] = {"sector": "Unknown", "industry": "Unknown"}
                conn.execute("INSERT OR REPLACE INTO sector_cache VALUES (?,?,?,?)",
                             (t, "Unknown", "Unknown", now))
        conn.commit()

    conn.close()
    return {"sectors": results}


# ─────────────────────────────────────────────
#  ANALYTICS — 52-WEEK RANGE
# ─────────────────────────────────────────────

@app.get("/analytics/52week")
def analytics_52week(user_id: str = Depends(get_current_user)):
    """Return 52-week high/low + position_pct for every user holding. Cached 24 hours per ticker."""
    import sqlite3, time, json
    import yfinance as yf

    result  = db.table("holdings").select("ticker").eq("user_id", user_id).execute()
    tickers = list({h["ticker"] for h in result.data})
    if not tickers:
        return {}

    cache_path = os.path.join(os.path.dirname(__file__), "price_cache.db")
    conn = sqlite3.connect(cache_path)
    conn.execute("""CREATE TABLE IF NOT EXISTS week52_cache
                    (ticker TEXT PRIMARY KEY, data TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 24 * 3600
    now       = time.time()
    results   = {}
    to_fetch  = []

    for t in tickers:
        row = conn.execute("SELECT data, ts FROM week52_cache WHERE ticker=?", (t,)).fetchone()
        if row and (now - row[1]) < cache_ttl:
            try:
                cached = json.loads(row[0])
                # Skip empty {} cached results — they indicate a previous failed fetch
                if cached:
                    results[t] = cached
                else:
                    to_fetch.append(t)
            except Exception:
                to_fetch.append(t)
        else:
            to_fetch.append(t)

    def _compute_stats(prices: list) -> dict:
        """Compute 52-week stats + technicals from a list of closing prices."""
        if len(prices) < 10:
            return {}
        high52  = max(prices)
        low52   = min(prices)
        curr    = prices[-1]
        rng     = high52 - low52
        pos_pct = round((curr - low52) / rng * 100, 1) if rng > 0 else 50.0
        n50     = min(50, len(prices))
        dma50   = round(sum(prices[-n50:])  / n50,  2) if len(prices) >= 10 else None
        n200    = min(200, len(prices))
        dma200  = round(sum(prices[-n200:]) / n200, 2) if len(prices) >= 50 else None
        rsi     = None
        if len(prices) >= 15:
            deltas   = [prices[i] - prices[i-1] for i in range(1, len(prices))]
            last14   = deltas[-14:]
            avg_gain = sum(d for d in last14 if d > 0) / 14
            avg_loss = sum(-d for d in last14 if d < 0) / 14
            if avg_loss == 0:
                rsi = 100.0
            else:
                rsi = round(100 - (100 / (1 + avg_gain / avg_loss)), 1)
        return {
            "high52":       round(high52, 2),
            "low52":        round(low52,  2),
            "current":      round(curr,   2),
            "position_pct": pos_pct,
            "dma50":        dma50,
            "dma200":       dma200,
            "rsi":          rsi,
            "above_dma50":  (curr > dma50)  if dma50  is not None else None,
            "above_dma200": (curr > dma200) if dma200 is not None else None,
        }

    def _safe_yf_download(tickers_arg, period):
        """
        Thread-safe yfinance download. Holds _YF_LOCK so concurrent API calls
        from different FastAPI worker threads never corrupt each other's data.
        Returns a normalised close DataFrame (rows=dates, cols=tickers).
        """
        with _YF_LOCK:
            raw = yf.download(tickers_arg, period=period,
                              auto_adjust=False, progress=False, threads=False)
        if raw.empty:
            return pd.DataFrame()
        close = raw["Close"]
        if isinstance(close, pd.DataFrame):
            if isinstance(close.columns, pd.MultiIndex):
                close.columns = close.columns.get_level_values(-1)
            return close
        # Single-ticker Series → wrap to DataFrame
        name = tickers_arg if isinstance(tickers_arg, str) else tickers_arg[0]
        return close.to_frame(name=name)

    if to_fetch:
        # ── Download in small sequential chunks ───────────────────────────
        # Reason: one giant batch of 65 tickers takes 30-60s and holds _YF_LOCK
        # the whole time, starving all other endpoints (FX history, sparklines).
        # Chunks of 10 hold the lock for ~2-3s each → other endpoints can interleave.
        # No individual retries: a single-ticker retry on a failed/unlisted stock
        # can return data for a completely different security (Yahoo's best-guess
        # match), which then corrupts that ticker's stats with wrong prices.
        CHUNK = 10
        close_df = pd.DataFrame()

        for i in range(0, len(to_fetch), CHUNK):
            chunk     = to_fetch[i:i + CHUNK]
            chunk_arg = chunk if len(chunk) > 1 else chunk[0]
            try:
                chunk_df = _safe_yf_download(chunk_arg, "1y")
                if not chunk_df.empty:
                    if close_df.empty:
                        close_df = chunk_df
                    else:
                        # outer join: keep all dates from both, NaN where missing
                        close_df = close_df.join(chunk_df, how="outer")
            except Exception:
                pass

        # ── Compute stats and cache ───────────────────────────────────────
        for ticker in to_fetch:
            try:
                if ticker not in close_df.columns:
                    results[ticker] = {}
                    continue
                series = close_df[ticker].dropna()
                prices = [float(p) for p in series.tolist()]
                data   = _compute_stats(prices)
                results[ticker] = data
            except Exception:
                results[ticker] = {}
            conn.execute("INSERT OR REPLACE INTO week52_cache VALUES (?,?,?)",
                         (ticker, json.dumps(results[ticker]), now))
        conn.commit()

    conn.close()
    return results


# ─────────────────────────────────────────────
#  MARKETS — LIVE INDICES
# ─────────────────────────────────────────────

_INDEX_META = [
    {"symbol": "^NSEI",   "yf": "^NSEI",   "name": "NIFTY 50",   "color": "#3b82f6"},
    {"symbol": "^BSESN",  "yf": "^BSESN",  "name": "SENSEX",     "color": "#8b5cf6"},
    {"symbol": "^NSEBANK","yf": "^NSEBANK", "name": "BANK NIFTY", "color": "#ef4444"},
    {"symbol": "^GSPC",   "yf": "^GSPC",   "name": "S&P 500",    "color": "#10b981"},
    {"symbol": "^IXIC",   "yf": "^IXIC",   "name": "NASDAQ",     "color": "#f59e0b"},
    {"symbol": "GC=F",    "yf": "GC=F",    "name": "Gold",       "color": "#fbbf24"},
]

@app.get("/markets/indices")
def markets_indices(user_id: str = Depends(get_current_user)):
    """Return live prices + daily change for major indices. Cached 15 minutes."""
    import sqlite3, time, json

    cache_path = os.path.join(os.path.dirname(__file__), "price_cache.db")
    conn = sqlite3.connect(cache_path)
    conn.execute("""CREATE TABLE IF NOT EXISTS index_cache
                    (key TEXT PRIMARY KEY, data TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 15 * 60
    now       = time.time()

    row = conn.execute("SELECT data, ts FROM index_cache WHERE key='__all__'").fetchone()
    if row and (now - row[1]) < cache_ttl:
        conn.close()
        return json.loads(row[0])

    result = []
    try:
        import yfinance as yf
        syms  = [m["yf"] for m in _INDEX_META]
        # Pass tickers as a list so yfinance returns a MultiIndex DataFrame
        # with data["Close"] yielding a DataFrame keyed by ticker symbol
        with _YF_LOCK:
            raw = yf.download(syms, period="5d", interval="1d",
                              auto_adjust=False, progress=False, threads=False)
        close = raw["Close"]   # always a DataFrame when a list is passed

        for m in _INDEX_META:
            try:
                prices = close[m["yf"]].dropna().tolist()
                if len(prices) >= 2:
                    curr       = prices[-1]
                    prev       = prices[-2]
                    change_abs = round(curr - prev, 2)
                    change_pct = round((curr - prev) / prev * 100, 2)
                    result.append({**m, "price": round(curr, 2),
                                   "change_pct": change_pct, "change_abs": change_abs})
                else:
                    result.append({**m, "price": None, "change_pct": None, "change_abs": None})
            except Exception:
                result.append({**m, "price": None, "change_pct": None, "change_abs": None})
    except Exception:
        result = [{**m, "price": None, "change_pct": None, "change_abs": None} for m in _INDEX_META]

    conn.execute("INSERT OR REPLACE INTO index_cache VALUES (?,?,?)",
                 ("__all__", json.dumps(result), now))
    conn.commit()
    conn.close()
    return result


# ─────────────────────────────────────────────
#  ANALYTICS — FX HISTORY (quarterly FX drag)
# ─────────────────────────────────────────────

@app.get("/analytics/fx-history")
def analytics_fx_history(user_id: str = Depends(get_current_user)):
    """
    Historical FX depreciation for top 5 INR holdings.

    Method: keep current qty × current INR price fixed (stock effect = 0),
    vary only the USDINR rate at each of the last 4 quarter-ends.

    "Total 1Y FX Loss" = USD value at oldest quarter rate − USD value at current rate.
    A positive number means INR depreciated (holdings worth less in USD today than 1 year ago).
    """
    import sqlite3, time, json, math
    from datetime import date

    cache_path = os.path.join(os.path.dirname(__file__), "price_cache.db")
    conn = sqlite3.connect(cache_path)
    conn.execute("""CREATE TABLE IF NOT EXISTS fxhist_cache
                    (key TEXT PRIMARY KEY, data TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 24 * 3600
    now       = time.time()
    cache_key = f"fxhist_{user_id}"

    row = conn.execute("SELECT data, ts FROM fxhist_cache WHERE key=?", (cache_key,)).fetchone()
    if row and (now - row[1]) < cache_ttl:
        conn.close()
        return json.loads(row[0])

    # ── Fetch user's INR holdings ────────────────────────────
    result_data = db.table("holdings").select("ticker,quantity,avg_buy_price,currency") \
        .eq("user_id", user_id).execute()
    inr_holdings = [h for h in result_data.data if h.get("currency") == "INR"]

    empty = {"holdings": [], "quarters": [], "fx_rates": [],
             "portfolio_by_quarter": [], "total_fx_loss_1y": 0}

    if not inr_holdings:
        conn.execute("INSERT OR REPLACE INTO fxhist_cache VALUES (?,?,?)",
                     (cache_key, json.dumps(empty), now))
        conn.commit(); conn.close()
        return empty

    # ── Get current prices (USD) and convert back to INR ────
    ticker_ccy = [(h["ticker"], "INR") for h in inr_holdings]
    prices_usd = get_prices_batch(ticker_ccy)

    # ── Get current USDINR rate via Alpha Vantage ────────────
    from prices import _fetch_fx_rate_av, _fetch_fx_history_av
    current_usdinr = _get_cached("USDINR=X") or _fetch_fx_rate_av("INR") or 84.0
    if math.isnan(current_usdinr):
        current_usdinr = _fetch_fx_rate_av("INR") or 84.0

    for h in inr_holdings:
        p_usd = prices_usd.get(h["ticker"])
        if p_usd and current_usdinr:
            h["inr_value"] = round(h["quantity"] * p_usd * current_usdinr, 0)
        else:
            h["inr_value"] = None

    top5 = sorted(
        [h for h in inr_holdings if h.get("inr_value")],
        key=lambda x: x["inr_value"], reverse=True
    )[:5]

    if not top5:
        conn.execute("INSERT OR REPLACE INTO fxhist_cache VALUES (?,?,?)",
                     (cache_key, json.dumps(empty), now))
        conn.commit(); conn.close()
        return empty

    # ── Fetch USDINR daily history from Alpha Vantage ────────
    av_history = _fetch_fx_history_av("INR", days=400)   # ~13 months covers 4 quarter-ends
    if not av_history:
        conn.execute("INSERT OR REPLACE INTO fxhist_cache VALUES (?,?,?)",
                     (cache_key, json.dumps(empty), now))
        conn.commit(); conn.close()
        return empty

    # Build {date_str: rate} lookup for fast quarter-end lookups
    fx_lookup = {item["date"]: item["rate"] for item in av_history}

    # ── Find last 4 quarter-end dates that have passed ───────
    today_d = date.today()
    all_qe  = []
    for yr in [today_d.year - 1, today_d.year]:
        all_qe += [date(yr, 3, 31), date(yr, 6, 30), date(yr, 9, 30), date(yr, 12, 31)]
    past_qe = sorted([d for d in all_qe if d < today_d])[-4:]

    def quarter_label(d):
        q = (d.month - 1) // 3 + 1
        return f"Q{q} '{str(d.year)[2:]}"

    def find_fx_rate(target_date):
        """Return USDINR for the last available trading day in the quarter's final month."""
        # Prefer: last trading day in the final month of that quarter
        month_entries = [
            (ds, r) for ds, r in fx_lookup.items()
            if ds[:7] == target_date.strftime("%Y-%m")
        ]
        if month_entries:
            return round(sorted(month_entries)[-1][1], 2)
        # Fallback: last trading day on or before the quarter-end date
        target_str = target_date.strftime("%Y-%m-%d")
        before = [(ds, r) for ds, r in fx_lookup.items() if ds <= target_str]
        if before:
            return round(sorted(before)[-1][1], 2)
        return None

    quarters  = [quarter_label(d) for d in past_qe] + ["Now"]
    fx_rates  = [find_fx_rate(d) for d in past_qe] + [round(current_usdinr, 2)]

    # ── Compute per-holding USD values at each quarter rate ──
    holdings_out = []
    portfolio_by_quarter = []

    for qi, rate in enumerate(fx_rates):
        total = sum(
            round(h["inr_value"] / rate, 0) if (rate and h["inr_value"]) else 0
            for h in top5
        )
        portfolio_by_quarter.append(round(total, 0))

    for h in top5:
        inr_val       = h["inr_value"]
        usd_by_qtr    = [
            round(inr_val / r, 0) if (r and inr_val) else None
            for r in fx_rates
        ]
        fx_loss_1y = None
        if usd_by_qtr[0] is not None and usd_by_qtr[-1] is not None:
            fx_loss_1y = round(usd_by_qtr[0] - usd_by_qtr[-1], 0)

        ticker_clean = h["ticker"].replace(".NS","").replace(".BO","").replace(".AE","")
        holdings_out.append({
            "ticker":        ticker_clean,
            "inr_value":     inr_val,
            "usd_by_quarter": usd_by_qtr,
            "fx_loss_1y":    fx_loss_1y,
        })

    total_fx_loss_1y = round(
        sum(h["fx_loss_1y"] for h in holdings_out if h["fx_loss_1y"] is not None), 0
    )

    result = {
        "holdings":             holdings_out,
        "quarters":             quarters,
        "fx_rates":             fx_rates,
        "portfolio_by_quarter": portfolio_by_quarter,
        "total_fx_loss_1y":     total_fx_loss_1y,
    }

    # Only cache if we got valid rates — don't store broken null results
    valid_rates = [r for r in fx_rates if r is not None]
    if len(valid_rates) >= 2:
        conn.execute("INSERT OR REPLACE INTO fxhist_cache VALUES (?,?,?)",
                     (cache_key, json.dumps(result), now))
        conn.commit()
    conn.close()
    return result


# ─────────────────────────────────────────────
#  ANALYTICS — FUNDAMENTAL DATA (PE, PB, Yield)
# ─────────────────────────────────────────────

@app.get("/analytics/fundamentals")
def analytics_fundamentals(user_id: str = Depends(get_current_user)):
    """
    Per-holding fundamental data: P/E, P/B, dividend yield, market cap, sector.
    Fetched from yfinance Ticker.info and cached for 7 days.
    """
    import sqlite3, time, json
    import yfinance as yf
    from concurrent.futures import ThreadPoolExecutor, as_completed

    result_data = db.table("holdings").select("ticker").eq("user_id", user_id).execute()
    tickers     = list({h["ticker"] for h in result_data.data})
    if not tickers:
        return {}

    cache_path = os.path.join(os.path.dirname(__file__), "price_cache.db")
    conn = sqlite3.connect(cache_path)
    conn.execute("""CREATE TABLE IF NOT EXISTS fundamentals_cache
                    (ticker TEXT PRIMARY KEY, data TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 7 * 24 * 3600   # 7 days — fundamentals change slowly
    now       = time.time()
    results   = {}
    to_fetch  = []

    for t in tickers:
        row = conn.execute("SELECT data, ts FROM fundamentals_cache WHERE ticker=?", (t,)).fetchone()
        if row and (now - row[1]) < cache_ttl:
            try:
                cached = json.loads(row[0])
                if cached:
                    results[t] = cached
                else:
                    to_fetch.append(t)
            except Exception:
                to_fetch.append(t)
        else:
            to_fetch.append(t)

    def fetch_fundamentals(ticker: str):
        try:
            info = yf.Ticker(ticker).info
            pe  = info.get("trailingPE")
            pb  = info.get("priceToBook")
            dy  = info.get("dividendYield")
            mc  = info.get("marketCap")
            return ticker, {
                "pe":         round(pe, 1)  if pe  else None,
                "pb":         round(pb, 2)  if pb  else None,
                "div_yield":  round(dy if dy > 1 else dy * 100, 2) if dy else None,
                "market_cap": mc,
                "sector":     info.get("sector")   or info.get("quoteType", ""),
                "industry":   info.get("industry") or "",
            }
        except Exception:
            return ticker, {}

    if to_fetch:
        with ThreadPoolExecutor(max_workers=5) as pool:
            futures = {pool.submit(fetch_fundamentals, t): t for t in to_fetch}
            for fut in as_completed(futures):
                ticker, data = fut.result()
                results[ticker] = data
                conn.execute("INSERT OR REPLACE INTO fundamentals_cache VALUES (?,?,?)",
                             (ticker, json.dumps(data), now))
        conn.commit()

    conn.close()
    return results


# ─────────────────────────────────────────────
#  ADMIN — CLEAR PRICE / 52W CACHE
# ─────────────────────────────────────────────

@app.post("/admin/clear-cache")
def admin_clear_cache(user_id: str = Depends(get_current_user)):
    """
    Force-clears all cached prices + 52-week data so fresh data is fetched on next request.
    Useful after backend upgrades or when prices look stale.
    """
    from database import get_connection
    import sqlite3

    # Clear SQLite price_cache (used for holdings page prices)
    try:
        conn = get_connection()
        conn.execute("DELETE FROM price_cache")
        conn.commit()
        conn.close()
    except Exception:
        pass

    # Clear price_cache.db (used for 52-week, sector, index, FII/DII caches)
    try:
        cache_path = os.path.join(os.path.dirname(__file__), "price_cache.db")
        conn2 = sqlite3.connect(cache_path)
        for tbl in ["week52_cache", "sector_cache", "index_cache", "fiidii_cache"]:
            try:
                conn2.execute(f"DELETE FROM {tbl}")
            except Exception:
                pass
        conn2.commit()
        conn2.close()
    except Exception:
        pass

    # Clear in-memory prev-close cache
    try:
        from prices import _prev_close_cache
        _prev_close_cache.clear()
    except Exception:
        pass

    return {"ok": True, "message": "All caches cleared. Prices will be refreshed on next load."}


# ─────────────────────────────────────────────
#  MARKETS — FII / DII FLOW
# ─────────────────────────────────────────────

@app.get("/markets/fiidii")
def markets_fiidii(user_id: str = Depends(get_current_user)):
    """Return FII/DII net institutional flow data. Cached 4 hours."""
    import sqlite3, time, json

    cache_path = os.path.join(os.path.dirname(__file__), "price_cache.db")
    conn = sqlite3.connect(cache_path)
    conn.execute("""CREATE TABLE IF NOT EXISTS fiidii_cache
                    (key TEXT PRIMARY KEY, data TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 4 * 3600
    now       = time.time()

    row = conn.execute("SELECT data, ts FROM fiidii_cache WHERE key='fiidii'").fetchone()
    if row and (now - row[1]) < cache_ttl:
        conn.close()
        return json.loads(row[0])

    payload = {"data": [], "source": "unavailable"}

    try:
        session = requests.Session()
        session.headers.update({
            "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept":          "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer":         "https://www.nseindia.com/",
        })
        # Seed cookies
        session.get("https://www.nseindia.com", timeout=8)
        session.get("https://www.nseindia.com/market-data/fii-dii-activity", timeout=8)

        resp = session.get(
            "https://www.nseindia.com/api/fiidiiTradeReact",
            timeout=10,
        )
        if resp.status_code == 200:
            raw  = resp.json()
            rows = raw if isinstance(raw, list) else []
            data = []
            for item in rows:
                try:
                    def _n(v):
                        return float(str(v).replace(",", "").replace("−", "-").strip() or "0")
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

    conn.execute("INSERT OR REPLACE INTO fiidii_cache VALUES (?,?,?)",
                 ("fiidii", json.dumps(payload), now))
    conn.commit()
    conn.close()


# ─────────────────────────────────────────────
#  TRANSACTIONS
# ─────────────────────────────────────────────

class TransactionIn(BaseModel):
    ticker:     str
    name:       str           = ""
    type:       str                       # buy | sell | dividend
    quantity:   float
    price:      float                     # in native currency
    currency:   str
    broker_id:  Optional[int] = None
    trade_date: str                       # "YYYY-MM-DD"
    notes:      str           = ""

    @field_validator("ticker")
    @classmethod
    def upper_ticker(cls, v): return v.strip().upper()

    @field_validator("type")
    @classmethod
    def valid_type(cls, v):
        v = v.strip().lower()
        if v not in ("buy", "sell", "dividend"):
            raise ValueError("type must be buy, sell, or dividend")
        return v

    @field_validator("currency")
    @classmethod
    def valid_ccy(cls, v):
        v = v.strip().upper()
        if v not in VALID_CURRENCIES:
            raise ValueError(f"currency must be one of {VALID_CURRENCIES}")
        return v

    @field_validator("quantity")
    @classmethod
    def positive_qty(cls, v):
        if v <= 0:
            raise ValueError("quantity must be positive")
        return v

    @field_validator("price")
    @classmethod
    def non_negative_price(cls, v):
        if v < 0:
            raise ValueError("price cannot be negative")
        return v


@app.get("/transactions")
def list_transactions(user_id: str = Depends(get_current_user)):
    result = (
        db.table("transactions")
        .select("*, brokers(name)")
        .eq("user_id", user_id)
        .order("trade_date", desc=True)
        .order("created_at", desc=True)
        .execute()
    )
    txns = []
    for t in result.data:
        b = t.pop("brokers", {}) or {}
        t["broker_name"] = b.get("name", "")
        txns.append(t)
    return txns


@app.post("/transactions", status_code=201)
def create_transaction(txn: TransactionIn, user_id: str = Depends(get_current_user)):
    if txn.broker_id:
        b = db.table("brokers").select("id").eq("id", txn.broker_id).eq("user_id", user_id).execute()
        if not b.data:
            raise HTTPException(status_code=404, detail=f"Broker {txn.broker_id} not found")
    result = db.table("transactions").insert({
        "user_id":    user_id,
        "ticker":     txn.ticker,
        "name":       txn.name.strip() or txn.ticker,
        "type":       txn.type,
        "quantity":   txn.quantity,
        "price":      txn.price,
        "currency":   txn.currency,
        "broker_id":  txn.broker_id,
        "trade_date": txn.trade_date,
        "notes":      txn.notes.strip(),
    }).execute()
    return result.data[0]


@app.put("/transactions/{txn_id}")
def update_transaction(txn_id: int, txn: TransactionIn, user_id: str = Depends(get_current_user)):
    result = db.table("transactions").update({
        "ticker":     txn.ticker,
        "name":       txn.name.strip() or txn.ticker,
        "type":       txn.type,
        "quantity":   txn.quantity,
        "price":      txn.price,
        "currency":   txn.currency,
        "broker_id":  txn.broker_id,
        "trade_date": txn.trade_date,
        "notes":      txn.notes.strip(),
    }).eq("id", txn_id).eq("user_id", user_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return result.data[0]


@app.delete("/transactions/{txn_id}")
def delete_transaction(txn_id: int, user_id: str = Depends(get_current_user)):
    # Fetch the transaction first so we know which holding to recalculate
    txn_res = db.table("transactions").select("*").eq("id", txn_id).eq("user_id", user_id).execute()
    if not txn_res.data:
        raise HTTPException(status_code=404, detail="Transaction not found")
    txn = txn_res.data[0]

    db.table("transactions").delete().eq("id", txn_id).eq("user_id", user_id).execute()

    # Recalculate the holding from remaining transactions for this ticker + broker
    broker_id = txn.get("broker_id")
    remaining_q = db.table("transactions").select("*") \
        .eq("user_id", user_id).eq("ticker", txn["ticker"])
    if broker_id:
        remaining_q = remaining_q.eq("broker_id", broker_id)
    remaining = remaining_q.execute().data

    buy_txns  = [t for t in remaining if t["type"] == "buy"]
    sell_txns = [t for t in remaining if t["type"] == "sell"]
    net_qty   = sum(t["quantity"] for t in buy_txns) - sum(t["quantity"] for t in sell_txns)

    holding_q = db.table("holdings").select("id") \
        .eq("user_id", user_id).eq("ticker", txn["ticker"])
    if broker_id:
        holding_q = holding_q.eq("broker_id", broker_id)
    holding_rows = holding_q.execute().data

    if holding_rows:
        hid = holding_rows[0]["id"]
        if net_qty <= 0:
            db.table("holdings").delete().eq("id", hid).eq("user_id", user_id).execute()
        else:
            total_buy_qty = sum(t["quantity"] for t in buy_txns)
            weighted_avg  = (
                sum(t["quantity"] * t["price"] for t in buy_txns) / total_buy_qty
                if total_buy_qty > 0 else 0
            )
            db.table("holdings").update({
                "quantity":      round(net_qty, 6),
                "avg_buy_price": round(weighted_avg, 4),
                "updated_at":    datetime.now(timezone.utc).isoformat(),
            }).eq("id", hid).eq("user_id", user_id).execute()

    return {"deleted": True}


@app.post("/transactions/migrate", status_code=201)
def migrate_holdings_to_transactions(
    migrate_date: Optional[str] = Query(default=None, description="ISO date e.g. 2023-01-01"),
    user_id:      str           = Depends(get_current_user),
):
    """Create synthetic BUY transactions from current holdings (skips tickers already migrated)."""
    from datetime import date as _date
    target_date = migrate_date or _date.today().isoformat()

    holdings = db.table("holdings").select("*").eq("user_id", user_id).execute().data
    if not holdings:
        return {"created": 0, "skipped": 0}

    existing = db.table("transactions").select("ticker").eq("user_id", user_id).eq("type", "buy").execute()
    already  = {r["ticker"] for r in existing.data}

    created, skipped = 0, 0
    for h in holdings:
        if h["ticker"] in already:
            skipped += 1
            continue
        db.table("transactions").insert({
            "user_id":    user_id,
            "ticker":     h["ticker"],
            "name":       h.get("name", h["ticker"]),
            "type":       "buy",
            "quantity":   h["quantity"],
            "price":      h["avg_buy_price"],
            "currency":   h["currency"],
            "broker_id":  h.get("broker_id"),
            "trade_date": target_date,
            "notes":      "Migrated from holdings",
        }).execute()
        created += 1

    return {"created": created, "skipped": skipped}


# ─────────────────────────────────────────────
#  ANALYTICS — REALIZED P&L
# ─────────────────────────────────────────────

@app.get("/analytics/realized")
def analytics_realized(user_id: str = Depends(get_current_user)):
    """
    Compute realized P&L from transaction history using average-cost method.
    Returns per-ticker breakdown + overall total in USD.
    """
    txns = (
        db.table("transactions")
        .select("*")
        .eq("user_id", user_id)
        .order("trade_date")
        .order("created_at")
        .execute()
        .data
    )

    if not txns:
        return {"realized": [], "total_realized_usd": 0.0, "total_dividends_usd": 0.0, "has_data": False}

    # Current FX rates for USD conversion
    fx: dict = {}
    for ccy, fx_ticker in FX_TICKERS.items():
        rate = _get_cached(fx_ticker)
        if rate:
            fx[ccy] = rate

    def to_usd(amount: float, ccy: str) -> float:
        if ccy == "USD":
            return amount
        rate = fx.get(ccy)
        return round(amount / rate, 4) if rate else amount

    # Per-ticker average cost tracker
    cost_book: dict = {}   # ticker → {qty, avg_price, currency}
    realized:  dict = {}   # ticker → aggregated P&L info

    for t in txns:
        ticker = t["ticker"]
        ccy    = t["currency"]
        qty    = float(t["quantity"])
        price  = float(t["price"])
        ttype  = t["type"]

        if ttype == "buy":
            if ticker not in cost_book:
                cost_book[ticker] = {"qty": 0.0, "avg_price": 0.0, "currency": ccy}
            cb = cost_book[ticker]
            new_cost = cb["qty"] * cb["avg_price"] + qty * price
            cb["qty"]       += qty
            cb["avg_price"]  = new_cost / cb["qty"] if cb["qty"] > 0 else price

        elif ttype == "sell":
            cb        = cost_book.get(ticker, {"qty": 0.0, "avg_price": price, "currency": ccy})
            avg_cost  = cb.get("avg_price", price)
            pl_native = (price - avg_cost) * qty
            pl_usd    = to_usd(pl_native, ccy)
            cb["qty"]  = max(0.0, cb["qty"] - qty)

            if ticker not in realized:
                realized[ticker] = {
                    "ticker": ticker, "name": t.get("name", ticker),
                    "currency": ccy, "type": "sell",
                    "realized_usd": 0.0, "realized_native": 0.0,
                    "dividends_usd": 0.0,
                    "sell_count": 0,
                }
            realized[ticker]["realized_usd"]    += pl_usd
            realized[ticker]["realized_native"]  += pl_native
            realized[ticker]["sell_count"]       += 1

        elif ttype == "dividend":
            div_native = qty * price
            div_usd    = to_usd(div_native, ccy)
            if ticker not in realized:
                realized[ticker] = {
                    "ticker": ticker, "name": t.get("name", ticker),
                    "currency": ccy, "type": "dividend",
                    "realized_usd": 0.0, "realized_native": 0.0,
                    "dividends_usd": 0.0,
                    "sell_count": 0,
                }
            realized[ticker]["dividends_usd"]   += div_usd

    rows = sorted(realized.values(), key=lambda x: abs(x["realized_usd"] + x["dividends_usd"]), reverse=True)
    # Round for display
    for r in rows:
        r["realized_usd"]   = round(r["realized_usd"],   2)
        r["realized_native"] = round(r["realized_native"], 2)
        r["dividends_usd"]  = round(r["dividends_usd"],  2)

    total_realized_usd  = round(sum(r["realized_usd"]  for r in rows), 2)
    total_dividends_usd = round(sum(r["dividends_usd"] for r in rows), 2)

    return {
        "realized":            rows,
        "total_realized_usd":  total_realized_usd,
        "total_dividends_usd": total_dividends_usd,
        "has_data":            True,
    }


# ─────────────────────────────────────────────
#  ANALYTICS — TAX P&L (STCG / LTCG)
# ─────────────────────────────────────────────

@app.get("/analytics/tax")
def analytics_tax(user_id: str = Depends(get_current_user)):
    """
    Compute STCG/LTCG from transaction history using FIFO lot matching.
    Indian equity tax rules:
      - STCG (held < 365 days): 20%
      - LTCG (held >= 365 days): 12.5% above ₹1,25,000 exemption
    Returns per-sell lot breakdown + aggregate totals.
    """
    from datetime import date as _date, timedelta as _td

    txns = (
        db.table("transactions")
        .select("*")
        .eq("user_id", user_id)
        .order("trade_date")
        .order("created_at")
        .execute()
        .data
    )

    if not txns:
        return {"lots": [], "summary": {}, "has_data": False}

    # Current FX rates
    fx: dict = {}
    for ccy, fx_ticker in FX_TICKERS.items():
        rate = _get_cached(fx_ticker)
        if rate:
            fx[ccy] = rate

    def to_inr(amount: float, ccy: str) -> float:
        if ccy == "INR":
            return amount
        usd_amt = amount if ccy == "USD" else amount / fx.get(ccy, 1)
        return usd_amt * fx.get("INR", 83)

    # FIFO buy queue per ticker: list of {qty, price, date, currency}
    buy_queues: dict = {}
    sell_lots:  list = []

    for t in txns:
        ticker = t["ticker"]
        ccy    = t["currency"]
        qty    = float(t["quantity"])
        price  = float(t["price"])
        tdate  = _date.fromisoformat(t["trade_date"])

        if t["type"] == "buy":
            if ticker not in buy_queues:
                buy_queues[ticker] = []
            buy_queues[ticker].append({"qty": qty, "price": price, "date": tdate, "currency": ccy})

        elif t["type"] == "sell":
            queue    = buy_queues.get(ticker, [])
            sell_qty = qty
            idx      = 0
            while sell_qty > 0 and idx < len(queue):
                lot = queue[idx]
                matched = min(lot["qty"], sell_qty)
                lot["qty"]  -= matched
                sell_qty    -= matched

                buy_inr  = to_inr(lot["price"]  * matched, lot["currency"])
                sell_inr = to_inr(price          * matched, ccy)
                pl_inr   = sell_inr - buy_inr
                days     = (tdate - lot["date"]).days
                term     = "LTCG" if days >= 365 else "STCG"

                sell_lots.append({
                    "ticker":      ticker,
                    "sell_date":   tdate.isoformat(),
                    "buy_date":    lot["date"].isoformat(),
                    "days_held":   days,
                    "qty":         matched,
                    "buy_price":   round(lot["price"],  2),
                    "sell_price":  round(price,          2),
                    "currency":    ccy,
                    "pl_inr":      round(pl_inr,         2),
                    "term":        term,
                })
                if lot["qty"] == 0:
                    idx += 1
            # Remove exhausted lots
            buy_queues[ticker] = [l for l in queue if l["qty"] > 0]

    # Aggregate
    stcg_total = sum(l["pl_inr"] for l in sell_lots if l["term"] == "STCG")
    ltcg_total = sum(l["pl_inr"] for l in sell_lots if l["term"] == "LTCG")
    ltcg_exemption = 125000.0
    ltcg_taxable   = max(0.0, ltcg_total - ltcg_exemption)
    stcg_tax  = max(0.0, stcg_total) * 0.20
    ltcg_tax  = ltcg_taxable          * 0.125

    return {
        "lots": sell_lots,
        "summary": {
            "stcg_total":     round(stcg_total,     2),
            "ltcg_total":     round(ltcg_total,     2),
            "ltcg_exemption": ltcg_exemption,
            "ltcg_taxable":   round(ltcg_taxable,   2),
            "stcg_tax_inr":   round(stcg_tax,       2),
            "ltcg_tax_inr":   round(ltcg_tax,       2),
            "total_tax_inr":  round(stcg_tax + ltcg_tax, 2),
        },
        "has_data": len(sell_lots) > 0,
    }
    return payload
