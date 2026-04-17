"""
csv_import.py — parses broker CSV exports into a standard format.

Each broker has a different column layout, date format, and terminology.
Every parser function returns a list of dicts in this standard shape:

    {
        "ticker":        str,   e.g. "RELIANCE.NS" or "AAPL"
        "name":          str,   e.g. "Reliance Industries"
        "quantity":      float, total shares (buys minus sells)
        "avg_buy_price": float, weighted average buy price
        "currency":      str,   "INR" or "USD"
        "purchase_date": str|None,  "YYYY-MM-DD" — date of FIRST buy trade
    }

If the same stock appears multiple times (multiple buy trades), we MERGE
them into one row using a weighted average price.  The purchase_date will
always be the EARLIEST buy date found for that ticker.

Weighted average example:
  Buy 10 shares @ ₹2400  →  cost = ₹24,000
  Buy  5 shares @ ₹2500  →  cost = ₹12,500
  Total: 15 shares, total cost ₹36,500
  Avg price = 36,500 / 15 = ₹2,433.33
"""

import csv
import io
import requests
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed


# ─── ISIN → ticker lookup ─────────────────────────────────────────────────────

def _lookup_one(isin: str) -> tuple[str, str | None]:
    """Query Yahoo Finance search to resolve an ISIN to a ticker symbol.
    Returns (isin, ticker) or (isin, None) on failure.
    Prefers NSE (.NS) > BSE (.BO) > any result.
    """
    try:
        resp = requests.get(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": isin, "lang": "en-US", "quotesCount": 6, "newsCount": 0},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=6,
        )
        quotes = resp.json().get("quotes", [])
        for q in quotes:
            sym = q.get("symbol", "")
            if sym.endswith(".NS"):
                return isin, sym
        for q in quotes:
            sym = q.get("symbol", "")
            if sym.endswith(".BO"):
                return isin, sym
        if quotes:
            return isin, quotes[0].get("symbol")
    except Exception:
        pass
    return isin, None


def _resolve_isins(isin_list: list[str]) -> dict[str, str]:
    """Resolve a list of ISINs to tickers in parallel (up to 10 at once).
    Returns a dict {isin: ticker} for successful lookups only.
    """
    unique = list(set(isin_list))
    result = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(_lookup_one, isin): isin for isin in unique}
        for future in as_completed(futures):
            isin, ticker = future.result()
            if ticker:
                result[isin] = ticker
    return result


# ─── Date parsing helper ──────────────────────────────────────────────────────

_DATE_FORMATS = [
    "%d/%m/%Y",       # 25/03/2023   — ICICI, SBI
    "%d-%m-%Y",       # 25-03-2023
    "%Y-%m-%d",       # 2023-03-25   — CBQ, ISO
    "%d %B %Y",       # 25 March 2023 — HSBC
    "%d-%b-%Y",       # 25-Mar-2023
    "%d/%m/%y",       # 25/03/23
    "%d-%b-%y",       # 25-Mar-23
    "%m/%d/%Y",       # 03/25/2023   — US brokers
]

def _parse_date(raw: str) -> str | None:
    """
    Try to parse a raw date string from a broker CSV.
    Returns a normalised "YYYY-MM-DD" string, or None if unparseable.
    Handles the dozen different formats brokers use.
    """
    if not raw:
        return None
    raw = raw.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None   # unrecognised format — drop rather than crash


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _is_buy(action: str) -> bool:
    """
    Returns True if the action string means "Buy".
    Handles all the different words brokers use.
    """
    return action.strip().lower() in {"b", "buy", "purchase", "bought"}


def _merge_trades(trades: list[dict]) -> list[dict]:
    """
    Takes a list of individual trades and merges them per ticker.
    Buys add to quantity; sells subtract.
    Uses weighted average for the buy price.
    Tracks the EARLIEST buy date as purchase_date.

    Input:  [{"ticker":"AAPL","qty":3,"price":150,"currency":"USD","date":"2023-01-15",...}, ...]
    Output: [{"ticker":"AAPL","quantity":3,"avg_buy_price":150,"currency":"USD","purchase_date":"2023-01-15"}, ...]
    """
    merged = {}

    for t in trades:
        ticker = t["ticker"]
        if ticker not in merged:
            merged[ticker] = {
                "ticker":        ticker,
                "name":          t["name"],
                "currency":      t["currency"],
                "total_qty":     0.0,
                "total_cost":    0.0,
                "purchase_date": None,   # will be set to earliest buy date
            }

        if t["is_buy"]:
            merged[ticker]["total_qty"]  += t["qty"]
            merged[ticker]["total_cost"] += t["qty"] * t["price"]

            # Keep the earliest buy date
            trade_date = t.get("date")
            existing   = merged[ticker]["purchase_date"]
            if trade_date:
                if existing is None or trade_date < existing:
                    merged[ticker]["purchase_date"] = trade_date
        else:
            # Sell — reduce quantity
            merged[ticker]["total_qty"] -= t["qty"]

    result = []
    for ticker, data in merged.items():
        qty = data["total_qty"]
        if qty <= 0:
            continue   # fully sold — nothing to hold

        avg_price = data["total_cost"] / qty if qty > 0 else 0

        result.append({
            "ticker":        ticker,
            "name":          data["name"],
            "quantity":      round(qty, 4),
            "avg_buy_price": round(avg_price, 4),
            "currency":      data["currency"],
            "purchase_date": data["purchase_date"],
        })

    return result


