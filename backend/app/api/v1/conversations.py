from datetime import datetime, timezone
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status, File, Form, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, role_guard
from app.db.session import get_db
from app.models.case import Case
from app.models.client import Client
from app.models.conversation import Conversation, ConversationParticipant, Message
from app.models.message_attachment import MessageAttachment
from app.models.message_case_reference import MessageCaseReference
from app.models.notification import Notification
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.conversation import (
    CaseReferenceResponse,
    CaseSearchResult,
    ConversationCreate,
    ConversationResponse,
    ConversationUpdate,
    MessageAttachmentResponse,
    MessageCreate,
    MessageResponse,
    MessageUpdate,
    ParticipantCreate,
    ParticipantResponse,
)
from app.services import message_attachments
from app.services.document_storage import persist_file, resolve_stored_file
from app.services.notifications import bulk_create_notifications
from app.services.timeline import create_case_timeline_event

router = APIRouter(prefix="/conversations", tags=["conversations"])
ALLOWED_STAFF = ["partner", "admin", "lawyer", "paralegal"]
VALID_TYPES = {"internal", "client", "group"}
VALID_PARTICIPANT_ROLES = {"member", "client", "owner"}


async def get_conversation_or_404(db: AsyncSession, org_id: int, conversation_id: int) -> Conversation:
    conv = await db.scalar(select(Conversation).where(Conversation.id == conversation_id, Conversation.organization_id == org_id))
    if not conv:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return conv


async def require_participant(db: AsyncSession, org_id: int, conversation_id: int, user_id: int) -> ConversationParticipant:
    part = await db.scalar(
        select(ConversationParticipant).where(
            ConversationParticipant.organization_id == org_id,
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == user_id,
        )
    )
    if not part:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a conversation participant")
    return part


def case_number(case: Case) -> str:
    return getattr(case, "display_number", None) or f"CASE{str(case.id).zfill(6)}"


async def accessible_case_for_user(db: AsyncSession, org_id: int, case_id: int, user: User) -> Case | None:
    case = await db.scalar(select(Case).where(Case.id == case_id, Case.organization_id == org_id))
    if not case:
        return None
    if user.role == UserRole.client:
        client = await db.scalar(select(Client).where(Client.organization_id == org_id, Client.user_id == user.id))
        if not client or client.id != case.client_id:
            return None
    return case


async def build_case_references(db: AsyncSession, org_id: int, message_id: int) -> list[CaseReferenceResponse]:
    refs = (
        await db.scalars(
            select(MessageCaseReference).where(
                MessageCaseReference.organization_id == org_id,
                MessageCaseReference.message_id == message_id,
            )
        )
    ).all()
    output: list[CaseReferenceResponse] = []
    for ref in refs:
        case = await db.scalar(select(Case).where(Case.id == ref.case_id, Case.organization_id == org_id))
        if case:
            output.append(CaseReferenceResponse(case_id=case.id, case_title=case.title, case_display_number=case_number(case)))
    return output


async def attachment_metadata(db: AsyncSession, org_id: int, message_ids: list[int]):
    rows = (await db.scalars(select(MessageAttachment).where(
        MessageAttachment.organization_id == org_id, MessageAttachment.message_id.in_(message_ids),
    ).order_by(MessageAttachment.id))).all()
    result = {}
    for row in rows:
        result.setdefault(row.message_id, []).append(MessageAttachmentResponse(
            id=row.id, file_name=row.file_name, file_type=row.file_type,
            file_size=row.file_size, created_at=row.created_at,
        ))
    return result


async def build_message_response(db: AsyncSession, message: Message, attachments=None) -> MessageResponse:
    sender = await db.scalar(select(User).where(User.id == message.sender_id, User.organization_id == message.organization_id))
    sender_role = None
    if sender and getattr(sender, "role", None) is not None:
        sender_role = sender.role.value if hasattr(sender.role, "value") else str(sender.role)
    return MessageResponse(
        id=message.id,
        conversation_id=message.conversation_id,
        sender_id=message.sender_id,
        parent_message_id=message.parent_message_id,
        body=message.body,
        sender_name=getattr(sender, "name", None) if sender else None,
        sender_role=sender_role,
        case_references=await build_case_references(db, message.organization_id, message.id),
        attachments=[] if message.deleted_at else (attachments if attachments is not None else (await attachment_metadata(db, message.organization_id, [message.id])).get(message.id, [])),
        created_at=message.created_at,
        updated_at=message.updated_at,
        deleted_at=message.deleted_at,
    )


