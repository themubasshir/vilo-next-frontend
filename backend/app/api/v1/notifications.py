from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.notification import Notification
from app.models.user import User
from app.schemas.notification import MarkNotificationsReadRequest, NotificationListResponse, NotificationResponse, PopupDismissResponse, PopupReminderListResponse
from app.services.reminders import REMINDER_TYPES, process_due_reminders

POPUP_TYPES = (*REMINDER_TYPES, "message_received", "case_assigned", "task_assigned", "document_uploaded")

router = APIRouter(prefix="/notifications", tags=["notifications"])


def serialize_notification(notification: Notification) -> NotificationResponse:
    return NotificationResponse(
        id=notification.id,
        type=notification.type,
        title=notification.title,
        body=notification.body,
        is_read=notification.is_read,
        metadata=notification.metadata_json,
        created_at=notification.created_at,
        popup_dismissed_at=notification.popup_dismissed_at,
        email_status=notification.email_status,
    )


@router.get("", response_model=NotificationListResponse)
async def list_notifications(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await process_due_reminders(db, deliver_emails=False)
    base_filters = [
        Notification.organization_id == current_user.organization_id,
        Notification.user_id == current_user.id,
    ]
    offset = (page - 1) * page_size
    rows = (
        await db.scalars(
            select(Notification)
            .where(*base_filters)
            .order_by(Notification.created_at.desc())
            .offset(offset)
            .limit(page_size)
        )
    ).all()
    total = int((await db.scalar(select(func.count(Notification.id)).where(*base_filters))) or 0)
    unread_count = int(
        (
            await db.scalar(
                select(func.count(Notification.id)).where(
                    *base_filters,
                    Notification.is_read.is_(False),
                )
            )
        )
        or 0
    )
    return NotificationListResponse(
        items=[serialize_notification(n) for n in rows],
        total=total,
        page=page,
        page_size=page_size,
        unread_count=unread_count,
    )


@router.get("/popup-reminders", response_model=PopupReminderListResponse)
async def list_popup_reminders(
    limit: int = Query(default=10, ge=1, le=10),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await process_due_reminders(db, deliver_emails=False)
    rows = (
        await db.scalars(
            select(Notification)
            .where(
                Notification.organization_id == current_user.organization_id,
                Notification.user_id == current_user.id,
                Notification.type.in_(REMINDER_TYPES),
                Notification.popup_dismissed_at.is_(None),
            )
            .order_by(Notification.created_at.asc())
            .limit(limit)
        )
    ).all()
    return PopupReminderListResponse(items=[serialize_notification(row) for row in rows])


@router.get("/popup-alerts", response_model=PopupReminderListResponse)
async def list_popup_alerts(
    limit: int = Query(default=10, ge=1, le=10),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await process_due_reminders(db, deliver_emails=False)
    rows = (
        await db.scalars(
            select(Notification)
            .where(
                Notification.organization_id == current_user.organization_id,
                Notification.user_id == current_user.id,
                Notification.type.in_(POPUP_TYPES),
                or_(Notification.type != "message_received", Notification.is_read.is_(False)),
                Notification.popup_dismissed_at.is_(None),
            )
            .order_by(Notification.created_at.asc())
            .limit(limit)
        )
    ).all()
    return PopupReminderListResponse(items=[serialize_notification(row) for row in rows])


@router.post("/{notification_id}/dismiss-popup", response_model=PopupDismissResponse)
async def dismiss_popup_reminder(
    notification_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    notification = await db.scalar(
        select(Notification).where(
            Notification.id == notification_id,
            Notification.organization_id == current_user.organization_id,
            Notification.user_id == current_user.id,
            Notification.type.in_(POPUP_TYPES),
        )
    )
    if not notification:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reminder notification not found")
    if notification.popup_dismissed_at is None:
        notification.popup_dismissed_at = datetime.now(timezone.utc)
        await db.commit()
    return PopupDismissResponse(popup_dismissed_at=notification.popup_dismissed_at)


@router.post("/mark-read")
async def mark_notifications_read(
    payload: MarkNotificationsReadRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not payload.notification_ids:
        return {"ok": True}
    await db.execute(
        update(Notification)
        .where(
            Notification.organization_id == current_user.organization_id,
            Notification.user_id == current_user.id,
            Notification.id.in_(payload.notification_ids),
        )
        .values(is_read=True)
    )
    await db.commit()
    return {"ok": True}


@router.post("/mark-all-read")
async def mark_all_notifications_read(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    await db.execute(
        update(Notification)
        .where(
            Notification.organization_id == current_user.organization_id,
            Notification.user_id == current_user.id,
            Notification.is_read.is_(False),
        )
        .values(is_read=True)
    )
    await db.commit()
    return {"ok": True}
