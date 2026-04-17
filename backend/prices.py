"""
prices.py — handles all live price fetching and currency conversion.

THE PROBLEM WE FIXED:
  Old approach: fetch one ticker at a time → 10 holdings = 10 API calls to Yahoo
  Yahoo Finance rate-limits after a few rapid calls → intermittent "Expecting value" errors

  New approach: batch all tickers into ONE yf.download() call → 1 API call total
  This is faster and never gets rate-limited.

Public functions:
  get_price_usd(ticker, currency)           → single ticker (used by /prices/{ticker})
  get_prices_batch(ticker_currency_pairs)   → all tickers at once (used by GET /holdings)
  convert_to_usd(amount, currency)          → convert an amount to USD
"""

import os
import yfinance as yf
import pandas as pd
import requests as _requests
import math
from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FuturesTimeout
from database import get_connection
from datetime import datetime, timedelta, timezone
from yf_lock import YF_LOCK as _YF_LOCK   # shared lock — all yf.download() calls use this

# Hard timeout for a single yfinance batch download.
# Yahoo Finance blocks Railway's IP intermittently; without this the request
# hangs for 30 s per failing ticker and /holdings never returns.
_YF_TIMEOUT = 12   # seconds — enough for a good connection, fast fail on block

CACHE_MINUTES = 15   # 15 min is fine for a portfolio tracker; reduces yfinance calls at scale

# "USDINR=X" = how many INR per 1 USD (e.g. 84.0)
# To convert INR price → USD: divide by this rate
FX_TICKERS = {
    "INR": "USDINR=X",
    "AED": "USDAED=X",
}

# Alpha Vantage currency codes
_AV_FX = {"INR": "INR", "AED": "AED"}

def _fetch_fx_rate_av(currency: str) -> float | None:
    """Fetch current USD→currency rate from Alpha Vantage (primary FX source).
    Uses CURRENCY_EXCHANGE_RATE endpoint — counts as 1 of 25 daily free calls.
    With 15-min SQLite cache, real calls = ~2-4/day total for both currencies."""
    key = os.environ.get("ALPHA_VANTAGE_KEY", "")
    if not key or currency not in _AV_FX:
        return None
    try:
        resp = _requests.get(
            "https://www.alphavantage.co/query",
            params={
                "function": "CURRENCY_EXCHANGE_RATE",
                "from_currency": "USD",
                "to_currency": currency,
                "apikey": key,
            },
            timeout=8,
        )
        data = resp.json()
        rate_str = data.get("Realtime Currency Exchange Rate", {}).get("5. Exchange Rate")
        if rate_str:
            return float(rate_str)
    except Exception:
        pass
    return None

def _fetch_fx_history_av(currency: str, days: int = 90) -> list[dict] | None:
    """Fetch daily USD→currency rates for the last `days` days from Alpha Vantage.
    Returns list of {date, rate} dicts sorted ascending, or None on failure."""
    key = os.environ.get("ALPHA_VANTAGE_KEY", "")
    if not key or currency not in _AV_FX:
        return None
    try:
        output_size = "full" if days > 120 else "compact"
        resp = _requests.get(
            "https://www.alphavantage.co/query",
            params={
                "function": "FX_DAILY",
                "from_symbol": "USD",
                "to_symbol": currency,
                "outputsize": output_size,
                "apikey": key,
            },
            timeout=10,
        )
        data = resp.json()
        series = data.get("Time Series FX (Daily)", {})
        if not series:
            return None
        cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        result = []
        for date_str, vals in sorted(series.items()):
            if date_str >= cutoff:
                result.append({"date": date_str, "rate": float(vals["4. close"])})
        return result or None
    except Exception:
        return None

def _fetch_fx_rate_http(currency: str) -> float | None:
    """Last-resort fallback using open.er-api.com (no key, current rates only)."""
    try:
        resp = _requests.get("https://open.er-api.com/v6/latest/USD", timeout=5)
        data = resp.json()
        if data.get("result") == "success":
            return data["rates"].get(currency)
    except Exception:
        pass
    return None


# ─── Cache helpers ────────────────────────────────────────────────────────────

