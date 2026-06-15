"""
routes/holdings.py — Holdings CRUD and portfolio enrichment.

A "holding" represents a current stock/ETF/MF position in a specific broker account.
It stores cost basis (avg_buy_price) and quantity; live prices are fetched on demand.

Key design decisions:
  - All prices are fetched in ONE batch yfinance call per request (get_prices_batch)
    to avoid triggering Yahoo Finance rate limits.
  - All values are computed in USD as a common denominator, then converted to local
    currency for display (usd_to_local).
  - Duplicate ticker+broker combinations are automatically merged with a weighted
    average price rather than creating two rows.
  - Every CREATE also writes a matching BUY transaction so transaction history is
    always consistent with holdings.

Endpoints:
  GET    /holdings                    → list all holdings, enriched with live prices + P&L
  POST   /holdings                    → create a new holding (merges if duplicate)
  PUT    /holdings/{id}               → update a holding's details
  DELETE /holdings/{id}               → delete a holding
  POST   /holdings/merge-duplicates   → batch-merge all duplicate ticker+broker rows
"""

from fastapi import APIRouter, HTTPException, Depends
from typing import Optional
from datetime import datetime, timezone
from collections import defaultdict

from auth import get_current_user
from supabase_client import supabase as db
from database import get_connection
from prices import (
    get_prices_batch, convert_to_usd, usd_to_local,
    get_prev_close_usd, FX_TICKERS, _get_cached,
)
from models import HoldingIn

router = APIRouter(prefix="/holdings", tags=["Holdings"])


@router.get("")
def list_holdings(
    broker_id: Optional[int] = None,
    user_id:   str = Depends(get_current_user),
):
    """
    Return all holdings for the user, enriched with live market data.

    Optional query param:
      broker_id — filter to a single broker account

    Each holding row is augmented with:
      current_price_usd / current_price_local  — live price in USD and native currency
      market_value_usd / market_value_local     — qty × current price
      cost_basis_usd                            — qty × avg_buy_price (converted to USD)
      gain_loss_usd / gain_loss_pct             — unrealised P&L
      daily_change_usd / daily_change_pct       — today's move vs previous close
      effective_purchase_date                   — manual date or earliest BUY transaction

    Summary block includes portfolio totals and live FX rates.
    """
    # Fetch holdings with broker name via JOIN
    query = (
        db.table("holdings")
        .select("*, brokers(name)")
        .eq("user_id", user_id)
    )
    if broker_id:
        query = query.eq("broker_id", broker_id)
    result = query.order("broker_id").order("ticker").execute()

    # Flatten nested broker object → broker_name field
    holdings = []
    for h in result.data:
        broker_info      = h.pop("brokers", {}) or {}
        h["broker_name"] = broker_info.get("name", "Unknown")
        holdings.append(h)

    # Build ticker → earliest BUY transaction date map.
    # Used as fallback when purchase_date is not set manually on the holding.
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
            d  = t.get("trade_date")
            tk = t["ticker"]
            if d and (tk not in earliest_buy or d < earliest_buy[tk]):
                earliest_buy[tk] = d
    except Exception:
        earliest_buy = {}

    for h in holdings:
        h["effective_purchase_date"] = (
            h.get("purchase_date") or earliest_buy.get(h["ticker"])
        )

    # Batch-fetch live prices — ONE yfinance download for all tickers
    ticker_currency_pairs = [(h["ticker"], h["currency"]) for h in holdings]
    prices = get_prices_batch(ticker_currency_pairs)

    result_list = []
    for h in holdings:
        price_usd   = prices.get(h["ticker"])
        cost_usd    = convert_to_usd(h["avg_buy_price"], h["currency"])
        price_local = usd_to_local(price_usd, h["currency"]) if price_usd else None

        h["current_price_usd"]   = price_usd
        h["current_price_local"] = price_local

        if price_usd is not None and cost_usd is not None:
            market_value_usd   = round(h["quantity"] * price_usd, 2)
            cost_basis_usd     = round(h["quantity"] * cost_usd,  2)
            gain_loss_usd      = round(market_value_usd - cost_basis_usd, 2)
            gain_pct           = round(gain_loss_usd / cost_basis_usd * 100, 2) if cost_basis_usd > 0 else 0.0
            market_value_local = round(h["quantity"] * price_local, 2) if price_local else None
            gain_loss_local    = (
                round(market_value_local - h["quantity"] * h["avg_buy_price"], 2)
                if market_value_local else None
            )

            # Daily change vs previous close
            prev_usd = get_prev_close_usd(h["ticker"], h["currency"])
            if prev_usd is not None:
                daily_change_usd   = round((price_usd - prev_usd) * h["quantity"], 2)
                daily_change_pct   = round((price_usd - prev_usd) / prev_usd * 100, 2)
                prev_local         = usd_to_local(prev_usd, h["currency"])
                daily_change_local = (
                    round((price_local - prev_local) * h["quantity"], 2)
                    if (price_local and prev_local) else None
                )
            else:
                daily_change_usd   = None
                daily_change_pct   = None
                daily_change_local = None

            h.update({
                "market_value_usd":   market_value_usd,
                "cost_basis_usd":     cost_basis_usd,
                "gain_loss_usd":      gain_loss_usd,
                "gain_loss_pct":      gain_pct,
                "market_value_local": market_value_local,
                "gain_loss_local":    gain_loss_local,
                "daily_change_usd":   daily_change_usd,
                "daily_change_pct":   daily_change_pct,
                "daily_change_local": daily_change_local,
            })
        else:
            h.update({
                "market_value_usd":   None,
                "cost_basis_usd":     None,
                "gain_loss_usd":      None,
                "gain_loss_pct":      None,
                "market_value_local": None,
                "gain_loss_local":    None,
                "daily_change_usd":   None,
                "daily_change_pct":   None,
                "daily_change_local": None,
            })

        result_list.append(h)

    # ── Currency-level totals ──────────────────────────────────────────────
    by_currency: dict = {}
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

    # ── Portfolio-level totals ─────────────────────────────────────────────
    all_values  = [h["market_value_usd"] for h in result_list if h["market_value_usd"] is not None]
    all_costs   = [h["cost_basis_usd"]   for h in result_list if h["cost_basis_usd"]   is not None]
    total_value = round(sum(all_values), 2) if all_values else None
    total_cost  = round(sum(all_costs),  2) if all_costs  else None
    total_gain  = round(total_value - total_cost, 2) if (total_value and total_cost) else None
    total_pct   = round(total_gain / total_cost * 100, 2) if (total_gain and total_cost) else None

    # Live FX rates for display in the UI header
    fx_rates_display = {}
    for currency, fx_ticker in FX_TICKERS.items():
        rate = _get_cached(fx_ticker)
        if rate:
            fx_rates_display[currency] = round(rate, 2)

    # Timestamp of most recent cached price fetch
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
        },
    }


