from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import Integer, and_, case as sql_case, cast, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.calendar_event import CalendarEvent
from app.models.case import Case, CaseAssignment
from app.models.notification import Notification
from app.models.task import Task
from app.models.user import User
from app.models.enums import RecordStatus, UserRole
from app.services.email import build_reminder_email, send_email
from app.services.notifications import create_notification


REMINDER_POLL_INTERVAL_SECONDS = 60
OPEN_TASK_STATUSES = {"not_started", "in_progress", "waiting", "pending"}
REMINDER_TYPES = ("task_reminder", "task_due", "task_overdue", "event_reminder", "event_due")
MAX_EMAIL_ATTEMPTS = 3
EMAIL_BATCH_SIZE = 20
EMAIL_RETRY_DELAY = timedelta(minutes=5)
EMAIL_CLAIM_TIMEOUT = timedelta(minutes=10)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _display_time(value: datetime | None) -> str:
    converted = _utc(value)
    return f"{converted.strftime('%d/%m/%Y')}, {converted.strftime('%I:%M %p').lstrip('0')} UTC" if converted else "unscheduled"


def _event_link(event: CalendarEvent) -> str:
    return f"/dashboard/calendar?event_id={event.id}"


def _task_link(task: Task) -> str:
    return f"/dashboard/tasks/{task.id}"


def reminder_category(notification_type: str, event_type: str | None = None) -> str:
    if notification_type == "task_reminder":
        return "Task Due Soon"
    if notification_type == "task_due":
        return "Task Due"
    if notification_type == "task_overdue":
        return "Task Overdue"
    if notification_type == "event_due":
        return "Event Starting"
    normalized = (event_type or "").strip().lower()
    if normalized in {"court", "hearing"}:
        return "Court Event Reminder"
    if normalized in {"meeting", "client", "consultation"}:
        return "Meeting Reminder"
    if normalized == "deadline":
        return "Deadline Reminder"
    return "Calendar Event Reminder"


def _is_internal_active_user(user: User | None, organization_id: int) -> bool:
    if user is None:
        return False
    role = getattr(user.role, "value", user.role)
    user_status = getattr(user.status, "value", user.status)
    return user.organization_id == organization_id and user_status == RecordStatus.active.value and role != UserRole.client.value


def _task_recipients(task: Task) -> list[User]:
    candidates = [getattr(task, "creator", None), getattr(task, "assignee", None)]
    unique = {}
    for user in candidates:
        if _is_internal_active_user(user, task.organization_id):
            unique[user.id] = user
    return list(unique.values())


def _event_recipients(event: CalendarEvent) -> list[User]:
    candidates = [getattr(event, "creator", None)]
    event_case = getattr(event, "case", None)
    for assignment in getattr(event_case, "assignments", []) if event_case else []:
        candidates.append(getattr(assignment, "user", None))
    unique = {}
    for user in candidates:
        if _is_internal_active_user(user, event.organization_id):
            unique[user.id] = user
    return list(unique.values())


def _related_names(record) -> tuple[str | None, str | None]:
    linked_case = getattr(record, "case", None)
    direct_client = getattr(record, "client", None)
    case_title = getattr(linked_case, "title", None)
    client_name = getattr(direct_client, "name", None) or getattr(getattr(linked_case, "client", None), "name", None)
    return case_title, client_name


async def _already_created(db: AsyncSession, *, organization_id: int, user_id: int, dedupe_key: str) -> bool:
    existing = await db.scalar(
        select(Notification.id).where(
            Notification.organization_id == organization_id,
            Notification.user_id == user_id,
            Notification.dedupe_key == dedupe_key,
        )
    )
    return existing is not None


async def _create_once(
    db: AsyncSession,
    *,
    organization_id: int,
    user_id: int,
    type: str,
    title: str,
    body: str,
    metadata_json: dict,
    dedupe_key: str,
) -> bool:
    if await _already_created(db, organization_id=organization_id, user_id=user_id, dedupe_key=dedupe_key):
        return False
    await create_notification(
        db,
        organization_id=organization_id,
        user_id=user_id,
        type=type,
        title=title,
        body=body,
        metadata_json=metadata_json,
        dedupe_key=dedupe_key,
        popup_dismissed_at=None,
        email_status="pending",
    )
    return True


