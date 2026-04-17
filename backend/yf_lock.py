"""
yf_lock.py — shared threading lock for all yfinance downloads.

yfinance uses a shared requests.Session internally. When multiple FastAPI
worker threads call yf.download() concurrently (e.g. /holdings + /analytics/52week
+ /analytics/fx-history all firing at once), they corrupt each other's responses —
producing duplicate prices, wrong ticker data, or empty results.

Solution: every yf.download() call in the app must acquire this lock first.
"""
import threading

YF_LOCK = threading.Lock()
