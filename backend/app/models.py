"""Pydantic models for request/response validation."""
from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime

# Auth models
class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=6)

class UserLogin(BaseModel):
    username: str
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"

class UserResponse(BaseModel):
    id: int
    username: str
    created_at: datetime

    class Config:
        from_attributes = True

# Chat models
class MessageCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=4000)

class MessageResponse(BaseModel):
    id: int
    content: str
    role: str  # "user" or "assistant"
    created_at: datetime

    class Config:
        from_attributes = True

class ChatHistoryResponse(BaseModel):
    messages: List[MessageResponse]
    total: int

# EV Status model
class EVStatus(BaseModel):
    battery_level: float = Field(..., ge=0, le=100)
    range_km: float
    charging: bool
    charge_rate_kw: Optional[float] = None
    estimated_full_charge: Optional[str] = None
    odometer_km: float
    last_updated: datetime
