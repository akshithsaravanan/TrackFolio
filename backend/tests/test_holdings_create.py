"""
Tests for POST /holdings
Run with:  python -m pytest tests/ -v
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
import database
TEST_DB = os.path.join(os.path.dirname(__file__), "test_portfolio.db")
database.DB_PATH = TEST_DB

from database import create_tables
from main import app
from fastapi.testclient import TestClient

client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_db():
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)
    create_tables()
    yield
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)


@pytest.fixture
def icici_broker():
    """Create an ICICI broker and return its id — reused across tests."""
    r = client.post("/brokers", json={"name": "ICICI Direct", "currency": "INR"})
    return r.json()["id"]


@pytest.fixture
def cbq_broker():
    r = client.post("/brokers", json={"name": "CBQ Alphatrade", "currency": "USD"})
    return r.json()["id"]


# ── HAPPY PATH ───────────────────────────────────────────────────────────────

def test_create_indian_stock(icici_broker):
    response = client.post("/holdings", json={
        "broker_id":     icici_broker,
        "ticker":        "reliance.ns",   # lowercase — should be uppercased
        "name":          "Reliance Industries",
        "quantity":      10,
        "avg_buy_price": 2400.00,
        "currency":      "INR",
        "asset_type":    "stock",
    })
    assert response.status_code == 201
    data = response.json()
    assert data["ticker"] == "RELIANCE.NS"       # auto-uppercased ✓
    assert data["currency"] == "INR"
    assert data["broker_id"] == icici_broker
    assert "id" in data
    assert "created_at" in data


def test_create_us_etf(cbq_broker):
    response = client.post("/holdings", json={
        "broker_id":     cbq_broker,
        "ticker":        "VOO",
        "name":          "Vanguard S&P 500 ETF",
        "quantity":      5.5,
        "avg_buy_price": 420.00,
        "currency":      "USD",
        "asset_type":    "etf",
    })
    assert response.status_code == 201
    assert response.json()["asset_type"] == "etf"


def test_default_asset_type_is_stock(icici_broker):
    """asset_type should default to 'stock' if not supplied."""
    response = client.post("/holdings", json={
        "broker_id":     icici_broker,
        "ticker":        "TCS.NS",
        "name":          "Tata Consultancy",
        "quantity":      3,
        "avg_buy_price": 3500,
        "currency":      "INR",
        # no asset_type field
    })
    assert response.status_code == 201
    assert response.json()["asset_type"] == "stock"


# ── VALIDATION ERRORS ────────────────────────────────────────────────────────

def test_invalid_broker_id_rejected():
    response = client.post("/holdings", json={
        "broker_id":     9999,   # does not exist
        "ticker":        "AAPL",
        "name":          "Apple",
        "quantity":      1,
        "avg_buy_price": 180,
        "currency":      "USD",
    })
    assert response.status_code == 404


def test_zero_quantity_rejected(icici_broker):
    response = client.post("/holdings", json={
        "broker_id":     icici_broker,
        "ticker":        "INFY.NS",
        "name":          "Infosys",
        "quantity":      0,        # invalid
        "avg_buy_price": 1500,
        "currency":      "INR",
    })
    assert response.status_code == 422   # FastAPI validation error


def test_negative_price_rejected(icici_broker):
    response = client.post("/holdings", json={
        "broker_id":     icici_broker,
        "ticker":        "INFY.NS",
        "name":          "Infosys",
        "quantity":      5,
        "avg_buy_price": -100,     # invalid
        "currency":      "INR",
    })
    assert response.status_code == 422


def test_invalid_currency_rejected(icici_broker):
    response = client.post("/holdings", json={
        "broker_id":     icici_broker,
        "ticker":        "INFY.NS",
        "name":          "Infosys",
        "quantity":      5,
        "avg_buy_price": 1500,
        "currency":      "GBP",   # not in our accepted list
    })
    assert response.status_code == 422


def test_invalid_asset_type_rejected(icici_broker):
    response = client.post("/holdings", json={
        "broker_id":     icici_broker,
        "ticker":        "INFY.NS",
        "name":          "Infosys",
        "quantity":      5,
        "avg_buy_price": 1500,
        "currency":      "INR",
        "asset_type":    "bond",   # not in our list
    })
    assert response.status_code == 422
