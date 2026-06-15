"""
routes/analytics.py — Portfolio analytics, AI copilot, and technical scoring.

This is the largest module — it owns all the insight-generation logic:

  Technical Scoring Engine (get_technical_scores)
    Standalone helper used by both /analytics/ai and /analytics/ask.
    Computes a 0-100 score per ticker using 5 signals:
      30d momentum (30%), 90d momentum (20%), MA cross (20%), RSI-14 (15%), volatility (15%)
    Results cached 6 hours in SQLite to avoid redundant yfinance downloads.

  AI Endpoints
    /analytics/ai   — Full portfolio health report (Groq LLaMA 3.3 70B)
    /analytics/ask  — Single natural-language Q&A (Groq LLaMA 3.1 8B, faster)

  Market Structure
    /analytics/benchmark  — 1-year return for Nifty 50 and S&P 500
    /analytics/sectors    — Sector/industry classification (cached 24h)
    /analytics/52week     — 52-week high/low + DMA50/DMA200/RSI (cached 24h)
    /analytics/models     — Lists available Gemini API models (debug utility)

  Fundamentals
    /analytics/fundamentals  — P/E, P/B, dividend yield, market cap (cached 7 days)

  FX Impact
    /analytics/fx-history    — Quarterly USDINR FX drag on INR holdings (cached 24h)

  P&L / Tax
    /analytics/realized  — Realized P&L using average-cost method
    /analytics/tax       — STCG/LTCG using FIFO lot matching (Indian tax rules)
"""

import os
import json
import time
import sqlite3
import math
from datetime import datetime, timezone
from statistics import mean, stdev as _stdev
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import requests
from fastapi import APIRouter, HTTPException, Depends

from auth import get_current_user
from supabase_client import supabase as db
from yf_lock import YF_LOCK as _YF_LOCK
from prices import (
    get_prices_batch, convert_to_usd, FX_TICKERS, _get_cached,
    _fetch_fx_rate_av, _fetch_fx_history_av,
)
from llm import llm_call
from models import AskIn

router = APIRouter(prefix="/analytics", tags=["Analytics"])

# Path to the shared SQLite cache database
_CACHE_DB = os.path.join(os.path.dirname(__file__), "..", "price_cache.db")


# ─────────────────────────────────────────────
#  TECHNICAL SCORING ENGINE
# ─────────────────────────────────────────────