async def conversation_summary(db: AsyncSession, conv: Conversation, current_user_id: int) -> ConversationResponse:
    participant_count = int(
        (await db.scalar(select(func.count(ConversationParticipant.id)).where(ConversationParticipant.conversation_id == conv.id, ConversationParticipant.organization_id == conv.organization_id)))
        or 0
    )
    participant = await db.scalar(
        select(ConversationParticipant).where(
            ConversationParticipant.organization_id == conv.organization_id,
            ConversationParticipant.conversation_id == conv.id,
            ConversationParticipant.user_id == current_user_id,
        )
    )
    last_read_at = participant.last_read_at if participant else None
    unread_filters = [
        Message.organization_id == conv.organization_id,
        Message.conversation_id == conv.id,
        Message.deleted_at.is_(None),
        Message.sender_id != current_user_id,
    ]
    if last_read_at is not None:
        unread_filters.append(Message.created_at > last_read_at)
    unread_count = int((await db.scalar(select(func.count(Message.id)).where(*unread_filters))) or 0)

    latest = await db.scalar(
        select(Message)
        .where(Message.organization_id == conv.organization_id, Message.conversation_id == conv.id, Message.deleted_at.is_(None))
        .order_by(Message.created_at.desc())
        .limit(1)
    )
    latest_message = None
    if latest:
        latest_message = await build_message_response(db, latest)
    linked_case = await db.scalar(select(Case).where(Case.id == conv.case_id, Case.organization_id == conv.organization_id)) if conv.case_id else None
    return ConversationResponse(
        id=conv.id,
        organization_id=conv.organization_id,
        case_id=conv.case_id,
        case_title=linked_case.title if linked_case else None,
        case_display_number=case_number(linked_case) if linked_case else None,
        conversation_type=conv.conversation_type,
        title=conv.title,
        created_by=conv.created_by,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        participant_count=participant_count,
        unread_count=unread_count,
        latest_message=latest_message,
    )


