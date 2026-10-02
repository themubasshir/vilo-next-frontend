from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.case import Case
from app.models.client import Client
from app.models.conversation import Conversation, ConversationParticipant, Message
from app.models.message_receipt import MessageReceipt
from app.services.message_receipts import receipt_summary, record_first_read
from app.models.message_case_reference import MessageCaseReference
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.conversation import CaseReferenceResponse, CaseSearchResult, ConversationResponse, MessageCreate, MessageResponse
from app.services.notifications import bulk_create_notifications

router = APIRouter(prefix="/portal/messages", tags=["portal-messages"])


async def get_portal_client(db: AsyncSession, current_user: User) -> Client:
    if current_user.role != UserRole.client:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client portal only")
    client = await db.scalar(
        select(Client).where(
            Client.organization_id == current_user.organization_id,
            Client.user_id == current_user.id,
        )
    )
    if not client:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client profile not linked")
    return client


async def get_allowed_conversation(db: AsyncSession, client: Client, conversation_id: int) -> Conversation:
    conv = await db.scalar(
        select(Conversation).where(
            Conversation.id == conversation_id,
            Conversation.organization_id == client.organization_id,
            Conversation.conversation_type == "client",
        )
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    part = await db.scalar(
        select(ConversationParticipant).where(
            ConversationParticipant.organization_id == client.organization_id,
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == client.user_id,
        )
    )
    if not part:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.case_id is not None:
        case = await db.scalar(select(Case).where(Case.id == conv.case_id, Case.organization_id == client.organization_id, Case.client_id == client.id))
        if not case:
            raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


def case_number(case: Case) -> str:
    return getattr(case, "display_number", None) or f"CASE{str(case.id).zfill(6)}"


async def build_case_references(db: AsyncSession, org_id: int, message_id: int, client_id: int) -> list[CaseReferenceResponse]:
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
        case = await db.scalar(select(Case).where(Case.id == ref.case_id, Case.organization_id == org_id, Case.client_id == client_id))
        if case:
            output.append(CaseReferenceResponse(case_id=case.id, case_title=case.title, case_display_number=case_number(case)))
    return output


async def build_message_response(db: AsyncSession, message: Message, client_id: int) -> MessageResponse:
    sender = await db.scalar(select(User).where(User.id == message.sender_id, User.organization_id == message.organization_id))
    return MessageResponse(
        **await receipt_summary(db, message),
        id=message.id,
        conversation_id=message.conversation_id,
        sender_id=message.sender_id,
        parent_message_id=message.parent_message_id,
        body=message.body,
        sender_name=sender.name if sender else None,
        sender_role=sender.role.value if sender else None,
        case_references=await build_case_references(db, message.organization_id, message.id, client_id),
        created_at=message.created_at,
        updated_at=message.updated_at,
        deleted_at=message.deleted_at,
    )


async def conversation_summary(db: AsyncSession, conv: Conversation, current_user_id: int) -> ConversationResponse:
    portal_client = await db.scalar(select(Client).where(Client.organization_id == conv.organization_id, Client.user_id == current_user_id))
    participant_count = len(
        (
            await db.scalars(
                select(ConversationParticipant).where(
                    ConversationParticipant.organization_id == conv.organization_id,
                    ConversationParticipant.conversation_id == conv.id,
                )
            )
        ).all()
    )
    participant = await db.scalar(
        select(ConversationParticipant).where(
            ConversationParticipant.organization_id == conv.organization_id,
            ConversationParticipant.conversation_id == conv.id,
            ConversationParticipant.user_id == current_user_id,
        )
    )
    last_read_at = participant.last_read_at if participant else None
    msg_rows = (
        await db.scalars(
            select(Message)
            .where(Message.organization_id == conv.organization_id, Message.conversation_id == conv.id, Message.deleted_at.is_(None))
            .order_by(Message.created_at.desc())
        )
    ).all()
    latest = msg_rows[0] if msg_rows else None
    unread = 0
    for m in msg_rows:
        if m.sender_id == current_user_id:
            continue
        if last_read_at is None or m.created_at > last_read_at:
            unread += 1
    latest_message = None
    if latest:
        latest_message = await build_message_response(db, latest, portal_client.id if portal_client else 0)
    linked_case = await db.scalar(select(Case).where(Case.id == conv.case_id, Case.organization_id == conv.organization_id, Case.client_id == portal_client.id)) if conv.case_id and portal_client else None
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
        unread_count=unread,
        latest_message=latest_message,
    )


