from datetime import datetime
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator


class TaskCreate(BaseModel):
    case_id: int | None = None
    title: str
    client_id: int | None = None
    assigned_to: int | None = Field(default=None, validation_alias=AliasChoices("assigned_to", "assigned_user_id"))
    description: str | None = None
    task_type: str = "general"
    status: str
    priority: str
    due_date: datetime
    reminder_at: datetime | None = None
    notes: str | None = None

    @model_validator(mode="after")
    def _ensure_assignee(self):
        if self.assigned_to is None:
            raise ValueError("assigned_user_id is required")
        return self


class TaskUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    case_id: int | None = None
    client_id: int | None = None
    assigned_to: int | None = Field(default=None, validation_alias=AliasChoices("assigned_to", "assigned_user_id"))
    title: str | None = None
    description: str | None = None
    task_type: str | None = None
    status: str | None = None
    priority: str | None = None
    due_date: datetime | None = None
    reminder_at: datetime | None = None
    notes: str | None = None
    completed_at: datetime | None = None


class TaskResponse(BaseModel):
    id: int
    organization_id: int
    case_id: int | None
    client_id: int | None
    assigned_to: int | None
    assigned_user_id: int | None
    created_by: int
    title: str
    description: str | None
    task_type: str
    status: str
    priority: str
    due_date: datetime | None
    reminder_at: datetime | None
    notes: str | None
    completed_at: datetime | None
    archived_at: datetime | None
    is_overdue: bool
    created_at: datetime
    updated_at: datetime
