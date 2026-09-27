import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LoginIn(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_.]+$")
    password: str = Field(min_length=4, max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str


class LoginOut(BaseModel):
    access_token: str
    user: UserOut
    created: bool  # True = this login created the account


class FriendOut(UserOut):
    online: bool | None  # None = the signal server could not be reached


class FriendRequestIn(BaseModel):
    username: str


class FriendRequestOut(BaseModel):
    id: int
    user: UserOut  # the OTHER person
    direction: str  # "incoming" | "outgoing"
    created_at: datetime


class CallOut(BaseModel):
    id: uuid.UUID
    direction: str  # "outgoing" | "incoming"
    other: UserOut
    media: str
    status: str
    end_reason: str | None
    created_at: datetime
    answered_at: datetime | None
    ended_at: datetime | None


class ClientConfigOut(BaseModel):
    ice_servers: list[dict]


# ---- internal (signal server -> backend) ----


class CanCallOut(BaseModel):
    allowed: bool
    reason: str | None = None


class InternalCallCreate(BaseModel):
    id: uuid.UUID
    caller_id: int
    callee_id: int
    media: str


class InternalCallUpdate(BaseModel):
    status: str
    end_reason: str | None = None
