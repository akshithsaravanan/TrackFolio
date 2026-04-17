"""
Tests for GET /holdings

KEY IDEA: We don't want tests calling the real yfinance (slow, needs internet,
prices change). So we use unittest.mock.patch to REPLACE the real functions
with fake ones that return predictable values.

NOTE: main.py now calls get_prices_batch() (not get_price_usd one-by-one),
so our mocks target get_prices_batch instead.
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from unittest.mock import patch
import database

TEST_DB = os.path.join(os.path.dirname(__file__), "test_portfolio.db")
database.DB_PATH = TEST_DB

from database import create_tables
from main import app
from fastapi.testclient import TestClient

client = TestClient(app)


# ── Fake data ────────────────────────────────────────────────────────────────

FAKE_PRICES = {
    "RELIANCE.NS": 20.00,
    "TCS.NS":      14.00,
    "AAPL":       180.00,
}

FAKE_FX = {
    "INR": 1 / 83.5,
    "USD": 1.0,
    "AED": 1 / 3.67,
}

def fake_get_prices_batch(ticker_currency_pairs):
    # Returns a dict just like the real function: { ticker: price_usd }
    return {ticker: FAKE_PRICES.get(ticker) for ticker, _ in ticker_currency_pairs}

def fake_convert_to_usd(amount, currency):
    rate = FAKE_FX.get(currency, 1.0)
    return round(amount * rate, 4)

def fake_prices_batch_all_none(ticker_currency_pairs):
    # Simulates total network failure — all prices are None
    return {ticker: None for ticker, _ in ticker_currency_pairs}


# ── Setup / teardown ──────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def fresh_db():
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)
    create_tables()
    yield
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)


@pytest.fixture
def setup_portfolio():
    icici = client.post("/brokers", json={"name": "ICICI Direct", "currency": "INR"}).json()["id"]
    cbq   = client.post("/brokers", json={"name": "CBQ Alphatrade", "currency": "USD"}).json()["id"]

    client.post("/holdings", json={
        "broker_id": icici, "ticker": "RELIANCE.NS", "name": "Reliance",
        "quantity": 10, "avg_buy_price": 2400, "currency": "INR",
    })
    client.post("/holdings", json={
        "broker_id": icici, "ticker": "TCS.NS", "name": "TCS",
        "quantity": 5, "avg_buy_price": 3500, "currency": "INR",
    })
    client.post("/holdings", json={
        "broker_id": cbq, "ticker": "AAPL", "name": "Apple",
        "quantity": 3, "avg_buy_price": 150, "currency": "USD",
    })
    return icici, cbq


# ── Tests ─────────────────────────────────────────────────────────────────────

@patch("main.get_prices_batch", side_effect=fake_get_prices_batch)
@patch("main.convert_to_usd",   side_effect=fake_convert_to_usd)
def test_list_all_holdings_returns_three(mock_fx, mock_batch, setup_portfolio):
    response = client.get("/holdings")
    assert response.status_code == 200
    assert len(response.json()["holdings"]) == 3


@patch("main.get_prices_batch", side_effect=fake_get_prices_batch)
@patch("main.convert_to_usd",   side_effect=fake_convert_to_usd)
def test_holding_has_expected_fields(mock_fx, mock_batch, setup_portfolio):
    response = client.get("/holdings")
    h = response.json()["holdings"][0]
    for field in ["ticker", "quantity", "current_price_usd",
                  "market_value_usd", "cost_basis_usd",
                  "gain_loss_usd", "gain_loss_pct", "broker_name"]:
        assert field in h, f"Missing field: {field}"


@patch("main.get_prices_batch", side_effect=fake_get_prices_batch)
@patch("main.convert_to_usd",   side_effect=fake_convert_to_usd)
def test_gain_loss_maths_correct(mock_fx, mock_batch, setup_portfolio):
    """
    AAPL: bought 3 @ $150, now $180
    cost_basis   = 3 × 150 = $450
    market_value = 3 × 180 = $540
    gain_loss    = $90  (20%)
    """
    holdings = client.get("/holdings").json()["holdings"]
    aapl = next(h for h in holdings if h["ticker"] == "AAPL")

    assert aapl["cost_basis_usd"]   == 450.0
    assert aapl["market_value_usd"] == 540.0
    assert aapl["gain_loss_usd"]    == 90.0
    assert aapl["gain_loss_pct"]    == 20.0


@patch("main.get_prices_batch", side_effect=fake_get_prices_batch)
@patch("main.convert_to_usd",   side_effect=fake_convert_to_usd)
def test_filter_by_broker(mock_fx, mock_batch, setup_portfolio):
    icici_id, _ = setup_portfolio
    holdings = client.get(f"/holdings?broker_id={icici_id}").json()["holdings"]
    assert len(holdings) == 2
    assert all(h["broker_name"] == "ICICI Direct" for h in holdings)


@patch("main.get_prices_batch", side_effect=fake_get_prices_batch)
@patch("main.convert_to_usd",   side_effect=fake_convert_to_usd)
def test_summary_block_exists(mock_fx, mock_batch, setup_portfolio):
    summary = client.get("/holdings").json()["summary"]
    assert "total_market_value_usd" in summary
    assert "total_gain_loss_usd"    in summary
    assert summary["count"] == 3


@patch("main.get_prices_batch", side_effect=fake_prices_batch_all_none)
@patch("main.convert_to_usd",   side_effect=fake_convert_to_usd)
def test_null_price_when_yfinance_fails(mock_fx, mock_batch, setup_portfolio):
    """If yfinance fails, fields should be None — not crash."""
    response = client.get("/holdings")
    assert response.status_code == 200
    for h in response.json()["holdings"]:
        assert h["current_price_usd"] is None
        assert h["market_value_usd"]  is None


@patch("main.get_prices_batch", side_effect=fake_get_prices_batch)
@patch("main.convert_to_usd",   side_effect=fake_convert_to_usd)
def test_empty_portfolio_returns_empty(mock_fx, mock_batch):
    data = client.get("/holdings").json()
    assert data["holdings"] == []
    assert data["summary"]["count"] == 0
