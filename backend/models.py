"""
models.py — Shared Pydantic request models and validation constants.

All route modules import from here so validation logic lives in one place.
Changing a rule here (e.g. adding a new currency) propagates everywhere automatically.
"""

from pydantic import BaseModel, field_validator
from typing import Optional


# ─────────────────────────────────────────────
#  VALIDATION CONSTANTS
#  Single source of truth — import these in routes instead of re-defining.
# ─────────────────────────────────────────────

VALID_CURRENCIES  = {"INR", "USD", "AED"}
VALID_ASSET_TYPES = {"stock", "etf", "mf"}
VALID_PERIODS     = {"7d", "30d", "90d", "ytd", "1y"}


# ─────────────────────────────────────────────
#  BROKER
# ─────────────────────────────────────────────

class BrokerIn(BaseModel):
    """Payload for creating a new broker account."""
    name:     str
    currency: str


# ─────────────────────────────────────────────
#  HOLDING
# ─────────────────────────────────────────────

class HoldingIn(BaseModel):
    """
    Payload for creating or updating a single holding.

    Validators enforce:
    - ticker is uppercased and stripped
    - currency is one of VALID_CURRENCIES
    - asset_type is one of VALID_ASSET_TYPES
    - quantity > 0
    - avg_buy_price >= 0
    """
    broker_id:     int
    ticker:        str
    name:          str           = ""
    quantity:      float
    avg_buy_price: float
    currency:      str
    asset_type:    str           = "stock"
    purchase_date: Optional[str] = None   # "YYYY-MM-DD" — when the holding was first bought
    notes:         str           = ""

    @field_validator("ticker")
    @classmethod
    def ticker_uppercase(cls, v):
        return v.strip().upper()

    @field_validator("currency")
    @classmethod
    def currency_valid(cls, v):
        v = v.strip().upper()
        if v not in VALID_CURRENCIES:
            raise ValueError(f"currency must be one of {VALID_CURRENCIES}")
        return v

    @field_validator("asset_type")
    @classmethod
    def asset_type_valid(cls, v):
        v = v.strip().lower()
        if v not in VALID_ASSET_TYPES:
            raise ValueError(f"asset_type must be one of {VALID_ASSET_TYPES}")
        return v

    @field_validator("quantity")
    @classmethod
    def quantity_positive(cls, v):
        if v <= 0:
            raise ValueError("quantity must be greater than 0")
        return v

    @field_validator("avg_buy_price")
    @classmethod
    def price_non_negative(cls, v):
        if v < 0:
            raise ValueError("avg_buy_price cannot be negative")
        return v


# ─────────────────────────────────────────────
#  PRICE ALERT
# ─────────────────────────────────────────────

class AlertIn(BaseModel):
    """
    Payload for setting a price alert on a ticker.

    condition must be "above" or "below".
    target_price must be positive.
    """
    ticker:       str
    name:         str   = ""
    target_price: float
    condition:    str             # "above" or "below"
    currency:     str   = "INR"

    @field_validator("condition")
    @classmethod
    def validate_condition(cls, v):
        if v not in ("above", "below"):
            raise ValueError("condition must be 'above' or 'below'")
        return v

    @field_validator("target_price")
    @classmethod
    def validate_price(cls, v):
        if v <= 0:
            raise ValueError("target_price must be positive")
        return v


# ─────────────────────────────────────────────
#  TRANSACTION
# ─────────────────────────────────────────────

class TransactionIn(BaseModel):
    """
    Payload for recording a trade or dividend.

    type must be one of: buy | sell | dividend
    quantity must be positive, price must be non-negative.
    trade_date must be "YYYY-MM-DD".
    """
    ticker:     str
    name:       str           = ""
    type:       str                       # buy | sell | dividend
    quantity:   float
    price:      float                     # in native currency
    currency:   str
    broker_id:  Optional[int] = None
    trade_date: str                       # "YYYY-MM-DD"
    notes:      str           = ""

    @field_validator("ticker")
    @classmethod
    def upper_ticker(cls, v): return v.strip().upper()

    @field_validator("type")
    @classmethod
    def valid_type(cls, v):
        v = v.strip().lower()
        if v not in ("buy", "sell", "dividend"):
            raise ValueError("type must be buy, sell, or dividend")
        return v

    @field_validator("currency")
    @classmethod
    def valid_ccy(cls, v):
        v = v.strip().upper()
        if v not in VALID_CURRENCIES:
            raise ValueError(f"currency must be one of {VALID_CURRENCIES}")
        return v

    @field_validator("quantity")
    @classmethod
    def positive_qty(cls, v):
        if v <= 0:
            raise ValueError("quantity must be positive")
        return v

    @field_validator("price")
    @classmethod
    def non_negative_price(cls, v):
        if v < 0:
            raise ValueError("price cannot be negative")
        return v


# ─────────────────────────────────────────────
#  AI / COPILOT
# ─────────────────────────────────────────────

class AskIn(BaseModel):
    """Payload for the natural-language portfolio Q&A endpoint."""
    question: str
