"""
email_service.py — Send transactional emails via Resend API.

Configure in .env / Railway:
    RESEND_API_KEY = re_xxxxxxxxxxxx   ← from resend.com dashboard
    ADMIN_EMAIL    = you@example.com   ← where new-signup alerts are sent
    FRONTEND_URL   = https://vriddhi.app

Without a custom domain, emails are sent from onboarding@resend.dev (Resend sandbox).
Once you add a domain, change RESEND_FROM below to noreply@yourdomain.com.

If RESEND_API_KEY is not set, emails are silently skipped (logged to console)
so the app keeps working without email configured.
"""

import logging
import os
import threading
import requests
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
ADMIN_EMAIL    = os.getenv("ADMIN_EMAIL",    "")
FRONTEND_URL   = os.getenv("FRONTEND_URL",   "https://vriddhi.app").rstrip("/")
RESEND_FROM    = "TrackFolio <onboarding@resend.dev>"   # swap to your domain when ready

RESEND_URL = "https://api.resend.com/emails"


# ─────────────────────────────────────────────────────────────────────────────
#  Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _send(to: str, subject: str, html: str):
    """Send one email via Resend. Logs and returns silently if not configured."""
    if not RESEND_API_KEY:
        logger.warning("[email] RESEND_API_KEY not set — skipping: %s → %s", subject, to)
        return
    try:
        r = requests.post(
            RESEND_URL,
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type":  "application/json",
            },
            json={"from": RESEND_FROM, "to": [to], "subject": subject, "html": html},
            timeout=10,
        )
        if r.status_code in (200, 201):
            logger.info("[email] Sent '%s' → %s", subject, to)
        else:
            logger.error("[email] Resend error %s: %s", r.status_code, r.text)
    except Exception as e:
        logger.error("[email] Failed to send '%s' → %s: %s", subject, to, e)


def _send_async(to: str, subject: str, html: str):
    """Fire-and-forget — runs in a daemon thread so it never blocks the API."""
    threading.Thread(target=_send, args=(to, subject, html), daemon=True).start()


# ─────────────────────────────────────────────────────────────────────────────
#  Email templates
# ─────────────────────────────────────────────────────────────────────────────

def send_signup_alert(new_user_email: str):
    """
    Notify the admin that a new user has signed up and is using the app.
    Called from auth.py on the user's very first API request.
    Non-blocking — runs in a daemon thread.
    """
    if not ADMIN_EMAIL:
        logger.warning("[email] ADMIN_EMAIL not set — no signup alert for %s", new_user_email)
        return

    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    html = f"""
<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px;">
<div style="max-width:480px;margin:0 auto;background:#1e293b;border-radius:12px;padding:32px;border:1px solid #334155;">
  <div style="font-size:28px;margin-bottom:8px;">👋</div>
  <h2 style="margin:0 0 16px;font-size:18px;color:#f8fafc;">New user on TrackFolio</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
    <tr>
      <td style="padding:8px 0;color:#94a3b8;font-size:13px;">Email</td>
      <td style="padding:8px 0;color:#f8fafc;font-size:13px;font-weight:600;">{new_user_email}</td>
    </tr>
    <tr>
      <td style="padding:8px 0;color:#94a3b8;font-size:13px;">First seen</td>
      <td style="padding:8px 0;color:#f8fafc;font-size:13px;">{now_utc}</td>
    </tr>
  </table>
  <p style="color:#94a3b8;font-size:13px;margin:0 0 24px;line-height:1.6;">
    They have full access and can start adding holdings right away.<br>
    You can view all registered users in the
    <strong style="color:#e2e8f0;">Supabase dashboard → Authentication → Users</strong>.
  </p>
  <a href="{FRONTEND_URL}"
     style="display:inline-block;background:#f59e0b;color:#0f172a;text-decoration:none;
            padding:10px 24px;border-radius:8px;font-weight:700;font-size:14px;">
    Open TrackFolio →
  </a>
  <p style="margin-top:24px;font-size:11px;color:#475569;">
    TrackFolio Admin Notification · <a href="{FRONTEND_URL}" style="color:#94a3b8;">{FRONTEND_URL}</a>
  </p>
</div>
</body></html>"""

    _send_async(ADMIN_EMAIL, f"👋 New TrackFolio user: {new_user_email}", html)


def send_approval_email(user_email: str):
    """
    Notify the user that their account has been approved.
    Called from the /admin/users/{id}/approve endpoint.
    """
    html = f"""
<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px;">
<div style="max-width:480px;margin:0 auto;background:#1e293b;border-radius:12px;padding:32px;border:1px solid #334155;">
  <div style="font-size:28px;margin-bottom:8px;">✅</div>
  <h2 style="margin:0 0 12px;font-size:18px;color:#f8fafc;">Your TrackFolio account is approved!</h2>
  <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">
    Your account <strong style="color:#e2e8f0;">{user_email}</strong> has been approved.
    You can now access your portfolio tracker.
  </p>
  <a href="{FRONTEND_URL}"
     style="display:inline-block;background:#f59e0b;color:#0f172a;text-decoration:none;
            padding:12px 28px;border-radius:8px;font-weight:700;font-size:15px;">
    Access TrackFolio →
  </a>
  <p style="margin-top:28px;font-size:11px;color:#475569;">
    TrackFolio · Track your multi-currency portfolio ·
    <a href="{FRONTEND_URL}" style="color:#94a3b8;">{FRONTEND_URL}</a>
  </p>
</div>
</body></html>"""

    _send_async(user_email, "✅ Your TrackFolio account is approved!", html)
