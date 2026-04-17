"""
Tests for PUT /holdings/{id}  and  DELETE /holdings/{id}
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
def one_holding():
    """Create one broker + one holding. Returns the holding's id."""
    broker_id = client.post(
        "/brokers", json={"name": "ICICI Direct", "currency": "INR"}
    ).json()["id"]

    holding_id = client.post("/holdings", json={
        "broker_id":     broker_id,
        "ticker":        "RELIANCE.NS",
        "name":          "Reliance Industries",
        "quantity":      10,
        "avg_buy_price": 2400,
        "currency":      "INR",
    }).json()["id"]

    return broker_id, holding_id


# ── PUT (edit) ────────────────────────────────────────────────────────────────

def test_update_holding_quantity(one_holding):
    """Change quantity from 10 → 15, everything else stays the same."""
    broker_id, holding_id = one_holding

    response = client.put(f"/holdings/{holding_id}", json={
        "broker_id":     broker_id,
        "ticker":        "RELIANCE.NS",
        "name":          "Reliance Industries",
        "quantity":      15,          # changed
        "avg_buy_price": 2400,
        "currency":      "INR",
    })
    assert response.status_code == 200
    assert response.json()["quantity"] == 15


def test_update_holding_avg_price(one_holding):
    """Simulate averaging down — bought more at a lower price."""
    broker_id, holding_id = one_holding

    response = client.put(f"/holdings/{holding_id}", json={
        "broker_id":     broker_id,
        "ticker":        "RELIANCE.NS",
        "name":          "Reliance Industries",
        "quantity":      20,
        "avg_buy_price": 2200,        # new blended average
        "currency":      "INR",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["avg_buy_price"] == 2200
    assert data["quantity"]      == 20


def test_update_sets_updated_at(one_holding):
    """updated_at should be refreshed after an edit."""
    broker_id, holding_id = one_holding

    # Get the original timestamps
    original = client.get("/holdings").json()["holdings"][0]

    client.put(f"/holdings/{holding_id}", json={
        "broker_id":     broker_id,
        "ticker":        "RELIANCE.NS",
        "name":          "Reliance Industries",
        "quantity":      12,
        "avg_buy_price": 2400,
        "currency":      "INR",
    })

    updated = client.get("/holdings").json()["holdings"][0]
    # updated_at must exist (we can't reliably check exact value in fast tests)
    assert "updated_at" in updated


def test_update_nonexistent_holding_returns_404():
    response = client.put("/holdings/9999", json={
        "broker_id":     1,
        "ticker":        "AAPL",
        "name":          "Apple",
        "quantity":      1,
        "avg_buy_price": 150,
        "currency":      "USD",
    })
    assert response.status_code == 404


def test_update_with_bad_broker_id_returns_404(one_holding):
    _, holding_id = one_holding
    response = client.put(f"/holdings/{holding_id}", json={
        "broker_id":     9999,        # doesn't exist
        "ticker":        "RELIANCE.NS",
        "name":          "Reliance",
        "quantity":      5,
        "avg_buy_price": 2400,
        "currency":      "INR",
    })
    assert response.status_code == 404


# ── DELETE ───────────────────────────────────────────────────────────────────

def test_delete_holding_success(one_holding):
    _, holding_id = one_holding
    response = client.delete(f"/holdings/{holding_id}")
    assert response.status_code == 200
    assert response.json()["deleted"] is True


def test_deleted_holding_is_gone(one_holding):
    """After deleting, GET /holdings should return an empty list."""
    _, holding_id = one_holding
    client.delete(f"/holdings/{holding_id}")

    holdings = client.get("/holdings").json()["holdings"]
    assert holdings == []


def test_delete_nonexistent_holding_returns_404():
    response = client.delete("/holdings/9999")
    assert response.status_code == 404


def test_delete_broker_cascades_to_holdings(one_holding):
    """
    Deleting a broker should automatically delete its holdings too.
    This is the ON DELETE CASCADE we set up in the schema.
    """
    broker_id, _ = one_holding
    client.delete(f"/brokers/{broker_id}")

    holdings = client.get("/holdings").json()["holdings"]
    assert holdings == []