def _get_cached(ticker: str) -> float | None:
    """Return a fresh cached price for a single ticker, or None if missing/stale."""
    conn = get_connection()
    row = conn.execute(
        "SELECT price_usd, fetched_at FROM price_cache WHERE ticker = ?",
        (ticker,)
    ).fetchone()
    conn.close()

    if not row:
        return None

    age = datetime.now(timezone.utc).replace(tzinfo=None) - datetime.fromisoformat(row["fetched_at"])
    if age < timedelta(minutes=CACHE_MINUTES):
        val = float(row["price_usd"])
        return None if math.isnan(val) else val

    return None


def _get_cached_batch(tickers: list[str]) -> dict[str, float]:
    """
    Return all fresh cached prices for a list of tickers in ONE DB query.
    Much faster than calling _get_cached() in a loop for 100 tickers.
    Returns only tickers that have a fresh (non-stale) cache entry.
    """
    if not tickers:
        return {}
    conn = get_connection()
    placeholders = ','.join('?' * len(tickers))
    rows = conn.execute(
        f"SELECT ticker, price_usd, fetched_at FROM price_cache WHERE ticker IN ({placeholders})",
        tickers
    ).fetchall()
    conn.close()

    result = {}
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=CACHE_MINUTES)
    for row in rows:
        if datetime.fromisoformat(row["fetched_at"]) >= cutoff:
            val = float(row["price_usd"])
            if not math.isnan(val):
                result[row["ticker"]] = val
    return result


def _save_cache(ticker: str, price: float):
    """Save or overwrite a single price in price_cache."""
    conn = get_connection()
    conn.execute(
        """INSERT INTO price_cache (ticker, price_usd, fetched_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(ticker) DO UPDATE
               SET price_usd  = excluded.price_usd,
                   fetched_at = excluded.fetched_at""",
        (ticker, price)
    )
    conn.commit()
    conn.close()


def _save_cache_batch(ticker_price_map: dict[str, float]):
    """
    Save multiple prices in a single DB transaction.
    Much faster than calling _save_cache() in a loop for 100 tickers.
    """
    if not ticker_price_map:
        return
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    conn = get_connection()
    conn.executemany(
        """INSERT INTO price_cache (ticker, price_usd, fetched_at)
           VALUES (?, ?, ?)
           ON CONFLICT(ticker) DO UPDATE
               SET price_usd  = excluded.price_usd,
                   fetched_at = excluded.fetched_at""",
        [(ticker, price, now) for ticker, price in ticker_price_map.items()]
    )
    conn.commit()
    conn.close()


# ─── Prev close side-cache (populated as a side effect of batch download) ──────
# Stores the PREVIOUS day's local price for each ticker.
# Used by get_prev_close_usd() to compute daily P&L without a second API call.
_prev_close_cache: dict[str, float] = {}


# ─── Batch fetch (main workhorse) ─────────────────────────────────────────────

def _batch_download(tickers: list[str]) -> dict[str, float]:
    """
    Fetch closing prices for a LIST of tickers in a single API call.

    yf.download(["TCS.NS", "AAPL", "USDINR=X"]) makes ONE request to Yahoo
    and returns a DataFrame with all prices.

    Returns a dict: { "TCS.NS": 2389.8, "AAPL": 245.9, "USDINR=X": 84.1, ... }
    Missing/failed tickers are simply not included in the dict.

    Side effect: populates _prev_close_cache with the second-to-last close
    so that get_prev_close_usd() can compute daily P&L without a second call.
    """
    if not tickers:
        return {}

    try:
        # progress=False suppresses the download bar in the terminal
        # auto_adjust=False → "Close" column = actual exchange closing price (not dividend-adjusted)
        # threads=False + _YF_LOCK → prevent concurrent yfinance calls from corrupting shared session
        # ThreadPoolExecutor + _YF_TIMEOUT → hard deadline so a blocked Railway IP
        # fails fast instead of hanging the entire /holdings request for 30 s per ticker.
        with _YF_LOCK:
            with ThreadPoolExecutor(max_workers=1) as _ex:
                _fut = _ex.submit(
                    yf.download, tickers,
                    period="5d", auto_adjust=False, progress=False, threads=False,
                )
                try:
                    data = _fut.result(timeout=_YF_TIMEOUT)
                except _FuturesTimeout:
                    print(f"[prices] yfinance timed out after {_YF_TIMEOUT}s for {len(tickers)} tickers — using cache")
                    return {}

        if data.empty:
            return {}

        result = {}

        # In modern yfinance, data["Close"] is ALWAYS a DataFrame with
        # ticker names as columns — even when only one ticker was requested.
        # e.g. data["Close"]["DPRO"] gives the price series for DPRO.
        close = data["Close"]

        # Newer yfinance (0.2.x+) can return a MultiIndex (Price, Ticker).
        # data["Close"] usually resolves this, but guard against residual MultiIndex.
        if hasattr(close, 'columns') and isinstance(close.columns, pd.MultiIndex):
            close.columns = close.columns.get_level_values(-1)  # last level = Ticker

        # If only one ticker was passed, yfinance may return a plain Series.
        # Wrap it back into a DataFrame so the column-lookup below works uniformly.
        if not hasattr(close, 'columns'):
            close = close.to_frame(name=tickers[0])

        for ticker in tickers:
            if ticker in close.columns:
                series = close[ticker].dropna()
                if not series.empty:
                    val = float(series.iloc[-1])
                    if not math.isnan(val):
                        result[ticker] = val
                # Capture previous close for daily P&L (second-to-last row)
                if len(series) >= 2:
                    prev_val = float(series.iloc[-2])
                    if not math.isnan(prev_val):
                        _prev_close_cache[ticker] = prev_val

        return result

    except Exception:
        return {}


