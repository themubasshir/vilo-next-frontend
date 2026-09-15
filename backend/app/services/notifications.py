from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.case import Case, CaseAssignment
from app.models.document import Document
from app.models.enums import RecordStatus, UserRole
from app.models.user import User

from app.models.notification import Notification


async def create_notification(
    db: AsyncSession,
    *,
    organization_id: int,
    user_id: int,
    type: str,
    title: str,
    body: str | None = None,
    metadata_json: dict | None = None,
    dedupe_key: str | None = None,
    popup_dismissed_at: datetime | None = None,
    email_status: str | None = None,
) -> Notification:
    notification = Notification(
        organization_id=organization_id,
        user_id=user_id,
        type=type,
        title=title,
        body=body,
        is_read=False,
        dedupe_key=dedupe_key,
        metadata_json=metadata_json,
        popup_dismissed_at=popup_dismissed_at,
        email_status=email_status,
        email_attempts=0,
        created_at=datetime.now(timezone.utc),
    )
    db.add(notification)
    await db.flush()
    return notification


async def bulk_create_notifications(
    db: AsyncSession,
    *,
    organization_id: int,
    user_ids: list[int],
    type: str,
    title: str,
    body: str | None = None,
    metadata_json: dict | None = None,
    dedupe_key_prefix: str | None = None,
) -> list[Notification]:
    now = datetime.now(timezone.utc)
    notifications: list[Notification] = []
    for user_id in sorted(set(user_ids)):
        notification = Notification(
            organization_id=organization_id,
            user_id=user_id,
            type=type,
            title=title,
            body=body,
            is_read=False,
            dedupe_key=f"{dedupe_key_prefix}:user:{user_id}" if dedupe_key_prefix else None,
            metadata_json=metadata_json,
            created_at=now,
        )
        db.add(notification)
        notifications.append(notification)
    await db.flush()
    return notifications


async def notify_case_assigned(
    db: AsyncSession,
    *,
    case: Case,
    actor: User,
    newly_assigned_user_ids: list[int] | set[int],
) -> None:
    """Notify same-firm staff who were newly assigned to a File."""
    recipient_ids = sorted(set(newly_assigned_user_ids) - {actor.id})
    if not recipient_ids:
        return
    valid_ids = (await db.scalars(
        select(User.id).where(
            User.id.in_(recipient_ids),
            User.organization_id == case.organization_id,
            User.role != UserRole.client,
        )
    )).all()
    await bulk_create_notifications(
        db,
        organization_id=case.organization_id,
        user_ids=list(valid_ids),
        type="case_assigned",
        title="Assigned to File",
        body=f"{actor.name} assigned you to the case: {case.title or 'Untitled draft'}.",
        metadata_json={
            "case_id": case.id,
            "actor_user_id": actor.id,
            "link": f"/dashboard/cases/{case.id}",
        },
    )


async def notify_case_document_added(db: AsyncSession, *, document: Document, actor_id: int) -> None:
    """Notify active, directly assigned same-firm staff of a new File document."""
    if document.case_id is None:
        return
    case = await db.scalar(select(Case).where(
        Case.id == document.case_id, Case.organization_id == document.organization_id,
    ))
    if case is None:
        return
    recipients = (await db.scalars(
        select(User.id).join(CaseAssignment, CaseAssignment.user_id == User.id).where(
            CaseAssignment.case_id == case.id,
            User.organization_id == document.organization_id,
            User.role != UserRole.client,
            User.status == RecordStatus.active,
            User.id != actor_id,
        ).distinct()
    )).all()
    for user_id in recipients:
        key = f"document_uploaded:{document.id}:user:{user_id}"
        existing = await db.scalar(select(Notification.id).where(
            Notification.organization_id == document.organization_id,
            Notification.user_id == user_id, Notification.dedupe_key == key,
        ))
        if existing is None:
            await create_notification(
                db, organization_id=document.organization_id, user_id=user_id,
                type="document_uploaded", title="New File Document",
                body=f"{document.title} was added to {case.title or 'Untitled draft'}.", dedupe_key=key,
                metadata_json={"document_id": document.id, "case_id": case.id,
                               "link": f"/dashboard/documents?document_id={document.id}"},
            )
