"""
Tests for GET /prices/{ticker}
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


@pytest.fixture(autouse=True)
def fresh_db():
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)
    create_tables()
    yield
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)


@patch("main.get_price_usd", return_value=182.50)
def test_price_lookup_success(mock_price):
    response = client.get("/prices/AAPL")
    assert response.status_code == 200
    data = response.json()
    assert data["ticker"]    == "AAPL"
    assert data["price_usd"] == 182.50
    assert data["currency"]  == "USD"


@patch("main.get_price_usd", return_value=182.50)
def test_ticker_auto_uppercased(mock_price):
    """User types 'aapl' in lowercase — should still work."""
    response = client.get("/prices/aapl")
    assert response.json()["ticker"] == "AAPL"


@patch("main.get_price_usd", return_value=None)
def test_unknown_ticker_returns_404(mock_price):
    response = client.get("/prices/NOTREAL123")
    assert response.status_code == 404


def test_invalid_currency_returns_400():
    response = client.get("/prices/AAPL?currency=GBP")
    assert response.status_code == 400


@patch("main.get_price_usd", return_value=28.50)
def test_inr_ticker_accepted(mock_price):
    response = client.get("/prices/RELIANCE.NS?currency=INR")
    assert response.status_code == 200
    assert response.json()["currency"] == "INR"