# ─── Public functions ─────────────────────────────────────────────────────────

def get_prices_batch(ticker_currency_pairs: list[tuple[str, str]]) -> dict[str, float | None]:
    """
    Fetch prices for MANY tickers at once — used by GET /holdings.

    Input:  [("TCS.NS", "INR"), ("AAPL", "USD"), ("VOO", "USD")]
    Output: { "TCS.NS": 25.31, "AAPL": 245.9, "VOO": 578.7 }

    Steps:
      1. Check cache for each ticker
      2. Determine which FX rates we need
      3. One batch download for all uncached stocks + FX rates
      4. Convert local prices to USD
      5. Save everything to cache
      6. Return the complete dict
    """
    result    = {}           # final output
    to_fetch  = []           # tickers not in cache
    fx_needed = set()        # e.g. {"USDINR=X"} if any INR holdings exist

    # Step 1 — ONE batch cache read for all tickers (single DB query)
    all_tickers  = [t for t, _ in ticker_currency_pairs]
    cached_batch = _get_cached_batch(all_tickers)

    for ticker, currency in ticker_currency_pairs:
        cached     = cached_batch.get(ticker)
        needs_prev = ticker not in _prev_close_cache

        if cached is not None and not needs_prev:
            result[ticker] = cached        # fully satisfied — skip
        else:
            if cached is not None:
                result[ticker] = cached    # price OK, but still need prev_close
            to_fetch.append((ticker, currency))
            if currency != "USD":
                fx_ticker = FX_TICKERS.get(currency)
                if fx_ticker:
                    fx_needed.add(fx_ticker)

    if not to_fetch:
        return result   # everything was cached — no network call needed

    # Step 2 — check cache for FX rates (included in the same batch read above)
    fx_rates    = {}
    fx_to_fetch = []
    for fx_ticker in fx_needed:
        cached_rate = cached_batch.get(fx_ticker) or _get_cached(fx_ticker)
        if cached_rate is not None:
            fx_rates[fx_ticker] = cached_rate
        else:
            fx_to_fetch.append(fx_ticker)

    # Step 3 — ONE batch download for everything missing
    stock_tickers = [t for t, _ in to_fetch]
    all_to_fetch  = stock_tickers + fx_to_fetch
    fetched       = _batch_download(all_to_fetch)

    # Step 4 — convert each stock price to USD, collect into a dict
    to_cache = {}
    for fx_ticker in fx_to_fetch:
        rate = fetched.get(fx_ticker)
        if rate is None:
            ccy = next((c for c, t in FX_TICKERS.items() if t == fx_ticker), None)
            if ccy:
                rate = _fetch_fx_rate_av(ccy) or _fetch_fx_rate_http(ccy)
        if rate is not None:
            fx_rates[fx_ticker] = rate
            to_cache[fx_ticker] = rate

    for ticker, currency in to_fetch:
        if ticker in result:   # price already in result; only needed prev_close
            continue

        local_price = fetched.get(ticker)
        if local_price is None:
            result[ticker] = None
            continue

        if currency == "USD":
            price_usd = local_price
        else:
            fx_ticker = FX_TICKERS.get(currency)
            rate      = fx_rates.get(fx_ticker) if fx_ticker else None
            if rate is None:
                result[ticker] = None
                continue
            price_usd = local_price / rate

        price_usd      = round(price_usd, 4)
        result[ticker] = price_usd
        to_cache[ticker] = price_usd

    # Step 5 — ONE batch write for all new prices (single DB transaction)
    _save_cache_batch(to_cache)

    return result