def get_technical_scores(tickers: list) -> dict:
    """
    Compute a 0-100 technical opportunity score for each ticker.

    Signals and weights:
      30d return      30% — short-term momentum
      90d return      20% — medium-term momentum
      MA cross        20% — price vs MA20 and MA50
      RSI-14          15% — relative strength (45-65 = ideal; >75 = overbought)
      20d volatility  15% — lower volatility scores higher (stability premium)

    Results are cached in the tech_scores SQLite table for 6 hours.
    A cache hit returns immediately without touching yfinance.

    Returns:
      {ticker: {"score": float, "ret_30d": float, "ret_90d": float,
                "rsi": float, "vol": float, "ma_signal": str}}
    """
    try:
        import yfinance as yf
    except ImportError:
        return {t: {"score": 50.0} for t in tickers}

    conn = sqlite3.connect(_CACHE_DB)
    conn.execute("""CREATE TABLE IF NOT EXISTS tech_scores
                    (ticker TEXT PRIMARY KEY, score REAL, detail TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 6 * 3600
    now       = time.time()
    results   = {}
    to_fetch  = []

    for t in tickers:
        row = conn.execute(
            "SELECT score, detail, ts FROM tech_scores WHERE ticker=?", (t,)
        ).fetchone()
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
                    period="90d", auto_adjust=True, progress=False, threads=False,
                )
            close = raw["Close"]
            # Flatten MultiIndex columns (newer yfinance returns (Price, Ticker) MultiIndex)
            if hasattr(close, "columns") and isinstance(close.columns, pd.MultiIndex):
                close.columns = close.columns.get_level_values(-1)

            price_series: dict = {}
            if len(to_fetch) == 1:
                price_series[to_fetch[0]] = (
                    close.iloc[:, 0].dropna().tolist()
                    if isinstance(close, pd.DataFrame)
                    else close.dropna().tolist()
                )
            else:
                for t in to_fetch:
                    try:
                        price_series[t] = close[t].dropna().tolist()
                    except Exception:
                        price_series[t] = []
        except Exception:
            price_series = {t: [] for t in to_fetch}

        def _norm_ret(r, lo=-20, hi=60):
            """Map a return% to 0-100, clamped to [lo, hi]."""
            return max(0.0, min(100.0, (max(lo, min(hi, r)) - lo) / (hi - lo) * 100))

        for ticker in to_fetch:
            prices = price_series.get(ticker, [])
            if len(prices) < 20:
                results[ticker] = {"score": 50.0}
                conn.execute(
                    "INSERT OR REPLACE INTO tech_scores VALUES (?,?,?,?)",
                    (ticker, 50.0, "{}", now),
                )
                continue

            try:
                # ── 1. Momentum: 30d and 90d returns ──────────────────────
                idx30  = max(0, len(prices) - 31)
                ret30  = (prices[-1] - prices[idx30]) / prices[idx30] * 100
                ret90  = (prices[-1] - prices[0])     / prices[0]     * 100

                # ── 2. Moving-average cross (price vs MA20 & MA50) ────────
                ma20 = mean(prices[-20:])
                ma50 = mean(prices[-min(50, len(prices)):])
                cur  = prices[-1]
                if   cur > ma50 and cur > ma20:
                    ma_score, ma_signal = 100, "above MA20 & MA50"
                elif cur > ma20:
                    ma_score, ma_signal =  65, "above MA20 only"
                elif cur > ma50:
                    ma_score, ma_signal =  50, "above MA50 only"
                else:
                    ma_score, ma_signal =  15, "below MA20 & MA50"

                # ── 3. RSI-14 ──────────────────────────────────────────────
                changes  = [prices[i] - prices[i - 1] for i in range(1, len(prices))]
                recent14 = changes[-14:]
                avg_gain = mean([c for c in recent14 if c > 0] or [0])
                avg_loss = mean([-c for c in recent14 if c < 0] or [0.0001])
                rsi      = 100 - 100 / (1 + avg_gain / avg_loss)
                if   45 <= rsi <= 65: rsi_score = 100   # ideal range
                elif 35 <= rsi <  45: rsi_score =  70   # slightly oversold
                elif 65 <  rsi <= 75: rsi_score =  55   # approaching overbought
                elif 25 <= rsi <  35: rsi_score =  35   # oversold
                elif rsi > 75:        rsi_score =  20   # overbought
                else:                 rsi_score =  15   # very oversold

                # ── 4. 20-day volatility (daily std dev %) ────────────────
                daily_rets = [
                    (prices[i] - prices[i - 1]) / prices[i - 1]
                    for i in range(1, len(prices))
                ]
                vol20 = _stdev(daily_rets[-20:]) * 100 if len(daily_rets) >= 2 else 3.0
                if   vol20 < 1.0: vol_score = 95
                elif vol20 < 1.5: vol_score = 85
                elif vol20 < 2.0: vol_score = 72
                elif vol20 < 3.0: vol_score = 55
                elif vol20 < 5.0: vol_score = 30
                else:             vol_score = 12

                # ── Composite score ────────────────────────────────────────
                score = (
                    _norm_ret(ret30) * 0.30 +
                    _norm_ret(ret90) * 0.20 +
                    ma_score         * 0.20 +
                    rsi_score        * 0.15 +
                    vol_score        * 0.15
                )
                detail = {
                    "ret_30d":   round(ret30, 1),
                    "ret_90d":   round(ret90, 1),
                    "rsi":       round(rsi,   1),
                    "vol":       round(vol20, 2),
                    "ma_signal": ma_signal,
                }
                results[ticker] = {"score": round(score, 1), **detail}
                conn.execute(
                    "INSERT OR REPLACE INTO tech_scores VALUES (?,?,?,?)",
                    (ticker, round(score, 1), json.dumps(detail), now),
                )
            except Exception:
                results[ticker] = {"score": 50.0}
                conn.execute(
                    "INSERT OR REPLACE INTO tech_scores VALUES (?,?,?,?)",
                    (ticker, 50.0, "{}", now),
                )

        conn.commit()

    conn.close()
    return results


# ─────────────────────────────────────────────
#  AI — FULL PORTFOLIO ANALYSIS
# ─────────────────────────────────────────────

@router.get("/ai")
def ai_analytics(user_id: str = Depends(get_current_user)):
    """
    Generate a full AI portfolio health report using Groq LLaMA 3.3 70B.

    Steps:
      1. Fetch all holdings + live prices (batch).
      2. Compute technical scores for every holding (cached 6h).
      3. Build a compact prompt: top 35 holdings by value; rest summarised.
      4. Call the LLM and parse the JSON response.
      5. Override star_pick deterministically (60% tech score + 40% return)
         so it always matches the actual best-composite holding — not the LLM's guess.

    Returns a structured JSON object with:
      health_score, health_label, verdict, plain_summary, scores,
      score_reasons, actions (one per ticker), top_risk, star_pick,
      star_pick_reason, star_pick_tech, portfolio_dna
    """
    result = db.table("holdings").select("*, brokers(name)").eq("user_id", user_id).execute()
    holdings = []
    for h in result.data:
        broker_info  = h.pop("brokers", {}) or {}
        h["broker_name"] = broker_info.get("name", "Unknown")
        holdings.append(h)

    if not holdings:
        return {"insights": "No holdings found. Add some holdings first."}

    ticker_currency_pairs = [(h["ticker"], h["currency"]) for h in holdings]
    prices = get_prices_batch(ticker_currency_pairs)

    enriched    = []
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

    # Attach technical scores to each holding
    all_tickers  = [e["ticker"] for e in enriched]
    tech_results = get_technical_scores(all_tickers)
    for e in enriched:
        td = tech_results.get(e["ticker"], {})
        e["tech_score"]  = td.get("score", 50.0)
        e["tech_detail"] = td

    # Sort by market value; send top 35 to the LLM, summarise the rest
    enriched.sort(key=lambda x: x["mv"], reverse=True)
    TOP_N = 35
    top   = enriched[:TOP_N]
    rest  = enriched[TOP_N:]

    top_rows = [
        f"{e['ticker']} ({e['currency']}): current=${e['price_usd']:.2f}, "
        f"avg_buy=${e['cost_usd']:.2f}, mkt_val=${e['mv']:,.0f}, "
        f"return={e['pct']:+.1f}%, tech_score={e['tech_score']:.0f}/100"
        for e in top
    ]

    rest_block = ""
    if rest:
        rest_val     = sum(e["mv"]  for e in rest)
        rest_avg_pct = sum(e["pct"] for e in rest) / len(rest)
        rest_block   = (
            f"\n+ {len(rest)} smaller holdings not listed: "
            f"combined ${rest_val:,.0f} ({rest_val / total_value * 100:.0f}% of portfolio), "
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
        import re as _re
        text  = llm_call(prompt, max_tokens=3500, temperature=0.1, tier="analysis")
        clean = _re.sub(r"```(?:json)?|```", "", text).strip()
        try:
            data = json.loads(clean)

            # ── Deterministic star_pick override ──────────────────────────
            # 60% technical momentum score + 40% normalised overall return
            def _composite(e):
                t_score = e.get("tech_score", 50.0)
                r_norm  = max(0.0, min(100.0, (max(-20, min(200, e["pct"])) + 20) / 220 * 100))
                return t_score * 0.60 + r_norm * 0.40

            risk_ticker = (data.get("top_risk") or {}).get("ticker", "")
            candidates  = [e for e in enriched if e["ticker"] != risk_ticker] or enriched
            best        = max(candidates, key=_composite)

            data["star_pick"] = best["ticker"]

            # Auto-generate a fact-based reason so it always matches the pick
            td           = best.get("tech_detail", {})
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
            # Attach tech breakdown so frontend can display the signal bar
            data["star_pick_tech"] = {
                "score":          best["tech_score"],
                "ret_30d":        td.get("ret_30d"),
                "ret_90d":        td.get("ret_90d"),
                "rsi":            td.get("rsi"),
                "vol":            td.get("vol"),
                "ma_signal":      td.get("ma_signal"),
                "overall_return": best["pct"],
            }
            return {"insights": data}
        except Exception:
            return {"insights": text}
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=502, detail=f"AI analysis failed: {e}")


# ─────────────────────────────────────────────
#  AI — FOLLOW-UP Q&A
# ─────────────────────────────────────────────

@router.post("/ask")
def ask_portfolio_ai(body: AskIn, user_id: str = Depends(get_current_user)):
    """
    Answer a specific natural-language question about the portfolio.

    Uses Groq LLaMA 3.1 8B (faster, lower cost than the analysis model).
    Sends top 20 holdings by value as context so the LLM can reference
    actual tickers and numbers rather than giving generic advice.

    Returns: {answer: str} — 2-4 sentence factual response.
    """
    if not body.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    result = db.table("holdings").select("*, brokers(name)").eq("user_id", user_id).execute()
    holdings = []
    for h in result.data:
        broker_info      = h.pop("brokers", {}) or {}
        h["broker_name"] = broker_info.get("name", "Unknown")
        holdings.append(h)

    if not holdings:
        return {"answer": "No holdings found in your portfolio."}

    ticker_currency_pairs = [(h["ticker"], h["currency"]) for h in holdings]
    prices    = get_prices_batch(ticker_currency_pairs)
    tech_data = get_technical_scores([h["ticker"] for h in holdings])

    rows, total_value, total_cost = [], 0, 0
    for h in holdings:
        price = prices.get(h["ticker"])
        cost  = convert_to_usd(h["avg_buy_price"], h["currency"])
        if price and cost:
            mv           = h["quantity"] * price
            cb           = h["quantity"] * cost
            pct          = (mv - cb) / cb * 100 if cb > 0 else 0
            total_value += mv
            total_cost  += cb
            td = tech_data.get(h["ticker"], {})
            rows.append({
                "ticker":     h["ticker"],
                "mv":         mv,
                "pct":        pct,
                "currency":   h["currency"],
                "tech_score": td.get("score", 50),
                "ret_30d":    td.get("ret_30d"),
            })

    rows.sort(key=lambda x: x["mv"], reverse=True)
    context_parts = []
    for r in rows[:20]:
        line = (
            f"{r['ticker']} ({r['currency']}): ${r['mv']:,.0f} "
            f"({r['pct']:+.1f}% overall), tech={r['tech_score']:.0f}/100"
        )
        if r["ret_30d"] is not None:
            line += f", 30d={r['ret_30d']:+.1f}%"
        context_parts.append(line)

    context        = "\n".join(context_parts)
    total_gain_pct = (total_value - total_cost) / total_cost * 100 if total_cost else 0
    today          = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    prompt = (
        f"You are a helpful portfolio analyst. Today is {today}. "
        "Answer the following question about this portfolio concisely and specifically "
        "(2-4 sentences). Reference actual tickers and numbers from the portfolio. "
        "Do not give generic financial advice. Start with a direct answer.\n\n"
        f"Portfolio: ${total_value:,.0f} total | ${total_cost:,.0f} invested | "
        f"{total_gain_pct:+.1f}% overall return\n"
        f"Holdings (top 20 by value):\n{context}\n\n"
        f"Question: {body.question}"
    )

    try:
        return {"answer": llm_call(prompt, max_tokens=400, temperature=0.65, tier="ask")}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ask AI failed: {e}")


# ─────────────────────────────────────────────
#  BENCHMARK COMPARISON
# ─────────────────────────────────────────────

@router.get("/benchmark")
def analytics_benchmark(user_id: str = Depends(get_current_user)):
    """
    Return 1-year percentage return for Nifty 50 and S&P 500.

    Used by the Analytics page to compare the user's portfolio return
    against market benchmarks. Fetched fresh on each call (no cache)
    because index data is light and fast.
    """
    try:
        import yfinance as yf
        with _YF_LOCK:
            data = yf.download(
                ["^NSEI", "^GSPC"], period="1y", interval="1d",
                auto_adjust=True, progress=False, threads=False,
            )
        close = data["Close"] if "Close" in data.columns else data
        if hasattr(close, "columns") and isinstance(close.columns, pd.MultiIndex):
            close.columns = close.columns.get_level_values(0)

        result = {}
        for ticker, label in [("^NSEI", "Nifty 50"), ("^GSPC", "S&P 500")]:
            if ticker in close.columns:
                prices = close[ticker].squeeze().dropna()
                if len(prices) >= 2:
                    result[label] = round(
                        (float(prices.iloc[-1]) - float(prices.iloc[0]))
                        / float(prices.iloc[0]) * 100, 2
                    )
        return result
    except Exception:
        return {}


# ─────────────────────────────────────────────
#  SECTOR / INDUSTRY CLASSIFICATION
# ─────────────────────────────────────────────

@router.get("/sectors")
def analytics_sectors(user_id: str = Depends(get_current_user)):
    """
    Return sector and industry classification for all user holdings.

    Data source: yfinance Ticker.info (calls are parallelised 8-at-a-time).
    Cached 24 hours in SQLite because sector data rarely changes.

    Returns: {"sectors": {ticker: {"sector": str, "industry": str}}}
    """
    result  = db.table("holdings").select("ticker").eq("user_id", user_id).execute()
    tickers = list({h["ticker"] for h in result.data})
    if not tickers:
        return {"sectors": {}}

    conn = sqlite3.connect(_CACHE_DB)
    conn.execute("""CREATE TABLE IF NOT EXISTS sector_cache
                    (ticker TEXT PRIMARY KEY, sector TEXT, industry TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 24 * 3600
    now       = time.time()
    results: dict = {}
    to_fetch: list = []

    for t in tickers:
        row = conn.execute(
            "SELECT sector, industry, ts FROM sector_cache WHERE ticker=?", (t,)
        ).fetchone()
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
                    conn.execute(
                        "INSERT OR REPLACE INTO sector_cache VALUES (?,?,?,?)",
                        (ticker, data["sector"], data["industry"], now),
                    )
        except Exception:
            for t in to_fetch:
                results[t] = {"sector": "Unknown", "industry": "Unknown"}
                conn.execute(
                    "INSERT OR REPLACE INTO sector_cache VALUES (?,?,?,?)",
                    (t, "Unknown", "Unknown", now),
                )
        conn.commit()

    conn.close()
    return {"sectors": results}


# ─────────────────────────────────────────────
#  52-WEEK HIGH / LOW + TECHNICALS
# ─────────────────────────────────────────────

@router.get("/52week")
def analytics_52week(user_id: str = Depends(get_current_user)):
    """
    Return 52-week high/low, DMA50, DMA200, RSI-14, and position_pct for all holdings.

    position_pct: where current price sits within the 52-week range (0=at 52w low, 100=at 52w high).

    Download strategy: tickers are fetched in chunks of 10 so _YF_LOCK is held
    for only ~2-3 seconds per chunk instead of 30-60s for one giant batch —
    this allows sparklines and FX-history endpoints to interleave.

    Cached 24 hours; startup event clears stale entries on server restart.
    """
    import yfinance as yf

    result  = db.table("holdings").select("ticker").eq("user_id", user_id).execute()
    tickers = list({h["ticker"] for h in result.data})
    if not tickers:
        return {}

    conn = sqlite3.connect(_CACHE_DB)
    conn.execute("""CREATE TABLE IF NOT EXISTS week52_cache
                    (ticker TEXT PRIMARY KEY, data TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 24 * 3600
    now       = time.time()
    results: dict = {}
    to_fetch: list = []

    for t in tickers:
        row = conn.execute(
            "SELECT data, ts FROM week52_cache WHERE ticker=?", (t,)
        ).fetchone()
        if row and (now - row[1]) < cache_ttl:
            try:
                cached = json.loads(row[0])
                if cached:
                    results[t] = cached
                else:
                    to_fetch.append(t)   # previous fetch failed — retry
            except Exception:
                to_fetch.append(t)
        else:
            to_fetch.append(t)

    def _compute_stats(prices: list) -> dict:
        """Compute 52-week stats + technicals from a list of daily closing prices."""
        if len(prices) < 10:
            return {}
        high52  = max(prices)
        low52   = min(prices)
        curr    = prices[-1]
        rng     = high52 - low52
        pos_pct = round((curr - low52) / rng * 100, 1) if rng > 0 else 50.0

        n50    = min(50, len(prices))
        n200   = min(200, len(prices))
        dma50  = round(sum(prices[-n50:])  / n50,  2) if len(prices) >= 10  else None
        dma200 = round(sum(prices[-n200:]) / n200, 2) if len(prices) >= 50  else None

        rsi = None
        if len(prices) >= 15:
            deltas   = [prices[i] - prices[i - 1] for i in range(1, len(prices))]
            last14   = deltas[-14:]
            avg_gain = sum(d for d in last14 if d > 0) / 14
            avg_loss = sum(-d for d in last14 if d < 0) / 14
            rsi = 100.0 if avg_loss == 0 else round(100 - 100 / (1 + avg_gain / avg_loss), 1)

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

    def _safe_download(tickers_arg, period):
        """Thread-safe yfinance download returning a normalised close DataFrame."""
        with _YF_LOCK:
            raw = yf.download(
                tickers_arg, period=period,
                auto_adjust=False, progress=False, threads=False,
            )
        if raw.empty:
            return pd.DataFrame()
        close = raw["Close"]
        if isinstance(close, pd.DataFrame) and isinstance(close.columns, pd.MultiIndex):
            close.columns = close.columns.get_level_values(-1)
        if isinstance(close, pd.DataFrame):
            return close
        name = tickers_arg if isinstance(tickers_arg, str) else tickers_arg[0]
        return close.to_frame(name=name)

    if to_fetch:
        CHUNK    = 10
        close_df = pd.DataFrame()

        for i in range(0, len(to_fetch), CHUNK):
            chunk     = to_fetch[i:i + CHUNK]
            chunk_arg = chunk if len(chunk) > 1 else chunk[0]
            try:
                chunk_df = _safe_download(chunk_arg, "1y")
                if not chunk_df.empty:
                    close_df = chunk_df if close_df.empty else close_df.join(chunk_df, how="outer")
            except Exception:
                pass

        for ticker in to_fetch:
            try:
                if ticker not in close_df.columns:
                    results[ticker] = {}
                    continue
                prices     = [float(p) for p in close_df[ticker].dropna().tolist()]
                data_block = _compute_stats(prices)
                results[ticker] = data_block
            except Exception:
                results[ticker] = {}
            conn.execute(
                "INSERT OR REPLACE INTO week52_cache VALUES (?,?,?)",
                (ticker, json.dumps(results[ticker]), now),
            )
        conn.commit()

    conn.close()
    return results


# ─────────────────────────────────────────────
#  GEMINI MODELS LIST (debug utility)
# ─────────────────────────────────────────────

@router.get("/models")
def list_gemini_models(user_id: str = Depends(get_current_user)):
    """
    Debug endpoint: list available Gemini API models.
    Not used in production UI — kept for development tooling.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    r = requests.get(
        f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}",
        timeout=10,
    )
    models = r.json().get("models", [])
    return [
        {"name": m["name"], "methods": m.get("supportedGenerationMethods", [])}
        for m in models
    ]


# ─────────────────────────────────────────────
#  FX HISTORY (quarterly USDINR drag)
# ─────────────────────────────────────────────

@router.get("/fx-history")
def analytics_fx_history(user_id: str = Depends(get_current_user)):
    """
    Compute the USD impact of USDINR depreciation on the user's INR holdings.

    Method:
      - Fix current stock prices (eliminates stock price noise).
      - Vary ONLY the USDINR rate at each of the last 4 quarter-ends.
      - "Total 1Y FX Loss" = USD value at oldest quarter rate − USD value at current rate.
        A positive number means INR depreciated (holdings worth less in USD today).

    Only the top 5 INR holdings by current INR value are shown to keep the
    chart readable.

    Data source: Alpha Vantage daily FX history (cached 24 hours).
    """
    from datetime import date

    conn = sqlite3.connect(_CACHE_DB)
    conn.execute("""CREATE TABLE IF NOT EXISTS fxhist_cache
                    (key TEXT PRIMARY KEY, data TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 24 * 3600
    now       = time.time()
    cache_key = f"fxhist_{user_id}"

    row = conn.execute(
        "SELECT data, ts FROM fxhist_cache WHERE key=?", (cache_key,)
    ).fetchone()
    if row and (now - row[1]) < cache_ttl:
        conn.close()
        return json.loads(row[0])

    result_data = (
        db.table("holdings")
        .select("ticker,quantity,avg_buy_price,currency")
        .eq("user_id", user_id)
        .execute()
    )
    inr_holdings = [h for h in result_data.data if h.get("currency") == "INR"]

    empty = {
        "holdings": [], "quarters": [], "fx_rates": [],
        "portfolio_by_quarter": [], "total_fx_loss_1y": 0,
    }

    if not inr_holdings:
        conn.execute(
            "INSERT OR REPLACE INTO fxhist_cache VALUES (?,?,?)",
            (cache_key, json.dumps(empty), now),
        )
        conn.commit()
        conn.close()
        return empty

    # Get current prices in USD and derive INR values
    ticker_ccy     = [(h["ticker"], "INR") for h in inr_holdings]
    prices_usd     = get_prices_batch(ticker_ccy)
    current_usdinr = _get_cached("USDINR=X") or _fetch_fx_rate_av("INR") or 84.0
    if math.isnan(current_usdinr):
        current_usdinr = _fetch_fx_rate_av("INR") or 84.0

    for h in inr_holdings:
        p_usd = prices_usd.get(h["ticker"])
        h["inr_value"] = (
            round(h["quantity"] * p_usd * current_usdinr, 0)
            if (p_usd and current_usdinr) else None
        )

    top5 = sorted(
        [h for h in inr_holdings if h.get("inr_value")],
        key=lambda x: x["inr_value"], reverse=True,
    )[:5]

    if not top5:
        conn.execute(
            "INSERT OR REPLACE INTO fxhist_cache VALUES (?,?,?)",
            (cache_key, json.dumps(empty), now),
        )
        conn.commit()
        conn.close()
        return empty

    # Fetch 13+ months of USDINR daily history to cover 4 quarter-ends
    av_history = _fetch_fx_history_av("INR", days=400)
    if not av_history:
        conn.execute(
            "INSERT OR REPLACE INTO fxhist_cache VALUES (?,?,?)",
            (cache_key, json.dumps(empty), now),
        )
        conn.commit()
        conn.close()
        return empty

    fx_lookup = {item["date"]: item["rate"] for item in av_history}

    # Find the last 4 quarter-end dates that have already passed
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
        month_entries = [
            (ds, r) for ds, r in fx_lookup.items()
            if ds[:7] == target_date.strftime("%Y-%m")
        ]
        if month_entries:
            return round(sorted(month_entries)[-1][1], 2)
        target_str = target_date.strftime("%Y-%m-%d")
        before = [(ds, r) for ds, r in fx_lookup.items() if ds <= target_str]
        return round(sorted(before)[-1][1], 2) if before else None

    quarters = [quarter_label(d) for d in past_qe] + ["Now"]
    fx_rates = [find_fx_rate(d) for d in past_qe] + [round(current_usdinr, 2)]

    portfolio_by_quarter = [
        round(sum(
            round(h["inr_value"] / rate, 0) if (rate and h["inr_value"]) else 0
            for h in top5
        ), 0)
        for rate in fx_rates
    ]

    holdings_out = []
    for h in top5:
        inr_val    = h["inr_value"]
        usd_by_qtr = [
            round(inr_val / r, 0) if (r and inr_val) else None
            for r in fx_rates
        ]
        fx_loss_1y = (
            round(usd_by_qtr[0] - usd_by_qtr[-1], 0)
            if (usd_by_qtr[0] is not None and usd_by_qtr[-1] is not None) else None
        )
        ticker_clean = h["ticker"].replace(".NS", "").replace(".BO", "").replace(".AE", "")
        holdings_out.append({
            "ticker":         ticker_clean,
            "inr_value":      inr_val,
            "usd_by_quarter": usd_by_qtr,
            "fx_loss_1y":     fx_loss_1y,
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

    valid_rates = [r for r in fx_rates if r is not None]
    if len(valid_rates) >= 2:
        conn.execute(
            "INSERT OR REPLACE INTO fxhist_cache VALUES (?,?,?)",
            (cache_key, json.dumps(result), now),
        )
        conn.commit()
    conn.close()
    return result


# ─────────────────────────────────────────────
#  FUNDAMENTALS (PE, PB, Dividend Yield)
# ─────────────────────────────────────────────

@router.get("/fundamentals")
def analytics_fundamentals(user_id: str = Depends(get_current_user)):
    """
    Return per-holding fundamental data: P/E, P/B, dividend yield, market cap, sector.

    Data source: yfinance Ticker.info (parallelised 5-at-a-time).
    Cached 7 days — fundamentals change slowly and the info API is slow.

    Returns: {ticker: {"pe", "pb", "div_yield", "market_cap", "sector", "industry"}}
    """
    import yfinance as yf

    result_data = db.table("holdings").select("ticker").eq("user_id", user_id).execute()
    tickers     = list({h["ticker"] for h in result_data.data})
    if not tickers:
        return {}

    conn = sqlite3.connect(_CACHE_DB)
    conn.execute("""CREATE TABLE IF NOT EXISTS fundamentals_cache
                    (ticker TEXT PRIMARY KEY, data TEXT, ts REAL)""")
    conn.commit()

    cache_ttl = 7 * 24 * 3600
    now       = time.time()
    results: dict = {}
    to_fetch: list = []

    for t in tickers:
        row = conn.execute(
            "SELECT data, ts FROM fundamentals_cache WHERE ticker=?", (t,)
        ).fetchone()
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

    def _fetch_fundamentals(ticker: str):
        try:
            info = yf.Ticker(ticker).info
            pe   = info.get("trailingPE")
            pb   = info.get("priceToBook")
            dy   = info.get("dividendYield")
            mc   = info.get("marketCap")
            return ticker, {
                "pe":         round(pe, 1) if pe else None,
                "pb":         round(pb, 2) if pb else None,
                "div_yield":  round(dy if dy > 1 else dy * 100, 2) if dy else None,
                "market_cap": mc,
                "sector":     info.get("sector")   or info.get("quoteType", ""),
                "industry":   info.get("industry") or "",
            }
        except Exception:
            return ticker, {}

    if to_fetch:
        with ThreadPoolExecutor(max_workers=5) as pool:
            futures = {pool.submit(_fetch_fundamentals, t): t for t in to_fetch}
            for fut in as_completed(futures):
                ticker, data = fut.result()
                results[ticker] = data
                conn.execute(
                    "INSERT OR REPLACE INTO fundamentals_cache VALUES (?,?,?)",
                    (ticker, json.dumps(data), now),
                )
        conn.commit()

    conn.close()
    return results


# ─────────────────────────────────────────────
#  REALIZED P&L (average-cost method)
# ─────────────────────────────────────────────

@router.get("/realized")
def analytics_realized(user_id: str = Depends(get_current_user)):
    """
    Compute realized P&L from transaction history using the average-cost method.

    Algorithm:
      - Walk transactions chronologically.
      - BUY: update the running average cost book for that ticker.
      - SELL: P&L = (sell_price - avg_cost) × qty, converted to USD via current FX.
      - DIVIDEND: added separately as income (does not affect cost book).

    Returns:
      realized           — per-ticker breakdown sorted by |realized + dividends| desc
      total_realized_usd — sum of all sell P&L in USD
      total_dividends_usd — sum of all dividend income in USD
      has_data           — False if no transactions exist
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
        return {
            "realized": [], "total_realized_usd": 0.0,
            "total_dividends_usd": 0.0, "has_data": False,
        }

    # Snapshot of current FX rates for USD conversion
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

    cost_book: dict = {}   # ticker → {qty, avg_price, currency}
    realized:  dict = {}   # ticker → aggregated P&L

    for t in txns:
        ticker = t["ticker"]
        ccy    = t["currency"]
        qty    = float(t["quantity"])
        price  = float(t["price"])
        ttype  = t["type"]

        if ttype == "buy":
            if ticker not in cost_book:
                cost_book[ticker] = {"qty": 0.0, "avg_price": 0.0, "currency": ccy}
            cb       = cost_book[ticker]
            new_cost = cb["qty"] * cb["avg_price"] + qty * price
            cb["qty"]      += qty
            cb["avg_price"] = new_cost / cb["qty"] if cb["qty"] > 0 else price

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
                    "dividends_usd": 0.0, "sell_count": 0,
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
                    "dividends_usd": 0.0, "sell_count": 0,
                }
            realized[ticker]["dividends_usd"] += div_usd

    rows = sorted(
        realized.values(),
        key=lambda x: abs(x["realized_usd"] + x["dividends_usd"]),
        reverse=True,
    )
    for r in rows:
        r["realized_usd"]    = round(r["realized_usd"],    2)
        r["realized_native"]  = round(r["realized_native"],  2)
        r["dividends_usd"]   = round(r["dividends_usd"],   2)

    return {
        "realized":            rows,
        "total_realized_usd":  round(sum(r["realized_usd"]  for r in rows), 2),
        "total_dividends_usd": round(sum(r["dividends_usd"] for r in rows), 2),
        "has_data":            True,
    }


# ─────────────────────────────────────────────
#  TAX P&L — STCG / LTCG (Indian rules)
# ─────────────────────────────────────────────

@router.get("/tax")
def analytics_tax(user_id: str = Depends(get_current_user)):
    """
    Compute STCG/LTCG from transaction history using FIFO lot matching.

    Indian equity tax rules applied:
      STCG (held < 365 days) — taxed at 20%
      LTCG (held >= 365 days) — taxed at 12.5% above ₹1,25,000 exemption

    All amounts are converted to INR for the tax computation.

    Returns:
      lots    — per-sell-lot breakdown [{ticker, sell_date, buy_date, days_held, pl_inr, term}, ...]
      summary — {stcg_total, ltcg_total, ltcg_exemption, ltcg_taxable, stcg_tax_inr, ltcg_tax_inr, total_tax_inr}
      has_data — False if no transactions with sells exist
    """
    from datetime import date as _date

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

    buy_queues: dict = {}   # ticker → list of {qty, price, date, currency}
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
                lot     = queue[idx]
                matched = min(lot["qty"], sell_qty)
                lot["qty"]  -= matched
                sell_qty    -= matched

                buy_inr  = to_inr(lot["price"] * matched, lot["currency"])
                sell_inr = to_inr(price         * matched, ccy)
                pl_inr   = sell_inr - buy_inr
                days     = (tdate - lot["date"]).days
                term     = "LTCG" if days >= 365 else "STCG"

                sell_lots.append({
                    "ticker":     ticker,
                    "sell_date":  tdate.isoformat(),
                    "buy_date":   lot["date"].isoformat(),
                    "days_held":  days,
                    "qty":        matched,
                    "buy_price":  round(lot["price"], 2),
                    "sell_price": round(price,         2),
                    "currency":   ccy,
                    "pl_inr":     round(pl_inr,        2),
                    "term":       term,
                })
                if lot["qty"] == 0:
                    idx += 1
            buy_queues[ticker] = [lot for lot in queue if lot["qty"] > 0]

    stcg_total     = sum(l["pl_inr"] for l in sell_lots if l["term"] == "STCG")
    ltcg_total     = sum(l["pl_inr"] for l in sell_lots if l["term"] == "LTCG")
    ltcg_exemption = 125000.0
    ltcg_taxable   = max(0.0, ltcg_total - ltcg_exemption)

    return {
        "lots": sell_lots,
        "summary": {
            "stcg_total":     round(stcg_total,             2),
            "ltcg_total":     round(ltcg_total,             2),
            "ltcg_exemption": ltcg_exemption,
            "ltcg_taxable":   round(ltcg_taxable,           2),
            "stcg_tax_inr":   round(max(0.0, stcg_total) * 0.20,  2),
            "ltcg_tax_inr":   round(ltcg_taxable           * 0.125, 2),
            "total_tax_inr":  round(
                max(0.0, stcg_total) * 0.20 + ltcg_taxable * 0.125, 2
            ),
        },
        "has_data": len(sell_lots) > 0,
    }
