from datetime import date, datetime

from pydantic import BaseModel, Field

from app.schemas.document import DocumentResponse


class PrecedentCreate(BaseModel):
    name: str
    description: str | None = None
    practice_area: str
    document_type: str
    tags: list[str] = Field(default_factory=list)
    content_text: str | None = None


class PrecedentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    practice_area: str | None = None
    document_type: str | None = None
    tags: list[str] | None = None
    content_text: str | None = None


class PrecedentSummaryResponse(BaseModel):
    id: int
    name: str
    description: str | None
    practice_area: str
    document_type: str
    tags: list[str]
    has_file: bool
    file_name: str | None
    file_type: str | None
    file_size: int | None
    created_by_id: int
    created_by_name: str | None = None
    updated_by_id: int | None
    updated_by_name: str | None = None
    is_archived: bool
    created_at: datetime
    updated_at: datetime


class PrecedentResponse(PrecedentSummaryResponse):
    content_text: str | None = None


class PrecedentListResponse(BaseModel):
    items: list[PrecedentSummaryResponse]
    total: int
    limit: int
    offset: int


class PrecedentCopyToCaseRequest(BaseModel):
    # Legacy content_text extras are ignored: editing happens on the copy.
    case_id: int
    name: str | None = None


class PrecedentCopyToCaseResponse(BaseModel):
    precedent_id: int
    case_id: int
    document: DocumentResponse


class PrecedentListFilters(BaseModel):
    q: str | None = None
    practice_area: str | None = None
    document_type: str | None = None
    tag: str | None = None
    created_by_id: int | None = None
    date_from: date | None = None
    date_to: date | None = None
    include_archived: bool = False
    sort: str = "updated_at"
    limit: int = 50
    offset: int = 0


class PracticeAreaCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class PracticeAreaResponse(BaseModel):
    id: int
    name: str
