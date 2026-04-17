"""
Tests for CSV import — two layers:
  1. Unit tests on the parser functions directly (csv_import.py)
  2. Integration tests on the POST /import/csv endpoint
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
import io
import database

TEST_DB = os.path.join(os.path.dirname(__file__), "test_portfolio.db")
database.DB_PATH = TEST_DB

from database import create_tables
from main import app
from fastapi.testclient import TestClient
from csv_import import parse_icici, parse_sbi, parse_cbq, parse_hsbc

client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_db():
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)
    create_tables()
    yield
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)


# ── Sample CSV strings — one per broker ──────────────────────────────────────

ICICI_CSV = """Trade Date,Scrip Code,Scrip Name,Buy/Sell,Quantity,Price,Amount
15/01/2025,RELIANCE,Reliance Industries,Buy,10,2400.00,24000.00
15/01/2025,TCS,Tata Consultancy Services,Buy,5,3500.00,17500.00
20/01/2025,RELIANCE,Reliance Industries,Buy,5,2300.00,11500.00"""
# Note: RELIANCE appears twice — should be merged into 15 shares

SBI_CSV = """Date,Scrip Name,ISIN,Buy/Sell,Quantity,Rate,Amount
15-Jan-2025,INFY,INE009A01021,B,8,1500.00,12000.00
16-Jan-2025,HDFCBANK,INE040A01034,B,3,1700.00,5100.00"""

CBQ_CSV = """Date,Symbol,Description,Action,Quantity,Price,Amount
2025-01-15,AAPL,Apple Inc,Buy,3,150.00,450.00
2025-01-16,VOO,Vanguard S&P 500 ETF,Buy,2,420.00,840.00
2025-01-20,AAPL,Apple Inc,Sell,1,180.00,180.00"""
# AAPL: bought 3, sold 1 → should end up with 2 shares

HSBC_CSV = """Transaction Date,Stock Code,Stock Name,Transaction Type,Units,Price Per Unit,Total Value
15 January 2025,MSFT,Microsoft Corporation,Purchase,4,380.00,1520.00
16 January 2025,NVDA,Nvidia Corporation,Purchase,2,600.00,1200.00"""


# ── Parser unit tests ─────────────────────────────────────────────────────────

def test_icici_parser_merges_duplicate_ticker():
    """RELIANCE bought twice should merge into one row."""
    result = parse_icici(ICICI_CSV)
    tickers = [h["ticker"] for h in result]

    assert "RELIANCE.NS" in tickers
    reliance = next(h for h in result if h["ticker"] == "RELIANCE.NS")

    # 10 shares @ 2400 + 5 shares @ 2300 = 15 shares, avg = (24000+11500)/15 = 2366.67
    assert reliance["quantity"] == 15.0
    assert reliance["avg_buy_price"] == round((24000 + 11500) / 15, 4)


def test_icici_parser_appends_ns_suffix():
    result = parse_icici(ICICI_CSV)
    for h in result:
        assert h["ticker"].endswith(".NS"), f"{h['ticker']} missing .NS suffix"


def test_icici_parser_currency_is_inr():
    result = parse_icici(ICICI_CSV)
    assert all(h["currency"] == "INR" for h in result)


def test_sbi_parser_returns_two_holdings():
    result = parse_sbi(SBI_CSV)
    assert len(result) == 2


def test_sbi_parser_appends_ns():
    result = parse_sbi(SBI_CSV)
    assert all(h["ticker"].endswith(".NS") for h in result)


def test_cbq_parser_handles_sell():
    """AAPL: buy 3, sell 1 → quantity should be 2."""
    result = parse_cbq(CBQ_CSV)
    aapl = next(h for h in result if h["ticker"] == "AAPL")
    assert aapl["quantity"] == 2.0


def test_cbq_parser_currency_is_usd():
    result = parse_cbq(CBQ_CSV)
    assert all(h["currency"] == "USD" for h in result)


def test_hsbc_parser_purchase_keyword():
    """HSBC uses 'Purchase' not 'Buy' — parser must handle it."""
    result = parse_hsbc(HSBC_CSV)
    assert len(result) == 2
    tickers = [h["ticker"] for h in result]
    assert "MSFT" in tickers
    assert "NVDA" in tickers


def test_hsbc_parser_currency_is_usd():
    result = parse_hsbc(HSBC_CSV)
    assert all(h["currency"] == "USD" for h in result)


def test_unknown_broker_raises_error():
    from csv_import import parse_csv
    with pytest.raises(ValueError, match="No CSV parser"):
        parse_csv("Unknown Broker XYZ", "some,csv,content")


# ── Endpoint integration tests ────────────────────────────────────────────────

@pytest.fixture
def icici_broker():
    return client.post(
        "/brokers", json={"name": "ICICI Direct", "currency": "INR"}
    ).json()["id"]

@pytest.fixture
def cbq_broker():
    return client.post(
        "/brokers", json={"name": "CBQ Alphatrade", "currency": "USD"}
    ).json()["id"]


def test_import_icici_csv(icici_broker):
    response = client.post(
        "/import/csv",
        data={"broker_id": icici_broker},
        files={"file": ("icici.csv", io.BytesIO(ICICI_CSV.encode()), "text/csv")},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["imported"] == 2   # RELIANCE + TCS (merged)
    assert data["skipped"]  == 0


def test_import_cbq_csv(cbq_broker):
    response = client.post(
        "/import/csv",
        data={"broker_id": cbq_broker},
        files={"file": ("cbq.csv", io.BytesIO(CBQ_CSV.encode()), "text/csv")},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["imported"] == 2   # AAPL (net 2 shares) + VOO


def test_import_updates_existing_holding(icici_broker):
    """Importing the same CSV twice should update, not duplicate."""
    # First import
    client.post(
        "/import/csv",
        data={"broker_id": icici_broker},
        files={"file": ("icici.csv", io.BytesIO(ICICI_CSV.encode()), "text/csv")},
    )
    # Second import
    client.post(
        "/import/csv",
        data={"broker_id": icici_broker},
        files={"file": ("icici.csv", io.BytesIO(ICICI_CSV.encode()), "text/csv")},
    )

    # Should still only have 2 holdings, not 4
    from unittest.mock import patch
    with patch("main.get_price_usd", return_value=None), \
         patch("main.convert_to_usd", return_value=None):
        holdings = client.get("/holdings").json()["holdings"]

    assert len(holdings) == 2


def test_import_invalid_broker_returns_404():
    response = client.post(
        "/import/csv",
        data={"broker_id": 9999},
        files={"file": ("x.csv", io.BytesIO(ICICI_CSV.encode()), "text/csv")},
    )
    assert response.status_code == 404


def test_import_empty_file_returns_400(icici_broker):
    response = client.post(
        "/import/csv",
        data={"broker_id": icici_broker},
        files={"file": ("empty.csv", io.BytesIO(b""), "text/csv")},
    )
    assert response.status_code == 400
