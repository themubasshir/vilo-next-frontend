from datetime import datetime
from pydantic import BaseModel, Field


class ParticipantCreate(BaseModel):
    user_id: int
    role: str = "member"


class ParticipantResponse(BaseModel):
    user_id: int
    role: str
    last_read_at: datetime | None
    created_at: datetime


class CaseReferenceResponse(BaseModel):
    case_id: int
    case_title: str
    case_display_number: str | None = None


class CaseSearchResult(BaseModel):
    id: int
    title: str
    display_number: str | None = None


class MessageCreate(BaseModel):
    body: str
    parent_message_id: int | None = None
    case_reference_ids: list[int] = Field(default_factory=list)


class MessageUpdate(BaseModel):
    body: str


class MessageAttachmentResponse(BaseModel):
    id: int
    file_name: str
    file_type: str
    file_size: int
    created_at: datetime


class MessageResponse(BaseModel):
    id: int
    conversation_id: int
    sender_id: int
    parent_message_id: int | None
    body: str
    attachments: list[MessageAttachmentResponse] = Field(default_factory=list)
    sender_name: str | None = None
    sender_role: str | None = None
    case_references: list["CaseReferenceResponse"] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


class ConversationCreate(BaseModel):
    case_id: int | None = None
    conversation_type: str
    title: str | None = None
    participant_ids: list[int] = Field(default_factory=list)


class ConversationUpdate(BaseModel):
    title: str | None = None
    case_id: int | None = None


class ConversationResponse(BaseModel):
    id: int
    organization_id: int
    case_id: int | None
    case_title: str | None = None
    case_display_number: str | None = None
    conversation_type: str
    title: str | None
    created_by: int
    created_at: datetime
    updated_at: datetime
    participant_count: int
    unread_count: int
    latest_message: MessageResponse | None = None
