"""
Tests for /brokers endpoints.
Run with:  python -m pytest tests/ -v   (from the backend/ folder)
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi.testclient import TestClient
from database import create_tables, DB_PATH
import sqlite3

# Use a SEPARATE test database so we don't mess up real data
os.environ["TESTING"] = "1"
TEST_DB = os.path.join(os.path.dirname(__file__), "test_portfolio.db")


# Patch DB_PATH before importing main
import database
database.DB_PATH = TEST_DB

from main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_db():
    """Wipe and recreate the test database before each test."""
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)
    create_tables()
    yield
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)


# ── CREATE ──────────────────────────────────────────────────────────────────

def test_create_broker_success():
    response = client.post("/brokers", json={"name": "ICICI Direct", "currency": "INR"})
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "ICICI Direct"
    assert data["currency"] == "INR"
    assert "id" in data

def test_create_broker_currency_uppercased():
    """Currency should be stored as uppercase regardless of input."""
    response = client.post("/brokers", json={"name": "SBI", "currency": "inr"})
    assert response.json()["currency"] == "INR"

def test_create_broker_duplicate_name_rejected():
    client.post("/brokers", json={"name": "ICICI Direct", "currency": "INR"})
    response = client.post("/brokers", json={"name": "ICICI Direct", "currency": "INR"})
    assert response.status_code == 400

# ── LIST ────────────────────────────────────────────────────────────────────

def test_list_brokers_empty():
    response = client.get("/brokers")
    assert response.status_code == 200
    assert response.json() == []

def test_list_brokers_returns_all():
    client.post("/brokers", json={"name": "ICICI Direct", "currency": "INR"})
    client.post("/brokers", json={"name": "CBQ Alphatrade", "currency": "USD"})
    response = client.get("/brokers")
    assert len(response.json()) == 2

# ── DELETE ──────────────────────────────────────────────────────────────────

def test_delete_broker_success():
    created = client.post("/brokers", json={"name": "SBI", "currency": "INR"}).json()
    response = client.delete(f"/brokers/{created['id']}")
    assert response.status_code == 200
    assert response.json()["deleted"] is True

def test_delete_broker_not_found():
    response = client.delete("/brokers/999")
    assert response.status_code == 404
