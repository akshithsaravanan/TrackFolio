"""
routes/prices.py — Live price lookup, sparklines, and portfolio history.

These endpoints power the real-time price display across the frontend:
  - HoldingsPage: sparkline mini-charts in each row
  - DashboardPage: portfolio value-over-time chart
  - Add/edit holding modal: single ticker price validation

All heavy lifting (caching, batch download, FX conversion) is in prices.py.
These routes are thin wrappers that validate input and delegate to that module.

Endpoints:
  GET /prices/{ticker}          → single ticker price + cache status
  GET /sparklines?tickers=...   → 7-day closing prices for a comma-separated list
  GET /portfolio/history        → portfolio total value over a time period
"""

import pandas as pd
from fastapi import APIRouter, HTTPException, Depends, Query

from auth import get_current_user
from supabase_client import supabase as db
from prices import (
    get_price_usd, get_portfolio_history, _get_cached,
)
from yf_lock import YF_LOCK as _YF_LOCK
from models import VALID_CURRENCIES, VALID_PERIODS

router = APIRouter(tags=["Prices"])


@router.get("/prices/{ticker}")
def get_ticker_price(
    ticker:   str,
    currency: str = "USD",
    user_id:  str = Depends(get_current_user),
):
    """
    Fetch the current price for a single ticker.

    currency — the currency to interpret the ticker in (INR / USD / AED).
               Controls which FX rate is used for cost-basis comparisons.

    Returns:
      ticker        — uppercased symbol
      price_usd     — price in USD (None if unavailable)
      currency      — requested currency
      from_cache    — True if the price was served from the 15-minute SQLite cache
    """
    ticker   = ticker.strip().upper()
    currency = currency.strip().upper()

    if currency not in VALID_CURRENCIES:
        raise HTTPException(status_code=400, detail=f"currency must be one of {VALID_CURRENCIES}")

    was_cached = _get_cached(ticker) is not None
    price      = get_price_usd(ticker, currency)

    if price is None:
        raise HTTPException(status_code=404, detail=f"Could not fetch price for '{ticker}'.")

    return {
        "ticker":     ticker,
        "price_usd":  price,
        "currency":   currency,
        "from_cache": was_cached,
    }


@router.get("/sparklines")
def get_sparklines(
    tickers: str = Query(..., description="Comma-separated Yahoo Finance symbols"),
    user_id: str = Depends(get_current_user),
):
    """
    Return the last 7 daily closing prices for each ticker in the list.

    Used to render the mini sparkline charts in the Holdings table rows.
    Fetches 10 days of data and returns the last 7 to account for weekends
    and market holidays leaving gaps in the series.

    Downloads all tickers in ONE batch call under _YF_LOCK to avoid
    concurrent yfinance requests from other endpoints.

    Returns: {ticker: [price, price, ...]} — up to 7 values per ticker.
    """
    ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    if not ticker_list:
        return {}

    try:
        import yfinance as yf
        with _YF_LOCK:
            data = yf.download(
                ticker_list, period="10d", interval="1d",
                auto_adjust=True, progress=False, threads=False,
            )

        result = {}
        close  = data["Close"]

        # Newer yfinance returns a (Price, Ticker) MultiIndex — flatten to Ticker level
        if hasattr(close, "columns") and isinstance(close.columns, pd.MultiIndex):
            close.columns = close.columns.get_level_values(-1)

        if len(ticker_list) == 1:
            # Single ticker: yfinance may return a Series instead of DataFrame
            series = close.iloc[:, 0].dropna() if hasattr(close, "columns") else close.dropna()
            result[ticker_list[0]] = [round(p, 2) for p in series.tolist()[-7:]]
        else:
            for t in ticker_list:
                if t in close.columns:
                    prices = close[t].dropna().tolist()[-7:]
                    result[t] = [round(p, 2) for p in prices]

        return result
    except Exception:
        return {}


@router.get("/portfolio/history")
def portfolio_history(
    period:   str = "30d",
    currency: str = "All",
    user_id:  str = Depends(get_current_user),
):
    """
    Return the portfolio's total market value at daily intervals over a time window.

    period   — one of 7d | 30d | 90d | ytd | 1y
    currency — "All" (USD) or a specific currency to filter by (INR / USD / AED)

    The history is reconstructed by replaying historical prices against the
    current holdings snapshot (see prices.get_portfolio_history for the algorithm).

    Returns:
      period   — echoed back
      currency — echoed back
      history  — [{date, value_usd}, ...]
    """
    if period not in VALID_PERIODS:
        raise HTTPException(
            status_code=400,
            detail=f"period must be one of {VALID_PERIODS}",
        )

    result  = (
        db.table("holdings")
        .select("ticker, quantity, avg_buy_price, currency")
        .eq("user_id", user_id)
        .execute()
    )
    history = get_portfolio_history(result.data, period, currency)
    return {"period": period, "currency": currency, "history": history}