@router.post("", status_code=201)
def create_holding(holding: HoldingIn, user_id: str = Depends(get_current_user)):
    """
    Add a new holding.

    If a row already exists for the same (ticker, broker_id) combination,
    the positions are MERGED: quantity is summed and avg_buy_price is
    recalculated using a weighted average so the cost basis remains accurate.

    A BUY transaction is always written, whether the row is new or merged.
    This ensures the transaction log stays in sync with holdings.
    """
    # Verify the broker belongs to this user before touching holdings
    broker_check = (
        db.table("brokers")
        .select("id")
        .eq("id", holding.broker_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not broker_check.data:
        raise HTTPException(status_code=404, detail=f"Broker id {holding.broker_id} not found")

    try:
        trade_date = holding.purchase_date or datetime.now(timezone.utc).date().isoformat()

        # Check for existing row with same ticker + broker
        existing = (
            db.table("holdings")
            .select("*")
            .eq("user_id", user_id)
            .eq("ticker", holding.ticker)
            .eq("broker_id", holding.broker_id)
            .execute()
        )

        if existing.data:
            # Merge: weighted average cost basis
            ex      = existing.data[0]
            new_qty = round(ex["quantity"] + holding.quantity, 6)
            new_avg = round(
                (ex["quantity"] * ex["avg_buy_price"] + holding.quantity * holding.avg_buy_price)
                / new_qty, 4
            )
            result = (
                db.table("holdings")
                .update({
                    "quantity":      new_qty,
                    "avg_buy_price": new_avg,
                    "updated_at":    datetime.now(timezone.utc).isoformat(),
                })
                .eq("id", ex["id"])
                .eq("user_id", user_id)
                .execute()
            )
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
            saved  = result.data[0]

        # Always create a matching BUY transaction for audit trail
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


@router.put("/{holding_id}")
def update_holding(
    holding_id: int,
    holding: HoldingIn,
    user_id: str = Depends(get_current_user),
):
    """
    Update a holding's details (quantity, price, broker, notes, purchase_date).

    Does NOT auto-create a transaction — edits are manual corrections,
    not new trades. Use POST /transactions for recording new trades.
    """
    broker_check = (
        db.table("brokers")
        .select("id")
        .eq("id", holding.broker_id)
        .eq("user_id", user_id)
        .execute()
    )
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
    # Allow explicitly clearing purchase_date by sending null
    if holding.purchase_date is not None:
        update_data["purchase_date"] = holding.purchase_date or None

    result = (
        db.table("holdings")
        .update(update_data)
        .eq("id", holding_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Holding not found")
    return result.data[0]


@router.delete("/{holding_id}")
def delete_holding(holding_id: int, user_id: str = Depends(get_current_user)):
    """
    Delete a single holding by ID.

    Does not automatically delete related transactions — the trade history
    is preserved for the analytics/realized and analytics/tax endpoints.
    """
    result = (
        db.table("holdings")
        .delete()
        .eq("id", holding_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Holding not found")
    return {"deleted": True}


@router.post("/merge-duplicates")
def merge_duplicate_holdings(user_id: str = Depends(get_current_user)):
    """
    Find all (ticker, broker_id) groups with multiple rows and merge them.

    For each group:
      1. Compute total quantity and weighted-average price across all rows.
      2. Write a BUY transaction for every original row so purchase history
         is preserved in the transactions table.
      3. Update the oldest row (primary) with the merged totals.
      4. Delete all other rows in the group.

    This endpoint is idempotent — running it twice produces the same result.
    Returns: {merged_groups: int, transactions_created: int}
    """
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
        total_qty    = sum(r["quantity"] for r in rows)
        weighted_avg = sum(r["quantity"] * r["avg_buy_price"] for r in rows) / total_qty

        # Create a BUY transaction for every original row before merging
        for r in rows:
            trade_date = (
                r.get("purchase_date")
                or (r.get("created_at") or "")[:10]
                or datetime.now(timezone.utc).date().isoformat()
            )
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

        # Delete duplicate rows (all but primary)
        for r in rows[1:]:
            db.table("holdings").delete().eq("id", r["id"]).eq("user_id", user_id).execute()

        merged_count += 1

    return {"merged_groups": merged_count, "transactions_created": txn_count}
