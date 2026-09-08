from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, role_guard
from app.db.session import get_db
from app.models.case import Case
from app.models.client import Client
from app.models.conversation import Conversation, ConversationParticipant, Message
from app.models.message_case_reference import MessageCaseReference
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.conversation import (
    CaseReferenceResponse,
    CaseSearchResult,
    ConversationCreate,
    ConversationResponse,
    ConversationUpdate,
    MessageCreate,
    MessageResponse,
    MessageUpdate,
    ParticipantCreate,
    ParticipantResponse,
)
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


async def build_message_response(db: AsyncSession, message: Message) -> MessageResponse:
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
    if payload.title is not None:
        conv.title = payload.title
    if payload.case_id is not None:
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


@router.post("/{conversation_id}/messages", response_model=MessageResponse)
async def create_message(conversation_id: int, payload: MessageCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(role_guard(ALLOWED_STAFF))):
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
    await db.commit()
    await db.refresh(msg)
    return await build_message_response(db, msg)


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
    return [await build_message_response(db, m) for m in rows]


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
    text = q.strip().lower()
    if text:
        rows = [row for row in rows if text in f"{row.title} {case_number(row)}".lower()]
    return [CaseSearchResult(id=row.id, title=row.title, display_number=case_number(row)) for row in rows[:30]]
