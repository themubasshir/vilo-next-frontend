from datetime import date, datetime
from pydantic import BaseModel, Field, model_validator

from app.models.case import CasePriority, CaseStatus
from app.schemas.case_practice_area import CasePracticeArea


class CaseAssignmentRequest(BaseModel):
    user_ids: list[int]


class AssignedUser(BaseModel):
    id: int
    name: str
    email: str
    role: str
    status: str


class CaseCreate(BaseModel):
    practice_area: CasePracticeArea
    title: str | None = None
    description: str | None = None
    client_id: int | None = None
    status: CaseStatus = CaseStatus.draft
    priority: CasePriority = CasePriority.medium
    expected_completion_date: date | None = None
    assigned_user_ids: list[int] = Field(default_factory=list)

    @model_validator(mode="after")
    def require_active_fields(self):
        if self.status != CaseStatus.draft:
            if not (self.title or "").strip():
                raise ValueError("Title is required to complete a case")
            if self.client_id is None:
                raise ValueError("Client is required to complete a case")
        return self


class CaseUpdate(BaseModel):
    practice_area: CasePracticeArea | None = None
    title: str | None = None
    description: str | None = None
    client_id: int | None = None
    status: CaseStatus | None = None
    priority: CasePriority | None = None
    expected_completion_date: date | None = None
    assigned_user_ids: list[int] | None = None


class CaseResponse(BaseModel):
    practice_area: str | None = None
    id: int
    organization_id: int
    title: str | None
    description: str | None
    client_id: int | None
    status: str
    priority: str
    expected_completion_date: date | None
    created_by: int
    assigned_users: list[AssignedUser]
    created_at: datetime
    updated_at: datetime
    client_name: str | None = None
    case_number: str | None = None


class CaseStatusCount(BaseModel):
    status: str
    count: int


class CaseListResponse(BaseModel):
    items: list[CaseResponse] = Field(default_factory=list)
    total: int
    page: int
    per_page: int
    total_pages: int
    counts: list[CaseStatusCount] = Field(default_factory=list)