def get_price_usd(ticker: str, currency: str) -> float | None:
    """
    Single-ticker lookup — used by GET /prices/{ticker}.
    Delegates to get_prices_batch so the logic is in one place.
    """
    prices = get_prices_batch([(ticker, currency)])
    return prices.get(ticker)


def convert_to_usd(amount: float, currency: str) -> float | None:
    """Convert an amount from local currency to USD using a cached FX rate."""
    if currency == "USD":
        return round(amount, 4)

    fx_ticker = FX_TICKERS.get(currency)
    if not fx_ticker:
        return None

    rate = _get_cached(fx_ticker)
    if rate is None:
        fetched = _batch_download([fx_ticker])
        rate    = fetched.get(fx_ticker)
    if rate is None:
        rate = _fetch_fx_rate_av(currency) or _fetch_fx_rate_http(currency)
    if rate is None:
        return None
    _save_cache(fx_ticker, rate)

    return round(amount / rate, 4)


HISTORY_CACHE_MINUTES = 20   # history data changes slowly — 20 min TTL

def _get_history_cache(key: str):
    """Return cached history list or None if missing/stale."""
    import json
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT data, fetched_at FROM history_cache WHERE cache_key = ?", (key,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    age = datetime.now(timezone.utc).replace(tzinfo=None) - datetime.fromisoformat(row["fetched_at"])
    if age < timedelta(minutes=HISTORY_CACHE_MINUTES):
        return json.loads(row["data"])
    return None


def _save_history_cache(key: str, data: list):
    """Save history list to cache."""
    import json
    conn = get_connection()
    try:
        conn.execute(
            """INSERT INTO history_cache (cache_key, data, fetched_at)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(cache_key) DO UPDATE
                   SET data = excluded.data, fetched_at = excluded.fetched_at""",
            (key, json.dumps(data))
        )
        conn.commit()
    finally:
        conn.close()