@router.post("", response_model=ConversationResponse)
async def create_conversation(
    payload: ConversationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    if payload.conversation_type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail="Invalid conversation type")

    linked_case = None
    if payload.case_id is not None:
        linked_case = await db.scalar(select(Case).where(Case.id == payload.case_id, Case.organization_id == current_user.organization_id))
        if not linked_case:
            raise HTTPException(status_code=400, detail="Case must belong to your organization")

    if payload.conversation_type == "client" and payload.case_id is None:
        raise HTTPException(status_code=400, detail="Client conversations must link to a case")

    participant_ids = set(payload.participant_ids)
    participant_ids.add(current_user.id)

    users = (await db.scalars(select(User).where(User.organization_id == current_user.organization_id, User.id.in_(participant_ids)))).all()
    if len(users) != len(participant_ids):
        raise HTTPException(status_code=400, detail="One or more participants are invalid")

    if payload.conversation_type == "client":
        if not any(u.role == UserRole.client for u in users):
            raise HTTPException(status_code=400, detail="Client conversation requires a client participant")
        client_user_ids = [u.id for u in users if u.role == UserRole.client]
        clients = (await db.scalars(select(Client).where(Client.organization_id == current_user.organization_id, Client.user_id.in_(client_user_ids)))).all()
        if len(clients) != len(client_user_ids):
            raise HTTPException(status_code=400, detail="Client participant must be linked to a client profile")
        if linked_case and any(c.id != linked_case.client_id for c in clients):
            raise HTTPException(status_code=400, detail="Client participant does not match linked case client")

    now = datetime.now(timezone.utc)
    conv = Conversation(
        organization_id=current_user.organization_id,
        case_id=payload.case_id,
        conversation_type=payload.conversation_type,
        title=payload.title,
        created_by=current_user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(conv)
    await db.flush()

    for uid in participant_ids:
        role = "owner" if uid == current_user.id else "member"
        user = next((u for u in users if u.id == uid), None)
        if user and user.role == UserRole.client:
            role = "client"
        db.add(
            ConversationParticipant(
                organization_id=current_user.organization_id,
                conversation_id=conv.id,
                user_id=uid,
                role=role,
                created_at=now,
            )
        )

    if linked_case:
        event_type = "client_conversation_started" if payload.conversation_type == "client" else "internal_conversation_started"
        await create_case_timeline_event(
            db,
            organization_id=current_user.organization_id,
            case_id=linked_case.id,
            actor_id=current_user.id,
            event_type=event_type,
            title=f"Conversation started: {payload.title or payload.conversation_type}",
            metadata_json={"conversation_id": conv.id, "conversation_type": payload.conversation_type},
        )

    await db.commit()
    return await conversation_summary(db, conv, current_user.id)


@router.get("", response_model=list[ConversationResponse])
async def list_conversations(db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    conv_ids = (
        await db.scalars(
            select(ConversationParticipant.conversation_id).where(
                ConversationParticipant.organization_id == current_user.organization_id,
                ConversationParticipant.user_id == current_user.id,
            )
        )
    ).all()
    if not conv_ids:
        return []
    rows = (
        await db.scalars(
            select(Conversation)
            .where(Conversation.organization_id == current_user.organization_id, Conversation.id.in_(conv_ids))
            .order_by(Conversation.updated_at.desc())
        )
    ).all()
    return [await conversation_summary(db, c, current_user.id) for c in rows]


@router.get("/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(conversation_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    await require_participant(db, current_user.organization_id, conversation_id, current_user.id)
    conv = await get_conversation_or_404(db, current_user.organization_id, conversation_id)
    return await conversation_summary(db, conv, current_user.id)


@router.patch("/{conversation_id}", response_model=ConversationResponse)
async def update_conversation(conversation_id: int, payload: ConversationUpdate, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    await require_participant(db, current_user.organization_id, conversation_id, current_user.id)
    conv = await get_conversation_or_404(db, current_user.organization_id, conversation_id)
    fields_set = payload.model_fields_set
    if "title" in fields_set and payload.title is not None:
        conv.title = payload.title
    if "case_id" in fields_set:
        if payload.case_id is None:
            conv.case_id = None
        else:
            linked_case = await accessible_case_for_user(db, current_user.organization_id, payload.case_id, current_user)
            if not linked_case:
                raise HTTPException(status_code=400, detail="Case must belong to your organization")
            if conv.conversation_type == "client":
                client_parts = (
                    await db.scalars(
                        select(ConversationParticipant).where(
                            ConversationParticipant.organization_id == current_user.organization_id,
                            ConversationParticipant.conversation_id == conv.id,
                            ConversationParticipant.role == "client",
                        )
                    )
                ).all()
                if client_parts:
                    client_users = [p.user_id for p in client_parts]
                    clients = (await db.scalars(select(Client).where(Client.organization_id == current_user.organization_id, Client.user_id.in_(client_users)))).all()
                    if any(c.id != linked_case.client_id for c in clients):
                        raise HTTPException(status_code=400, detail="Client participant does not match linked case client")
            conv.case_id = payload.case_id
    conv.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return await conversation_summary(db, conv, current_user.id)


@router.delete("/{conversation_id}")
async def delete_conversation(conversation_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    await require_participant(db, current_user.organization_id, conversation_id, current_user.id)
    conv = await get_conversation_or_404(db, current_user.organization_id, conversation_id)
    await db.delete(conv)
    await db.commit()
    return {"ok": True}


@router.post("/{conversation_id}/participants", response_model=ParticipantResponse)
async def add_participant(conversation_id: int, payload: ParticipantCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    if payload.role not in VALID_PARTICIPANT_ROLES:
        raise HTTPException(status_code=400, detail="Invalid participant role")
    conv = await get_conversation_or_404(db, current_user.organization_id, conversation_id)
    await require_participant(db, current_user.organization_id, conversation_id, current_user.id)
    user = await db.scalar(select(User).where(User.id == payload.user_id, User.organization_id == current_user.organization_id))
    if not user:
        raise HTTPException(status_code=400, detail="User must belong to your organization")
    existing = await db.scalar(
        select(ConversationParticipant).where(
            ConversationParticipant.organization_id == current_user.organization_id,
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == payload.user_id,
        )
    )
    if existing:
        return ParticipantResponse(user_id=existing.user_id, role=existing.role, last_read_at=existing.last_read_at, created_at=existing.created_at)
    now = datetime.now(timezone.utc)
    part = ConversationParticipant(
        organization_id=current_user.organization_id,
        conversation_id=conversation_id,
        user_id=payload.user_id,
        role=payload.role,
        created_at=now,
    )
    if conv.conversation_type == "client" and user.role != UserRole.client and payload.role == "client":
        raise HTTPException(status_code=400, detail="Client role participant must be a client user")
    db.add(part)
    conv.updated_at = now
    await db.commit()
    return ParticipantResponse(user_id=part.user_id, role=part.role, last_read_at=part.last_read_at, created_at=part.created_at)


@router.get("/{conversation_id}/participants", response_model=list[ParticipantResponse])
async def list_participants(conversation_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    await require_participant(db, current_user.organization_id, conversation_id, current_user.id)
    parts = (
        await db.scalars(
            select(ConversationParticipant)
            .where(ConversationParticipant.organization_id == current_user.organization_id, ConversationParticipant.conversation_id == conversation_id)
            .order_by(ConversationParticipant.created_at.asc())
        )
    ).all()
    return [ParticipantResponse(user_id=p.user_id, role=p.role, last_read_at=p.last_read_at, created_at=p.created_at) for p in parts]


@router.delete("/{conversation_id}/participants/{user_id}")
async def remove_participant(conversation_id: int, user_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    await require_participant(db, current_user.organization_id, conversation_id, current_user.id)
    part = await db.scalar(
        select(ConversationParticipant).where(
            ConversationParticipant.organization_id == current_user.organization_id,
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == user_id,
        )
    )
    if not part:
        raise HTTPException(status_code=404, detail="Participant not found")
    await db.delete(part)
    conv = await get_conversation_or_404(db, current_user.organization_id, conversation_id)
    conv.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True}


async def create_message_core(conversation_id: int, payload: MessageCreate, db: AsyncSession, current_user: User, *, has_attachments=False):
    await require_participant(db, current_user.organization_id, conversation_id, current_user.id)
    if payload.parent_message_id is not None:
        parent = await db.scalar(
            select(Message).where(
                Message.id == payload.parent_message_id,
                Message.organization_id == current_user.organization_id,
                Message.conversation_id == conversation_id,
            )
        )
        if not parent:
            raise HTTPException(status_code=400, detail="Parent message not found")

    if not payload.body.strip() and not has_attachments:
        raise HTTPException(400, "Message text or an attachment is required")
    now = datetime.now(timezone.utc)
    msg = Message(
        organization_id=current_user.organization_id,
        conversation_id=conversation_id,
        sender_id=current_user.id,
        parent_message_id=payload.parent_message_id,
        body=payload.body,
        created_at=now,
        updated_at=now,
        deleted_at=None,
    )
    db.add(msg)
    await db.flush()
    if payload.case_reference_ids:
        unique_ids = list({int(cid) for cid in payload.case_reference_ids})
        for case_id in unique_ids:
            linked_case = await accessible_case_for_user(db, current_user.organization_id, case_id, current_user)
            if not linked_case:
                raise HTTPException(status_code=400, detail="One or more case references are invalid")
            db.add(
                MessageCaseReference(
                    organization_id=current_user.organization_id,
                    message_id=msg.id,
                    case_id=linked_case.id,
                    created_at=now,
                )
            )
    conv = await get_conversation_or_404(db, current_user.organization_id, conversation_id)
    conv.updated_at = now
    participant_ids = (
        await db.scalars(
            select(ConversationParticipant.user_id).join(User, User.id == ConversationParticipant.user_id).where(
                User.organization_id == current_user.organization_id,
                ConversationParticipant.organization_id == current_user.organization_id,
                ConversationParticipant.conversation_id == conversation_id,
                ConversationParticipant.user_id != current_user.id,
            )
        )
    ).all()
    await bulk_create_notifications(
        db,
        organization_id=current_user.organization_id,
        user_ids=list(participant_ids),
        type="message_received",
        title=f"New message in {conv.title or 'conversation'}"[:255],
        body=current_user.name,
        metadata_json={"conversation_id": conversation_id, "message_id": msg.id, "conversation_title": conv.title},
    )
    return msg


@router.post("/{conversation_id}/messages", response_model=MessageResponse)
async def create_message(conversation_id: int, payload: MessageCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    msg = await create_message_core(conversation_id, payload, db, current_user)
    await db.commit()
    await db.refresh(msg)
    return await build_message_response(db, msg, attachments=[])


@router.post("/{conversation_id}/messages-with-attachments", response_model=MessageResponse)
async def create_message_with_attachments(
    conversation_id: int,
    body: str = Form(default=""),
    parent_message_id: int | None = Form(default=None),
    case_reference_ids: list[int] = Form(default=[]),
    files: list[UploadFile] = File(default=[]),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    await get_conversation_or_404(db, current_user.organization_id, conversation_id)
    await require_participant(db, current_user.organization_id, conversation_id, current_user.id)
    if len(files) > message_attachments.MAX_MESSAGE_ATTACHMENTS:
        raise HTTPException(400, "Maximum 5 attachments per message")
    validated = [await message_attachments.validate_attachment(file) for file in files]
    created_paths = []
    try:
        msg = await create_message_core(conversation_id, MessageCreate(
            body=body, parent_message_id=parent_message_id, case_reference_ids=case_reference_ids,
        ), db, current_user, has_attachments=bool(validated))
        for name, media_type, data in validated:
            path, _ = persist_file(message_attachments.STORAGE_ROOT, current_user.organization_id, name, data)
            created_paths.append(path)
            db.add(MessageAttachment(
                organization_id=current_user.organization_id, message_id=msg.id, uploaded_by=current_user.id,
                file_name=name, file_path=path, file_type=media_type, file_size=len(data), created_at=msg.created_at,
            ))
        await db.flush()
        response = await build_message_response(db, msg)
        await db.commit()
    except Exception:
        try:
            await db.rollback()
        finally:
            for path in created_paths:
                try:
                    Path(path).unlink(missing_ok=True)
                except OSError:
                    logging.getLogger(__name__).warning("Could not remove a failed message upload")
        raise
    return response


async def attachment_file(attachment_id: int, db: AsyncSession, current_user: User, *, inline: bool):
    row = await db.scalar(select(MessageAttachment).join(Message, Message.id == MessageAttachment.message_id).where(
        MessageAttachment.id == attachment_id, MessageAttachment.organization_id == current_user.organization_id,
        Message.organization_id == current_user.organization_id, Message.deleted_at.is_(None),
    ))
    if not row:
        raise HTTPException(404, "Attachment not found")
    msg = await db.scalar(select(Message).where(Message.id == row.message_id, Message.organization_id == current_user.organization_id))
    await get_conversation_or_404(db, current_user.organization_id, msg.conversation_id)
    await require_participant(db, current_user.organization_id, msg.conversation_id, current_user.id)
    path = resolve_stored_file(row.file_path, message_attachments.STORAGE_ROOT)
    can_preview = row.file_type in {"application/pdf", "image/jpeg", "image/png"}
    return FileResponse(path, media_type=row.file_type, filename=row.file_name,
        content_disposition_type="inline" if inline and can_preview else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


@router.get("/attachments/{attachment_id}/view")
async def view_attachment(attachment_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    return await attachment_file(attachment_id, db, current_user, inline=True)


@router.get("/attachments/{attachment_id}/download")
async def download_attachment(attachment_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    return await attachment_file(attachment_id, db, current_user, inline=False)


@router.get("/{conversation_id}/messages", response_model=list[MessageResponse])
async def list_messages(conversation_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    await require_participant(db, current_user.organization_id, conversation_id, current_user.id)
    rows = (
        await db.scalars(
            select(Message)
            .where(
                Message.organization_id == current_user.organization_id,
                Message.conversation_id == conversation_id,
                Message.deleted_at.is_(None),
            )
            .order_by(Message.created_at.asc())
        )
    ).all()
    attachments = await attachment_metadata(db, current_user.organization_id, [m.id for m in rows]) if rows else {}
    return [await build_message_response(db, m, attachments=attachments.get(m.id, [])) for m in rows]


@router.patch("/messages/{message_id}", response_model=MessageResponse)
async def update_message(message_id: int, payload: MessageUpdate, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    msg = await db.scalar(select(Message).where(Message.id == message_id, Message.organization_id == current_user.organization_id, Message.deleted_at.is_(None)))
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    await require_participant(db, current_user.organization_id, msg.conversation_id, current_user.id)
    if msg.sender_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only sender can edit message")
    msg.body = payload.body
    msg.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return await build_message_response(db, msg)


@router.delete("/messages/{message_id}")
async def delete_message(message_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    msg = await db.scalar(select(Message).where(Message.id == message_id, Message.organization_id == current_user.organization_id, Message.deleted_at.is_(None)))
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    await require_participant(db, current_user.organization_id, msg.conversation_id, current_user.id)
    if msg.sender_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only sender can delete message")
    msg.deleted_at = datetime.now(timezone.utc)
    msg.updated_at = msg.deleted_at
    await db.commit()
    return {"ok": True}


@router.post("/{conversation_id}/mark-read")
async def mark_conversation_read(conversation_id: int, read_through: datetime | None = Query(default=None), db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
    part = await require_participant(db, current_user.organization_id, conversation_id, current_user.id)
    now = datetime.now(timezone.utc)
    # Optional fetch boundary avoids acknowledging messages arriving after a thread load.
    cutoff = read_through or now
    if cutoff.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=timezone.utc)
    cutoff = min(cutoff, now)
    previous = part.last_read_at
    if previous and previous.tzinfo is None:
        previous = previous.replace(tzinfo=timezone.utc)
    part.last_read_at = max(previous, cutoff) if previous else cutoff
    read_message_ids = set((await db.scalars(select(Message.id).where(
        Message.organization_id == current_user.organization_id,
        Message.conversation_id == conversation_id,
        Message.created_at <= cutoff,
    ))).all())
    unread_message_notifications = (await db.scalars(select(Notification).where(
        Notification.organization_id == current_user.organization_id,
        Notification.user_id == current_user.id,
        Notification.type == "message_received",
        Notification.is_read.is_(False),
    ))).all()
    for notification in unread_message_notifications:
        metadata = notification.metadata_json or {}
        if metadata.get("conversation_id") == conversation_id and metadata.get("message_id") in read_message_ids:
            notification.is_read = True
    await db.commit()
    return {"ok": True}


@router.get("/cases/search", response_model=list[CaseSearchResult])
async def case_search(
    q: str = Query(default=""),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    rows = (
        await db.scalars(
            select(Case).where(Case.organization_id == current_user.organization_id).order_by(Case.updated_at.desc())
        )
    ).all()
    client_ids = {row.client_id for row in rows if row.client_id is not None}
    clients = (await db.scalars(select(Client).where(
        Client.organization_id == current_user.organization_id,
        Client.id.in_(client_ids),
    ))).all() if client_ids else []
    client_names = {client.id: client.name for client in clients}
    text = q.strip().lower()
    if text:
        rows = [row for row in rows if text in f"{row.title or ''} {case_number(row)} {client_names.get(row.client_id, '')}".lower()]
    return [CaseSearchResult(
        id=row.id,
        title=row.title or "Untitled Case",
        display_number=case_number(row),
        client_name=client_names.get(row.client_id),
    ) for row in rows[:30]]
