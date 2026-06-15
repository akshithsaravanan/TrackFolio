"""
routes/transactions.py — Trade and dividend transaction history.

Transactions are the source of truth for realized P&L, tax calculations,
and portfolio history. Every time a holding is created via POST /holdings,
a matching BUY transaction is also written automatically.

Transaction types:
  buy      — purchase of shares (increases holding quantity)
  sell     — sale of shares (decreases holding; triggers P&L calc in /analytics/realized)
  dividend — cash dividend received (does not affect holding quantity)

Key behaviour on DELETE:
  Deleting a transaction recalculates the affected holding's quantity and
  weighted-average price from the remaining transactions for that ticker+broker.
  If net quantity drops to 0 or below, the holding row is deleted entirely.

Endpoints:
  GET    /transactions           → list all transactions, newest first
  POST   /transactions           → record a new trade or dividend
  PUT    /transactions/{id}      → correct a transaction's details
  DELETE /transactions/{id}      → remove a transaction + recalculate holding
  POST   /transactions/migrate   → create synthetic BUY transactions from current holdings
"""

from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional
from datetime import datetime, timezone

from auth import get_current_user
from supabase_client import supabase as db
from models import TransactionIn

router = APIRouter(prefix="/transactions", tags=["Transactions"])


@router.get("")
def list_transactions(user_id: str = Depends(get_current_user)):
    """
    Return all transactions for the user, ordered by trade_date desc then created_at desc.

    Each row includes broker_name (joined from the brokers table) for display.
    """
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


@router.post("", status_code=201)
def create_transaction(txn: TransactionIn, user_id: str = Depends(get_current_user)):
    """
    Record a new trade (buy/sell) or dividend.

    broker_id is optional — transactions can be broker-agnostic if needed.
    trade_date must be "YYYY-MM-DD".

    Note: this endpoint does NOT automatically update the related holding.
    Use POST /holdings to add a position (which auto-creates a BUY transaction).
    Use this endpoint to log sells, dividends, or manual trade corrections.
    """
    if txn.broker_id:
        b = (
            db.table("brokers")
            .select("id")
            .eq("id", txn.broker_id)
            .eq("user_id", user_id)
            .execute()
        )
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


@router.put("/{txn_id}")
def update_transaction(
    txn_id: int,
    txn: TransactionIn,
    user_id: str = Depends(get_current_user),
):
    """
    Correct a transaction's details (e.g. fix a wrong price or date).

    Returns 404 if the transaction doesn't exist or belongs to a different user.
    Does not recalculate the holding — run /holdings CRUD if the position needs adjustment.
    """
    result = (
        db.table("transactions")
        .update({
            "ticker":     txn.ticker,
            "name":       txn.name.strip() or txn.ticker,
            "type":       txn.type,
            "quantity":   txn.quantity,
            "price":      txn.price,
            "currency":   txn.currency,
            "broker_id":  txn.broker_id,
            "trade_date": txn.trade_date,
            "notes":      txn.notes.strip(),
        })
        .eq("id", txn_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return result.data[0]


@router.delete("/{txn_id}")
def delete_transaction(txn_id: int, user_id: str = Depends(get_current_user)):
    """
    Delete a transaction and recalculate the affected holding from remaining transactions.

    Algorithm:
      1. Fetch the transaction to identify ticker + broker.
      2. Delete the transaction.
      3. Re-query all remaining BUY and SELL transactions for that ticker+broker.
      4. net_qty = total_buy_qty - total_sell_qty
         - If net_qty <= 0: delete the holding entirely.
         - Otherwise: update holding with new net_qty and weighted-average buy price.

    This keeps holdings and transactions always in sync.
    """
    txn_res = (
        db.table("transactions")
        .select("*")
        .eq("id", txn_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not txn_res.data:
        raise HTTPException(status_code=404, detail="Transaction not found")
    txn = txn_res.data[0]

    db.table("transactions").delete().eq("id", txn_id).eq("user_id", user_id).execute()

    # Recalculate the holding from remaining transactions for this ticker + broker
    broker_id   = txn.get("broker_id")
    remaining_q = (
        db.table("transactions")
        .select("*")
        .eq("user_id", user_id)
        .eq("ticker", txn["ticker"])
    )
    if broker_id:
        remaining_q = remaining_q.eq("broker_id", broker_id)
    remaining = remaining_q.execute().data

    buy_txns  = [t for t in remaining if t["type"] == "buy"]
    sell_txns = [t for t in remaining if t["type"] == "sell"]
    net_qty   = sum(t["quantity"] for t in buy_txns) - sum(t["quantity"] for t in sell_txns)

    holding_q = (
        db.table("holdings")
        .select("id")
        .eq("user_id", user_id)
        .eq("ticker", txn["ticker"])
    )
    if broker_id:
        holding_q = holding_q.eq("broker_id", broker_id)
    holding_rows = holding_q.execute().data

    if holding_rows:
        hid = holding_rows[0]["id"]
        if net_qty <= 0:
            # No remaining position — delete the holding
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


@router.post("/migrate", status_code=201)
def migrate_holdings_to_transactions(
    migrate_date: Optional[str] = Query(
        default=None,
        description="ISO date e.g. 2023-01-01 — defaults to today",
    ),
    user_id: str = Depends(get_current_user),
):
    """
    Create synthetic BUY transactions from current holdings for users who
    added holdings before the transactions feature existed.

    Only creates transactions for tickers that have NO existing BUY transaction,
    so it is safe to run multiple times (idempotent).

    migrate_date sets the trade_date on all created transactions.
    Use the actual purchase date if known, otherwise defaults to today.
    """
    from datetime import date as _date
    target_date = migrate_date or _date.today().isoformat()

    holdings = db.table("holdings").select("*").eq("user_id", user_id).execute().data
    if not holdings:
        return {"created": 0, "skipped": 0}

    existing = (
        db.table("transactions")
        .select("ticker")
        .eq("user_id", user_id)
        .eq("type", "buy")
        .execute()
    )
    already = {r["ticker"] for r in existing.data}

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