def get_portfolio_history(holdings: list[dict], period: str = "30d",
                          currency: str = "All") -> list[dict]:
    """
    Reconstruct portfolio value for every trading day in the period.

    currency="All"  → total portfolio in USD (all holdings combined)
    currency="INR"  → INR portfolio only, values in INR (₹)
    currency="AED"  → AED portfolio only, values in AED
    currency="USD"  → USD portfolio only, values in USD

    Returns: [{ date, market_value, cost_basis, gain_loss, gain_pct }, ...]
    """
    if not holdings:
        return []

    # Filter to the requested currency
    if currency != "All":
        holdings = [h for h in holdings if h["currency"] == currency]
    if not holdings:
        return []

    # ── Cache lookup ──────────────────────────────────────────
    import hashlib, json
    fingerprint = hashlib.md5(
        json.dumps(sorted([(h["ticker"], h["quantity"]) for h in holdings])).encode()
    ).hexdigest()[:8]
    cache_key = f"hist_{currency}_{period}_{fingerprint}"
    cached = _get_history_cache(cache_key)
    if cached is not None:
        return cached

    # native=True means we return values in local currency (INR/AED) instead of USD
    native = currency != "All" and currency != "USD"

    tickers = list({ h["ticker"] for h in holdings })
    if native:
        # No FX tickers needed — we keep values in local currency
        all_ticks = tickers
    else:
        fx_needed = list({ FX_TICKERS[h["currency"]] for h in holdings
                          if h["currency"] in FX_TICKERS })
        all_ticks = tickers + fx_needed

    try:
        with _YF_LOCK:
            data = yf.download(all_ticks, period=period,
                               auto_adjust=True, progress=False, threads=False)
        if data.empty:
            return []

        close = data["Close"]
        if hasattr(close, 'columns') and isinstance(close.columns, pd.MultiIndex):
            close.columns = close.columns.get_level_values(0)
        elif not hasattr(close, 'columns'):
            ticker_name = all_ticks[0] if len(all_ticks) == 1 else tickers[0]
            close = close.to_frame(name=ticker_name)
        close = close.ffill().bfill()

        # ── Cost basis ──────────────────────────────────────────
        if native:
            # Local currency cost basis (avg_buy_price is already in native currency)
            total_cost = sum(h["avg_buy_price"] * h["quantity"] for h in holdings)
        else:
            # USD cost basis — convert non-USD buy prices using current FX rate
            total_cost = 0.0
            for h in holdings:
                if h["currency"] == "USD":
                    total_cost += h["avg_buy_price"] * h["quantity"]
                else:
                    fx_ticker = FX_TICKERS.get(h["currency"])
                    rate      = _get_cached(fx_ticker) if fx_ticker else None
                    if rate:
                        total_cost += (h["avg_buy_price"] / rate) * h["quantity"]
        total_cost = round(total_cost, 2)

        # ── Build daily history ─────────────────────────────────
        history = []
        for i in range(len(close)):
            row        = close.iloc[i]
            date_label = close.index[i].strftime("%Y-%m-%d")
            mv         = 0.0

            for h in holdings:
                ticker = h["ticker"]
                if ticker not in close.columns:
                    continue
                try:
                    local_price = row[ticker] if ticker in row.index else None
                except Exception:
                    local_price = None
                if local_price is None or pd.isna(local_price):
                    continue

                if native:
                    # Keep in local currency — no FX conversion
                    mv += h["quantity"] * float(local_price)
                elif h["currency"] == "USD":
                    mv += h["quantity"] * float(local_price)
                else:
                    fx_ticker = FX_TICKERS.get(h["currency"])
                    if not fx_ticker or fx_ticker not in close.columns:
                        continue
                    try:
                        fx_rate = row[fx_ticker] if fx_ticker in row.index else None
                    except Exception:
                        fx_rate = None
                    if fx_rate is None or pd.isna(fx_rate):
                        continue
                    mv += h["quantity"] * float(local_price) / float(fx_rate)

            if mv > 0:
                gain     = round(mv - total_cost, 2)
                gain_pct = round(gain / total_cost * 100, 2) if total_cost else 0
                history.append({
                    "date":         date_label,
                    "market_value": round(mv, 2),
                    "cost_basis":   total_cost,
                    "gain_loss":    gain,
                    "gain_pct":     gain_pct,
                })

        _save_history_cache(cache_key, history)
        return history

    except Exception:
        return []


def get_prev_close_usd(ticker: str, currency: str) -> float | None:
    """
    Return the previous trading day's close price in USD.
    Reads from _prev_close_cache which is populated by _batch_download()
    as a side effect — no extra network call needed.

    Example: get_prev_close_usd("TCS.NS", "INR") → 14.55 (USD)
    """
    local_price = _prev_close_cache.get(ticker)
    if local_price is None:
        return None

    if currency == "USD":
        return round(local_price, 4)

    fx_ticker = FX_TICKERS.get(currency)
    if not fx_ticker:
        return None

    rate = _get_cached(fx_ticker)
    if rate is None:
        return None

    return round(local_price / rate, 4)


def usd_to_local(price_usd: float, currency: str) -> float | None:
    """
    Convert a USD price BACK to the local currency.
    Used to display Indian stock prices in ₹ instead of $.

    Example: usd_to_local(14.72, "INR") → ~1235 INR
    """
    if currency == "USD":
        return round(price_usd, 4)

    fx_ticker = FX_TICKERS.get(currency)
    if not fx_ticker:
        return None

    # FX rate should already be in cache from get_prices_batch()
    rate = _get_cached(fx_ticker)
    if rate is None:
        fetched = _batch_download([fx_ticker])
        rate    = fetched.get(fx_ticker)
        if rate is None:
            return None
        _save_cache(fx_ticker, rate)

    # rate = USDINR (e.g. 84.0), so USD × rate = INR
    return round(price_usd * rate, 2)
