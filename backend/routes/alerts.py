"""
routes/alerts.py — Price alert endpoints.

A price alert watches a single ticker and fires when the current price
crosses a user-defined threshold in a given direction ("above" / "below").

Alerts are stored in Supabase (price_alerts table). Current prices are
fetched live from the shared prices module so the triggered status is
always fresh — no separate background job needed.

  Run once in Supabase SQL editor to create the table:

  CREATE TABLE IF NOT EXISTS price_alerts (
      id           BIGSERIAL PRIMARY KEY,
      user_id      TEXT         NOT NULL,
      ticker       TEXT         NOT NULL,
      name         TEXT         DEFAULT '',
      target_price FLOAT        NOT NULL,
      condition    TEXT         NOT NULL CHECK (condition IN ('above','below')),
      currency     TEXT         DEFAULT 'INR',
      created_at   TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS price_alerts_user_idx ON price_alerts(user_id);

Endpoints:
  GET    /alerts        → list all alerts, enriched with current price + triggered flag
  POST   /alerts        → create a new alert
  DELETE /alerts/{id}   → delete an alert
"""

from fastapi import APIRouter, HTTPException, Depends

from auth import get_current_user
from supabase_client import supabase as db
from prices import get_prices_batch
from models import AlertIn

router = APIRouter(prefix="/alerts", tags=["Alerts"])


@router.get("")
def list_alerts(user_id: str = Depends(get_current_user)):
    """
    Return all price alerts for the user, newest first.

    Each alert is enriched with:
      current_price  — live price in the alert's currency (None if unavailable)
      is_triggered   — True if the price condition is currently met

    Prices are batch-fetched in one yfinance call to minimise latency.
    The triggered status is computed here rather than stored in the DB so it
    always reflects the current market price without requiring a background job.
    """
    result = (
        db.table("price_alerts")
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    alerts = result.data

    if alerts:
        # De-duplicate tickers, then batch-fetch prices once
        tickers  = list({a["ticker"] for a in alerts})
        ccy_map  = {a["ticker"]: a["currency"] for a in alerts}
        pairs    = [(t, ccy_map[t]) for t in tickers]
        prices   = get_prices_batch(pairs)

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


@router.post("", status_code=201)
def create_alert(alert: AlertIn, user_id: str = Depends(get_current_user)):
    """
    Create a new price alert.

    ticker       — Yahoo Finance symbol (e.g. "TCS.NS", "AAPL")
    name         — optional display label; defaults to ticker if omitted
    target_price — price level that triggers the alert
    condition    — "above" (alert when price >= target) or "below" (price <= target)
    currency     — display currency for the alert card (INR / USD / AED)
    """
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


@router.delete("/{alert_id}")
def delete_alert(alert_id: int, user_id: str = Depends(get_current_user)):
    """
    Delete a price alert by ID.

    The user_id guard prevents one user from deleting another user's alert.
    Returns 404 if the alert doesn't exist or belongs to a different user.
    """
    result = (
        db.table("price_alerts")
        .delete()
        .eq("id", alert_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"deleted": True}