async def _claim_reminder_emails(db: AsyncSession, current_time: datetime) -> list[Notification]:
    retry_before = current_time - EMAIL_RETRY_DELAY
    stale_before = current_time - EMAIL_CLAIM_TIMEOUT
    rows = (
        await db.scalars(
            select(Notification)
            .join(
                User,
                and_(User.id == Notification.user_id, User.organization_id == Notification.organization_id),
            )
            .where(
                Notification.type.in_(REMINDER_TYPES),
                Notification.email_attempts < MAX_EMAIL_ATTEMPTS,
                or_(
                    Notification.email_status == "pending",
                    and_(Notification.email_status == "failed", Notification.email_last_attempt_at <= retry_before),
                    and_(Notification.email_status == "sending", Notification.email_last_attempt_at <= stale_before),
                ),
            )
            .options(selectinload(Notification.user))
            .order_by(Notification.created_at.asc())
            .with_for_update(skip_locked=True)
            .limit(EMAIL_BATCH_SIZE)
        )
    ).all()

    claimed = []
    for notification in rows:
        recipient = notification.user
        if not _is_internal_active_user(recipient, notification.organization_id) or not (recipient.email or "").strip():
            notification.email_status = "skipped"
            notification.email_last_error = "Recipient has no eligible active email address"
            continue
        notification.email_status = "sending"
        notification.email_attempts += 1
        notification.email_last_attempt_at = current_time
        notification.email_last_error = None
        claimed.append(notification)
    await db.commit()
    return claimed


async def process_reminder_emails(db: AsyncSession, *, now: datetime | None = None) -> int:
    current_time = _utc(now) or datetime.now(timezone.utc)
    claimed = await _claim_reminder_emails(db, current_time)
    sent_count = 0
    for notification in claimed:
        metadata = notification.metadata_json or {}
        scheduled_at = metadata.get("due_date") or metadata.get("starts_at")
        subject, html, text = build_reminder_email(
            recipient_name=notification.user.name,
            category=metadata.get("display_category") or reminder_category(notification.type, metadata.get("event_type")),
            record_title=metadata.get("record_title") or notification.title,
            scheduled_at=scheduled_at,
            link=metadata.get("link") or "/dashboard",
            case_title=metadata.get("case_title"),
            client_name=metadata.get("client_name"),
            description=metadata.get("description"),
        )
        try:
            delivered = await send_email(notification.user.email, subject, html, text)
        except Exception:
            delivered = False
        if delivered:
            notification.email_status = "sent"
            notification.email_sent_at = datetime.now(timezone.utc)
            notification.email_last_error = None
            sent_count += 1
        else:
            notification.email_status = "failed"
            notification.email_last_error = "SMTP delivery failed"
        await db.commit()
    return sent_count


async def suppress_obsolete_reminders(
    db: AsyncSession,
    *,
    organization_id: int,
    entity: str,
    entity_id: int,
    now: datetime | None = None,
) -> None:
    if entity not in {"task", "calendar_event"}:
        return
    current_time = _utc(now) or datetime.now(timezone.utc)
    metadata_key = "task_id" if entity == "task" else "calendar_event_id"
    await db.execute(
        update(Notification)
        .where(
            Notification.organization_id == organization_id,
            Notification.type.in_(REMINDER_TYPES),
            cast(Notification.metadata_json[metadata_key].astext, Integer) == entity_id,
            or_(Notification.popup_dismissed_at.is_(None), Notification.email_status.in_(("pending", "failed", "sending"))),
        )
        .values(
            popup_dismissed_at=func.coalesce(Notification.popup_dismissed_at, current_time),
            email_status=sql_case(
                (Notification.email_status.in_(("pending", "failed", "sending")), "skipped"),
                else_=Notification.email_status,
            ),
            email_last_error=sql_case(
                (Notification.email_status.in_(("pending", "failed", "sending")), "Reminder superseded by record update"),
                else_=Notification.email_last_error,
            ),
        )
    )


