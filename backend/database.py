"""
database.py — SQLite, used ONLY for price_cache.

Brokers and holdings have moved to Supabase PostgreSQL (multi-user).
Price cache stays local because:
  - prices are the same for all users (no user_id needed)
  - local SQLite is faster than a network call to Supabase
  - it's just a 5-minute cache, not real user data
"""

import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "portfolio.db")


def get_connection():
    """Open a connection to the local SQLite database."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def create_tables():
    """Create price_cache table if it doesn't exist."""
    conn = get_connection()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS price_cache (
            ticker      TEXT PRIMARY KEY,
            price_usd   REAL NOT NULL,
            fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS history_cache (
            cache_key   TEXT PRIMARY KEY,
            data        TEXT NOT NULL,
            fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """)
    conn.commit()
    conn.close()
