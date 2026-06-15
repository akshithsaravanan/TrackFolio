"""
auth.py — FastAPI dependency that verifies the Supabase JWT token.

Every protected endpoint adds:
    user_id: str = Depends(get_current_user)

Flow:
    Frontend sends:  Authorization: Bearer eyJhbGci...
    FastAPI calls:   supabase.auth.get_user(token)
    Supabase checks: is this token valid? not expired?
    Returns:         user object with .id (the UUID)

We never handle JWT signing/verification ourselves —
Supabase does it using whichever key type it currently uses (ECC P-256 etc.)

First-visit tracking:
    When a user_id is seen for the first time this server session, a
    background thread checks the user_approvals table. If not found it
    inserts a row and sends you a notification email. Fully non-blocking.
"""

import logging
import threading
from fastapi import Header, HTTPException
from supabase_client import supabase
from email_service import send_signup_alert

logger = logging.getLogger(__name__)

# In-memory set of user_ids we've already tracked this server session.
# Prevents redundant DB look-ups on every request.
# Cleared on server restart (Railway restart), which just triggers one extra
# DB check per user — totally fine.
_seen_users: set = set()


def _track_new_user(user_id: str, user_email: str):
    """
    Background job: insert into user_approvals if this is the user's first
    ever visit, then send admin notification email.
    Runs in a daemon thread — never blocks the API response.
    """
    try:
        result = (
            supabase.table("user_approvals")
            .select("user_id")
            .eq("user_id", user_id)
            .execute()
        )
        if not result.data:
            # Truly new user — record them and ping the admin
            supabase.table("user_approvals").insert({
                "user_id": user_id,
                "email":   user_email,
                "approved": True,          # no gate — just for tracking
            }).execute()
            send_signup_alert(user_email)
            logger.info("[tracking] New user recorded: %s", user_email)
    except Exception as e:
        logger.error("[tracking] Error tracking user %s: %s", user_id, e)


async def get_current_user(authorization: str = Header(...)) -> str:
    """
    Extract and verify user from JWT token.
    Returns user_id (UUID string) on success.
    Raises 401 on invalid/expired token.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Authorization header must be: Bearer <token>"
        )

    token = authorization[7:]   # strip "Bearer "

    try:
        response = supabase.auth.get_user(token)
    except Exception:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired token. Please log in again."
        )

    user_id    = response.user.id     # UUID string e.g. "a3f8c2d1-9b4e-..."
    user_email = response.user.email or ""

    # Fire first-visit tracking in background — zero impact on response time
    if user_id not in _seen_users:
        _seen_users.add(user_id)
        threading.Thread(
            target=_track_new_user,
            args=(user_id, user_email),
            daemon=True,
        ).start()

    return user_id