@router.get("/conversations", response_model=list[ConversationResponse])
async def list_portal_conversations(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    client = await get_portal_client(db, current_user)
    part_rows = (
        await db.scalars(
            select(ConversationParticipant).where(
                ConversationParticipant.organization_id == client.organization_id,
                ConversationParticipant.user_id == client.user_id,
            )
        )
    ).all()
    convs = []
    for p in part_rows:
        conv = await db.scalar(
            select(Conversation).where(
                Conversation.id == p.conversation_id,
                Conversation.organization_id == client.organization_id,
                Conversation.conversation_type == "client",
            )
        )
        if not conv:
            continue
        if conv.case_id is not None:
            case = await db.scalar(select(Case).where(Case.id == conv.case_id, Case.organization_id == client.organization_id, Case.client_id == client.id))
            if not case:
                continue
        convs.append(conv)
    return [await conversation_summary(db, c, current_user.id) for c in convs]


@router.get("/conversations/{conversation_id}", response_model=ConversationResponse)
async def get_portal_conversation(conversation_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    client = await get_portal_client(db, current_user)
    conv = await get_allowed_conversation(db, client, conversation_id)
    return await conversation_summary(db, conv, current_user.id)


@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageResponse])
async def list_portal_messages(conversation_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    client = await get_portal_client(db, current_user)
    await get_allowed_conversation(db, client, conversation_id)
    rows = (
        await db.scalars(
            select(Message)
            .where(Message.organization_id == client.organization_id, Message.conversation_id == conversation_id, Message.deleted_at.is_(None))
            .order_by(Message.created_at.asc())
        )
    ).all()
    return [await build_message_response(db, m, client.id) for m in rows]


@router.post("/conversations/{conversation_id}/messages", response_model=MessageResponse)
async def create_portal_message(conversation_id: int, payload: MessageCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    client = await get_portal_client(db, current_user)
    conv = await get_allowed_conversation(db, client, conversation_id)
    if payload.parent_message_id is not None:
        parent = await db.scalar(select(Message).where(Message.id == payload.parent_message_id, Message.organization_id == client.organization_id, Message.conversation_id == conversation_id))
        if not parent:
            raise HTTPException(status_code=400, detail="Parent message not found")
    now = datetime.now(timezone.utc)
    msg = Message(
        organization_id=client.organization_id,
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
            linked_case = await db.scalar(
                select(Case).where(Case.id == case_id, Case.organization_id == client.organization_id, Case.client_id == client.id)
            )
            if not linked_case:
                raise HTTPException(status_code=400, detail="One or more case references are invalid")
            db.add(
                MessageCaseReference(
                    organization_id=client.organization_id,
                    message_id=msg.id,
                    case_id=linked_case.id,
                    created_at=now,
                )
            )
    conv.updated_at = now
    participant_ids = (
        await db.scalars(
            select(ConversationParticipant.user_id).join(User, User.id == ConversationParticipant.user_id).where(
                User.organization_id == client.organization_id,
                ConversationParticipant.organization_id == client.organization_id,
                ConversationParticipant.conversation_id == conversation_id,
                ConversationParticipant.user_id != current_user.id,
            )
        )
    ).all()
    db.add_all([MessageReceipt(message_id=msg.id, user_id=uid, delivered_at=now, created_at=now)
                for uid in set(participant_ids)])
    await db.flush()
    await bulk_create_notifications(
        db,
        organization_id=client.organization_id,
        user_ids=list(participant_ids),
        type="message_received",
        title=f"New message in {conv.title or 'conversation'}",
        body=current_user.name,
        metadata_json={"conversation_id": conversation_id, "message_id": msg.id},
    )
    await db.commit()
    await db.refresh(msg)
    return await build_message_response(db, msg, client.id)


@router.post("/conversations/{conversation_id}/mark-read")
async def mark_portal_conversation_read(conversation_id: int, read_through: datetime | None = Query(default=None), db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    client = await get_portal_client(db, current_user)
    await get_allowed_conversation(db, client, conversation_id)
    part = await db.scalar(
        select(ConversationParticipant).where(
            ConversationParticipant.organization_id == client.organization_id,
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == current_user.id,
        )
    )
    now = datetime.now(timezone.utc)
    cutoff = read_through or now
    if cutoff.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=timezone.utc)
    cutoff = min(cutoff, now)
    previous = part.last_read_at
    if previous and previous.tzinfo is None:
        previous = previous.replace(tzinfo=timezone.utc)
    part.last_read_at = max(previous, cutoff) if previous else cutoff
    await record_first_read(db, organization_id=client.organization_id, conversation_id=conversation_id,
                            user_id=current_user.id, cutoff=cutoff, now=now)
    await db.commit()
    return {"ok": True}


@router.get("/case-search", response_model=list[CaseSearchResult])
async def portal_case_search(
    q: str = Query(default=""),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    client = await get_portal_client(db, current_user)
    rows = (
        await db.scalars(
            select(Case)
            .where(Case.organization_id == client.organization_id, Case.client_id == client.id)
            .order_by(Case.updated_at.desc())
        )
    ).all()
    text = q.strip().lower()
    if text:
        rows = [row for row in rows if text in f"{row.title} {case_number(row)}".lower()]
    return [CaseSearchResult(id=row.id, title=row.title, display_number=case_number(row)) for row in rows[:30]]
