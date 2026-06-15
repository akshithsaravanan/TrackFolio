"""
routes/ — FastAPI APIRouter modules.

Each file owns one domain of the API:
  brokers.py      → /brokers
  alerts.py       → /alerts
  holdings.py     → /holdings
  transactions.py → /transactions
  prices.py       → /prices, /sparklines, /portfolio/history
  analytics.py    → /analytics/*
  markets.py      → /markets/*
  admin.py        → /admin/*, /import/csv, /search/ticker

main.py imports and registers all routers via app.include_router().
"""
