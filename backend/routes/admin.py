"""
routes/admin.py — Admin utilities, CSV import, and ticker search.

Groups three endpoint families that don't belong to a specific domain:

  Admin:
    POST /admin/clear-cache    → force-clear all SQLite caches (prices, 52w, sectors, indices)

  CSV Import:
    POST /import/csv           → bulk-import holdings from a broker-specific CSV export
                                 (ICICI Direct, SBI Securities, CBQ, HSBC)

  Ticker Search:
    GET  /search/ticker?q=...  → fuzzy-search Yahoo Finance for tickers by name or symbol

All endpoints require a valid JWT (enforced by get_current_user).
"""

import os
import sqlite3
from datetime import datetime, timezone

import requests
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile

from auth import get_current_user
from csv_import import parse_csv
from database import get_connection
from supabase_client import supabase as db

router = APIRouter(tags=["Admin"])

# Shared SQLite cache path (same DB used by analytics + markets modules)
_CACHE_DB = os.path.join(os.path.dirname(__file__), "..", "price_cache.db")


# ─────────────────────────────────────────────
#  ADMIN — CLEAR ALL CACHES
# ─────────────────────────────────────────────

@router.post("/admin/clear-cache")
def admin_clear_cache(user_id: str = Depends(get_current_user)):
    """
    Force-clear all cached data so fresh values are fetched on the next request.

    Clears:
      price_cache        — 15-min price cache (SQLite via database.py)
      week52_cache       — 24h 52-week high/low cache
      sector_cache       — 24h sector/industry cache
      index_cache        — 15-min market indices cache
      fiidii_cache       — 4h FII/DII flow cache
      _prev_close_cache  — in-memory previous-close cache (prices.py)

    Useful after backend upgrades, IP blocks by Yahoo Finance, or when
    prices appear stale on the frontend.
    """
    # price_cache table (used by holdings page)
    try:
        conn = get_connection()
        conn.execute("DELETE FROM price_cache")
        conn.commit()
        conn.close()
    except Exception:
        pass

    # All other caches in price_cache.db
    try:
        conn2 = sqlite3.connect(_CACHE_DB)
        for tbl in ["week52_cache", "sector_cache", "index_cache", "fiidii_cache"]:
            try:
                conn2.execute(f"DELETE FROM {tbl}")
            except Exception:
                pass
        conn2.commit()
        conn2.close()
    except Exception:
        pass

    # In-memory previous-close dict in prices module
    try:
        from prices import _prev_close_cache
        _prev_close_cache.clear()
    except Exception:
        pass

    return {"ok": True, "message": "All caches cleared. Prices will be refreshed on next load."}


# ─────────────────────────────────────────────
#  CSV IMPORT
# ─────────────────────────────────────────────

@router.post("/import/csv", status_code=201)
async def import_csv(
    broker_id: int        = Form(...),
    file:      UploadFile = File(...),
    replace:   str        = Form("false"),   # "true" = wipe existing holdings for this broker first
    user_id:   str        = Depends(get_current_user),
):
    """
    Bulk-import holdings from a broker CSV export.

    Supported broker formats (auto-detected by broker name):
      ICICI Direct, SBI Securities, CBQ, HSBC

    replace="true" — delete ALL existing holdings for this broker before inserting.
    replace="false" — upsert: update quantity+price for existing tickers, insert new ones.

    The CSV is decoded as UTF-8, falling back to Latin-1 for older broker exports.
    After parsing, holdings are inserted/updated row by row; any failures are
    counted as "skipped" and returned in the response for debugging.

    Returns:
      imported — count of successfully processed holdings
      skipped  — count of rows that failed (see "error" field in holdings list)
      deleted  — count of rows deleted (only when replace=true)
      holdings — full list of processed rows with action ("inserted"/"updated"/"error")
    """
    # Verify broker belongs to this user
    broker_result = (
        db.table("brokers")
        .select("id, name, currency")
        .eq("id", broker_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not broker_result.data:
        raise HTTPException(status_code=404, detail=f"Broker id {broker_id} not found")

    broker     = broker_result.data[0]
    raw_bytes  = await file.read()

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

    # Optionally wipe all existing holdings for this broker before inserting
    deleted = 0
    if replace.lower() == "true":
        del_result = (
            db.table("holdings")
            .delete()
            .eq("broker_id", broker_id)
            .eq("user_id", user_id)
            .execute()
        )
        deleted = len(del_result.data) if del_result.data else 0

    imported = 0
    skipped  = 0
    results  = []

    for h in parsed_holdings:
        try:
            existing = (
                db.table("holdings")
                .select("id")
                .eq("broker_id", broker_id)
                .eq("ticker", h["ticker"])
                .eq("user_id", user_id)
                .execute()
            )

            if existing.data:
                # Update quantity + price; only backfill purchase_date if not already set
                update_row = {
                    "quantity":      h["quantity"],
                    "avg_buy_price": h["avg_buy_price"],
                    "updated_at":    datetime.now(timezone.utc).isoformat(),
                }
                existing_full = (
                    db.table("holdings")
                    .select("purchase_date")
                    .eq("id", existing.data[0]["id"])
                    .execute()
                )
                if h.get("purchase_date") and not (
                    existing_full.data and existing_full.data[0].get("purchase_date")
                ):
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

    return {
        "imported": imported,
        "skipped":  skipped,
        "deleted":  deleted,
        "holdings": results,
    }


# ─────────────────────────────────────────────
#  TICKER SEARCH
# ─────────────────────────────────────────────

@router.get("/search/ticker")
def search_ticker(
    q:       str = Query(..., min_length=1, description="Company name or symbol fragment"),
    user_id: str = Depends(get_current_user),
):
    """
    Search Yahoo Finance for tickers matching a company name or symbol.

    Filters to EQUITY, ETF, and MUTUALFUND quote types only — excludes
    currencies, indices, and other instrument types that cannot be held.

    Returns up to 10 results:
      [{ticker, name, exchange, currency, type}]

    Used by the Add/Edit Holding modal to validate and auto-complete tickers.
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
        quotes  = resp.json().get("quotes", [])
        results = []
        for item in quotes:
            qtype = item.get("quoteType", "")
            if qtype not in ("EQUITY", "ETF", "MUTUALFUND"):
                continue
            results.append({
                "ticker":   item.get("symbol", ""),
                "name":     (
                    item.get("longname")
                    or item.get("shortname")
                    or item.get("symbol")
                ),
                "exchange": item.get("exchDisp", item.get("exchange", "")),
                "currency": item.get("currency", ""),
                "type":     qtype,
            })
        return results
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Search failed: {e}")
