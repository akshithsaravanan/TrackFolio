"""
supabase_client.py — initialises the Supabase client for the backend.

Uses the SERVICE ROLE key (full admin access, bypasses RLS).
Never expose this key to the frontend.

Reads credentials from .env — never hard-code them here.
"""

import os
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL      = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise ValueError(
        "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in portfolio/backend/.env"
    )

# Single shared client — reused across all requests
supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
