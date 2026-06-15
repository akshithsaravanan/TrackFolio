"""
routes/brokers.py — Broker management endpoints.

A "broker" is a named account (e.g. "ICICI Direct", "HSBC") that groups holdings.
Each broker has a home currency (INR / USD / AED) which is used as the
default currency when importing CSVs for that broker.

Endpoints:
  GET    /brokers           → list all brokers for the current user
  POST   /brokers           → create a new broker
  DELETE /brokers/{id}      → delete a broker (and cascade its holdings via DB FK)

All endpoints require a valid Supabase JWT (enforced by get_current_user).
Every query is scoped to user_id so users can never see each other's data.
"""

from fastapi import APIRouter, HTTPException, Depends

from auth import get_current_user
from supabase_client import supabase as db
from models import BrokerIn

router = APIRouter(prefix="/brokers", tags=["Brokers"])


@router.get("")
def list_brokers(user_id: str = Depends(get_current_user)):
    """
    Return all brokers belonging to the authenticated user, sorted by name.

    Response: list of {id, name, currency}
    """
    result = (
        db.table("brokers")
        .select("id, name, currency")
        .eq("user_id", user_id)
        .order("name")
        .execute()
    )
    return result.data


@router.post("", status_code=201)
def create_broker(broker: BrokerIn, user_id: str = Depends(get_current_user)):
    """
    Create a new broker for the current user.

    name    — display label shown in the Holdings table
    currency — home currency of the brokerage account (INR / USD / AED)

    The currency is stored uppercase and used as the default currency
    for holdings and CSV imports linked to this broker.
    """
    try:
        result = db.table("brokers").insert({
            "user_id":  user_id,
            "name":     broker.name.strip(),
            "currency": broker.currency.strip().upper(),
        }).execute()
        return result.data[0]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not create broker: {e}")


@router.delete("/{broker_id}")
def delete_broker(broker_id: int, user_id: str = Depends(get_current_user)):
    """
    Delete a broker by ID.

    The .eq("user_id", user_id) guard ensures a user cannot delete another
    user's broker — Supabase returns an empty result set in that case,
    which we surface as a 404.
    """
    result = (
        db.table("brokers")
        .delete()
        .eq("id", broker_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Broker not found")
    return {"deleted": True}
