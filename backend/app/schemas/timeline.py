from datetime import date, datetime
from pydantic import BaseModel


class CaseTimelineResponse(BaseModel):
    id: int
    organization_id: int
    case_id: int
    actor_id: int | None
    actor_name: str | None = None
    event_type: str
    title: str
    description: str | None
    metadata: dict | None = None
    created_at: datetime
    status: str | None = None
    completed: bool | None = None
    event_date: date | None = None
    locked: bool | None = None


class TimelineEventCreate(BaseModel):
    title: str
    event_type: str
    description: str | None = None
    status: str | None = "active"
    completed: bool = False
    event_date: date | None = None


class TimelineEventUpdate(BaseModel):
    title: str | None = None
    event_type: str | None = None
    description: str | None = None
    status: str | None = None
    completed: bool | None = None
    event_date: date | None = None
    locked: bool | None = None