async def process_due_reminders(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    deliver_emails: bool = True,
) -> int:
    current_time = _utc(now) or datetime.now(timezone.utc)
    created = 0

    event_options = (
        selectinload(CalendarEvent.creator),
        selectinload(CalendarEvent.case).selectinload(Case.client),
        selectinload(CalendarEvent.case).selectinload(Case.assignments).selectinload(CaseAssignment.user),
    )
    task_options = (
        selectinload(Task.creator),
        selectinload(Task.assignee),
        selectinload(Task.client),
        selectinload(Task.case).selectinload(Case.client),
    )
    event_rows = (await db.scalars(select(CalendarEvent).where(CalendarEvent.start_at <= current_time).options(*event_options))).all()
    event_reminder_rows = (await db.scalars(
        select(CalendarEvent).where(CalendarEvent.reminder_at.is_not(None), CalendarEvent.reminder_at <= current_time).options(*event_options)
    )).all()
    tasks_due_rows = (await db.scalars(
        select(Task).where(
            Task.due_date.is_not(None), Task.due_date <= current_time,
            Task.archived_at.is_(None), Task.status.in_(OPEN_TASK_STATUSES),
        ).options(*task_options)
    )).all()
    task_reminder_rows = (await db.scalars(
        select(Task).where(
            Task.reminder_at.is_not(None), Task.reminder_at <= current_time,
            Task.archived_at.is_(None), Task.status.in_(OPEN_TASK_STATUSES),
        ).options(*task_options)
    )).all()

    for event, notification_type, occurrence in [
        *((event, "event_due", event.start_at) for event in event_rows),
        *((event, "event_reminder", event.reminder_at) for event in event_reminder_rows),
    ]:
        if getattr(event, "deleted_at", None) is not None:
            continue
        case_title, client_name = _related_names(event)
        category = reminder_category(notification_type, event.event_type)
        metadata = {
            "calendar_event_id": event.id, "case_id": event.case_id,
            "client_id": getattr(getattr(event, "case", None), "client_id", None),
            "case_title": case_title, "client_name": client_name,
            "starts_at": _utc(event.start_at).isoformat() if _utc(event.start_at) else None,
            "reminder_at": _utc(event.reminder_at).isoformat() if _utc(event.reminder_at) else None,
            "event_type": event.event_type, "record_title": event.title,
            "description": getattr(event, "description", None), "display_category": category,
            "link": _event_link(event),
        }
        key = f"calendar_event:{event.id}:{'start' if notification_type == 'event_due' else 'reminder'}:{_display_time(occurrence)}"
        for recipient in _event_recipients(event):
            created += int(await _create_once(
                db, organization_id=event.organization_id, user_id=recipient.id,
                type=notification_type, title=f"{category}: {event.title}",
                body=f"Start time: {_display_time(event.start_at)}", metadata_json=metadata, dedupe_key=key,
            ))

    for task, notification_type, occurrence in [
        *((task, "task_overdue" if _utc(task.due_date) and _utc(task.due_date).date() < current_time.date() else "task_due", task.due_date) for task in tasks_due_rows),
        *((task, "task_reminder", task.reminder_at) for task in task_reminder_rows),
    ]:
        if getattr(task, "archived_at", None) is not None or task.status not in OPEN_TASK_STATUSES:
            continue
        case_title, client_name = _related_names(task)
        category = reminder_category(notification_type)
        metadata = {
            "task_id": task.id, "case_id": task.case_id, "client_id": task.client_id,
            "case_title": case_title, "client_name": client_name,
            "due_date": _utc(task.due_date).isoformat() if _utc(task.due_date) else None,
            "reminder_at": _utc(task.reminder_at).isoformat() if _utc(task.reminder_at) else None,
            "task_type": task.task_type, "record_title": task.title,
            "description": getattr(task, "description", None), "display_category": category,
            "link": _task_link(task),
        }
        kind = "overdue" if notification_type == "task_overdue" else "due" if notification_type == "task_due" else "reminder"
        key = f"task:{task.id}:{kind}:{_display_time(occurrence)}"
        for recipient in _task_recipients(task):
            created += int(await _create_once(
                db, organization_id=task.organization_id, user_id=recipient.id,
                type=notification_type, title=f"{category}: {task.title}",
                body=f"Due time: {_display_time(task.due_date)}", metadata_json=metadata, dedupe_key=key,
            ))

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        created = 0
    if deliver_emails:
        await process_reminder_emails(db, now=current_time)
    return created