# ─── Broker parsers ───────────────────────────────────────────────────────────

def parse_icici(content: str) -> list[dict]:
    """
    Parse ICICI Direct CSV export.

    Expected columns:
        Trade Date, Scrip Code, Scrip Name, Buy/Sell, Quantity, Price, Amount

    Notes:
    - Date format: DD/MM/YYYY
    - Scrip Code is the NSE ticker (we append ".NS" to make it yfinance-friendly)
    - Buy/Sell column contains "Buy" or "Sell"
    """
    reader = csv.DictReader(io.StringIO(content.strip()))
    trades = []

    for i, row in enumerate(reader, start=2):
        row = {k.strip(): v.strip() for k, v in row.items()}

        try:
            ticker = row["Scrip Code"].upper() + ".NS"
            name   = row["Scrip Name"]
            qty    = float(row["Quantity"].replace(",", ""))
            price  = float(row["Price"].replace(",", ""))
            is_buy = _is_buy(row["Buy/Sell"])
            date   = _parse_date(row.get("Trade Date", ""))
        except (KeyError, ValueError) as e:
            raise ValueError(f"ICICI CSV — bad data on row {i}: {e}")

        trades.append({
            "ticker": ticker, "name": name,
            "qty": qty, "price": price,
            "is_buy": is_buy, "currency": "INR",
            "date": date,
        })

    return _merge_trades(trades)


def parse_sbi(content: str) -> list[dict]:
    """
    Parse SBI Securities CSV export.

    Supported column layouts (SBI has changed formats over time):

    Layout A — older export:
        Date, Scrip Name, ISIN, Buy/Sell, Quantity, Rate, Amount
        → Uses ISIN to resolve NSE ticker via Yahoo Finance

    Layout B — newer export:
        Trade Date, Scrip Code, Scrip Name, Buy/Sell, Quantity, Price, Amount
        → Uses Scrip Code directly (e.g. "BEL.NS")

    Notes:
    - Price column may be named "Rate" (Layout A) or "Price" (Layout B)
    - Skip rows where quantity is 0
    """
    reader = csv.DictReader(io.StringIO(content.strip()))
    raw_rows = []
    for i, row in enumerate(reader, start=2):
        raw_rows.append((i, {k.strip(): v.strip() for k, v in row.items()}))

    if not raw_rows:
        return []

    first_keys = set(raw_rows[0][1].keys())
    is_layout_b = "Scrip Code" in first_keys

    isin_map = {}
    if not is_layout_b and "ISIN" in first_keys:
        isins    = [row["ISIN"] for _, row in raw_rows if row.get("ISIN")]
        isin_map = _resolve_isins(isins)

    trades = []
    for i, row in raw_rows:
        try:
            if is_layout_b:
                raw_code = row.get("Scrip Code", "").strip().upper()
                ticker   = raw_code if raw_code.endswith(".NS") else raw_code + ".NS"
                date     = _parse_date(row.get("Trade Date", ""))
            else:
                isin   = row.get("ISIN", "")
                ticker = isin_map.get(isin)
                if not ticker:
                    ticker = row["Scrip Name"].strip().upper().replace(" ", "") + ".NS"
                date = _parse_date(row.get("Date", ""))

            name = row.get("Scrip Name", ticker)

            qty_raw = row["Quantity"].replace(",", "")
            qty     = float(qty_raw)
            if qty == 0:
                continue

            price_raw = row.get("Price") or row.get("Rate") or "0"
            price     = float(price_raw.replace(",", ""))
            is_buy    = _is_buy(row["Buy/Sell"])

        except (KeyError, ValueError) as e:
            raise ValueError(f"SBI CSV — bad data on row {i}: {e}")

        trades.append({
            "ticker": ticker, "name": name,
            "qty": qty, "price": price,
            "is_buy": is_buy, "currency": "INR",
            "date": date,
        })

    return _merge_trades(trades)


