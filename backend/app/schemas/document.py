from datetime import datetime
from typing import Any
from pydantic import BaseModel, Field


class DocumentResponse(BaseModel):
    id: int
    organization_id: int
    case_id: int | None
    client_id: int | None
    uploaded_by: int
    title: str
    description: str | None
    file_name: str
    file_type: str | None
    file_size: int | None
    category: str | None
    client_id_type: str | None = None
    visibility: str
    version: int
    version_source: str | None = None
    version_note: str | None = None
    created_at: datetime
    updated_at: datetime
    case_title: str | None = None
    client_name: str | None = None
    uploader_name: str | None = None


class DocumentListResponse(BaseModel):
    items: list[DocumentResponse] = Field(default_factory=list)
    total: int
    page: int
    per_page: int
    total_pages: int


class DocumentUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    category: str | None = None
    visibility: str | None = None


class DocumentVersionResponse(BaseModel):
    id: int
    document_id: int
    organization_id: int
    file_name: str
    file_type: str | None
    file_size: int | None
    version_number: int
    uploaded_by: int
    source: str | None = None
    notes: str | None
    version_note: str | None = None
    created_at: datetime


class DocumentEditableContentResponse(BaseModel):
    document_id: int
    file_type: str | None
    editable: bool
    mode: str | None = None
    content: str = ""
    warning: str | None = None
    reason: str | None = None


class DocumentEditableContentUpdate(BaseModel):
    content: str
    version_note: str | None = None


class OnlyOfficeSessionResponse(BaseModel):
    document_id: int
    version: int
    document_server_url: str
    editor_config: dict[str, Any]
    warning: str | None = None
    notes: list[str] = Field(default_factory=list)