def parse_cbq(content: str) -> list[dict]:
    """
    Parse CBQ Alphatrade CSV export.

    Expected columns:
        Date, Symbol, Description, Action, Quantity, Price, Amount

    Notes:
    - Date format: YYYY-MM-DD
    - Symbol is already a clean US ticker (AAPL, VOO, etc.)
    - Action: "Buy" or "Sell"
    """
    reader = csv.DictReader(io.StringIO(content.strip()))
    trades = []

    for i, row in enumerate(reader, start=2):
        row = {k.strip(): v.strip() for k, v in row.items()}

        try:
            ticker = row["Symbol"].upper()
            name   = row["Description"]
            qty    = float(row["Quantity"].replace(",", ""))
            price  = float(row["Price"].replace(",", ""))
            is_buy = _is_buy(row["Action"])
            date   = _parse_date(row.get("Date", ""))
        except (KeyError, ValueError) as e:
            raise ValueError(f"CBQ CSV — bad data on row {i}: {e}")

        trades.append({
            "ticker": ticker, "name": name,
            "qty": qty, "price": price,
            "is_buy": is_buy, "currency": "USD",
            "date": date,
        })

    return _merge_trades(trades)


def parse_hsbc(content: str) -> list[dict]:
    """
    Parse HSBC WorldTrader CSV export.

    Expected columns:
        Transaction Date, Stock Code, Stock Name,
        Transaction Type, Units, Price Per Unit, Total Value

    Notes:
    - Date format: DD Month YYYY  (e.g. "15 January 2025")
    - Transaction Type: "Purchase" (buy) or "Sale" (sell)
    """
    reader = csv.DictReader(io.StringIO(content.strip()))
    trades = []

    for i, row in enumerate(reader, start=2):
        row = {k.strip(): v.strip() for k, v in row.items()}

        try:
            ticker = row["Stock Code"].upper()
            name   = row["Stock Name"]
            qty    = float(row["Units"].replace(",", ""))
            price  = float(row["Price Per Unit"].replace(",", ""))
            is_buy = _is_buy(row["Transaction Type"])
            date   = _parse_date(row.get("Transaction Date", ""))
        except (KeyError, ValueError) as e:
            raise ValueError(f"HSBC CSV — bad data on row {i}: {e}")

        trades.append({
            "ticker": ticker, "name": name,
            "qty": qty, "price": price,
            "is_buy": is_buy, "currency": "USD",
            "date": date,
        })

    return _merge_trades(trades)


def parse_standard(content: str) -> list[dict]:
    """
    Parse the generic/standard CSV template.

    Expected columns (case-insensitive):
        ticker, name, quantity, avg_buy_price, currency[, purchase_date]

    purchase_date is optional — format: YYYY-MM-DD or DD/MM/YYYY

    Example:
        ticker,name,quantity,avg_buy_price,currency,purchase_date
        RELIANCE.NS,Reliance Industries,10,2450.50,INR,2022-06-15
        AAPL,Apple Inc,5,180.00,USD,2021-03-10
    """
    reader = csv.DictReader(io.StringIO(content.strip()))

    if reader.fieldnames is None:
        raise ValueError("Standard CSV — file appears empty or has no headers")

    result = []
    for i, row in enumerate(reader, start=2):
        row = {k.strip().lower(): v.strip() for k, v in row.items()}

        try:
            ticker        = row["ticker"].upper()
            name          = row.get("name", ticker) or ticker
            quantity      = float(row["quantity"].replace(",", ""))
            avg_buy_price = float(row["avg_buy_price"].replace(",", ""))
            currency      = row.get("currency", "USD").upper()
            purchase_date = _parse_date(row.get("purchase_date", ""))
        except (KeyError, ValueError) as e:
            raise ValueError(f"Standard CSV — bad data on row {i}: {e}")

        if quantity <= 0:
            continue

        result.append({
            "ticker":        ticker,
            "name":          name,
            "quantity":      round(quantity, 4),
            "avg_buy_price": round(avg_buy_price, 4),
            "currency":      currency,
            "purchase_date": purchase_date,
        })

    return result


# ─── Dispatcher ───────────────────────────────────────────────────────────────

PARSERS = {
    "icici":    parse_icici,
    "sbi":      parse_sbi,
    "cbq":      parse_cbq,
    "hsbc":     parse_hsbc,
    "standard": parse_standard,
}


def parse_csv(broker_name: str, content: str) -> list[dict]:
    """
    Main entry point. Given a broker name and raw CSV text,
    return the standardised list of holdings.

    broker_name is matched case-insensitively, so "ICICI Direct",
    "icici direct", "ICICI" all route to parse_icici().

    If no broker-specific parser is found, falls back to parse_standard().
    """
    key = broker_name.lower()
    for known_key, parser_fn in PARSERS.items():
        if known_key in key:
            return parser_fn(content)

    return parse_standard(content)
