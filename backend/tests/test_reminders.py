from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.v1 import notifications as notifications_api
from app.models.notification import Notification
from app.models.enums import RecordStatus, UserRole
from app.services.email import build_reminder_email
from app.services import reminders as reminder_service
from app.services.reminders import process_due_reminders, reminder_category


class ReminderDBStub:
    def __init__(self, scalars_rows=None, existing=False):
        self.scalars_rows = list(scalars_rows or [])
        self.existing = existing
        self.added = []
        self.commits = 0

    async def scalar(self, *args, **kwargs):
        return 1 if self.existing else None

    async def scalars(self, *args, **kwargs):
        rows = self.scalars_rows.pop(0) if self.scalars_rows else []

        class _Rows:
            def __init__(self, values):
                self._values = values

            def all(self):
                return self._values

        return _Rows(rows)

    def add(self, obj):
        if isinstance(obj, Notification):
            obj.id = len(self.added) + 1
        self.added.append(obj)

    async def flush(self):
        return None

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        return None

    async def execute(self, *args, **kwargs):
        return None


def event_obj(event_id=10, org_id=1, user_id=2, start_at=None, reminder_at=None):
    now = datetime.now(timezone.utc)
    creator = user_obj(user_id, org_id)
    return SimpleNamespace(
        id=event_id,
        organization_id=org_id,
        case_id=None,
        created_by=user_id,
        title="Hearing",
        description="Attend directions hearing",
        event_type="court",
        start_at=start_at or now,
        reminder_at=reminder_at,
        creator=creator,
        case=None,
    )


def task_obj(task_id=20, org_id=1, creator_id=2, assigned_to=3, due_date=None, reminder_at=None, status="not_started"):
    now = datetime.now(timezone.utc)
    creator = user_obj(creator_id, org_id)
    assignee = user_obj(assigned_to, org_id)
    return SimpleNamespace(
        id=task_id,
        organization_id=org_id,
        case_id=30,
        client_id=40,
        created_by=creator_id,
        assigned_to=assigned_to,
        title="File response",
        description="Prepare filing",
        task_type="deadline",
        due_date=due_date or now,
        reminder_at=reminder_at,
        archived_at=None,
        status=status,
        creator=creator,
        assignee=assignee,
        case=None,
        client=None,
    )


def user_obj(user_id=2, org_id=1, *, active=True, role=UserRole.lawyer, email=None):
    return SimpleNamespace(
        id=user_id,
        organization_id=org_id,
        name=f"User {user_id}",
        email=email if email is not None else f"user{user_id}@example.com",
        role=role,
        status=RecordStatus.active if active else RecordStatus.inactive,
    )


@pytest.mark.asyncio
async def test_due_event_and_task_reminders_create_notifications_with_links():
    now = datetime(2026, 7, 18, 12, 0, tzinfo=timezone.utc)
    event = event_obj(start_at=now - timedelta(minutes=1), reminder_at=now - timedelta(minutes=15))
    task = task_obj(due_date=now - timedelta(minutes=1), reminder_at=now - timedelta(minutes=10))
    db = ReminderDBStub(scalars_rows=[[event], [event], [task], [task]])

    created = await process_due_reminders(db, now=now, deliver_emails=False)

    assert created == 6
    types = {row.type for row in db.added}
    assert {"event_due", "event_reminder", "task_due", "task_reminder"} <= types
    assert any(row.metadata_json.get("link") == "/dashboard/calendar?event_id=10" for row in db.added)
    assert any(row.metadata_json.get("link") == "/dashboard/tasks/20" for row in db.added)
    assert all(row.organization_id == 1 for row in db.added)
    assert all(row.is_read is False for row in db.added)
    assert all(row.popup_dismissed_at is None for row in db.added)
    assert all(row.email_status == "pending" for row in db.added)


@pytest.mark.asyncio
async def test_reminders_are_idempotent_when_existing_dedupe_keys_are_found():
    now = datetime(2026, 7, 18, 12, 0, tzinfo=timezone.utc)
    event = event_obj(start_at=now - timedelta(minutes=1), reminder_at=now - timedelta(minutes=15))
    task = task_obj(due_date=now - timedelta(days=1), reminder_at=now - timedelta(minutes=10))
    db = ReminderDBStub(scalars_rows=[[event], [event], [task], [task]], existing=True)

    created = await process_due_reminders(db, now=now, deliver_emails=False)

    assert created == 0
    assert db.added == []


@pytest.mark.asyncio
async def test_overdue_task_notification_uses_overdue_type_after_due_day():
    now = datetime(2026, 7, 18, 12, 0, tzinfo=timezone.utc)
    task = task_obj(due_date=now - timedelta(days=1), reminder_at=None)
    db = ReminderDBStub(scalars_rows=[[], [], [task], []])

    created = await process_due_reminders(db, now=now, deliver_emails=False)

    assert created == 2
    assert {row.type for row in db.added} == {"task_overdue"}


@pytest.mark.asyncio
async def test_completed_and_archived_tasks_are_skipped():
    now = datetime(2026, 7, 18, 12, 0, tzinfo=timezone.utc)
    completed = task_obj(task_id=21, due_date=now, status="completed")
    archived = task_obj(task_id=22, due_date=now)
    archived.archived_at = now
    db = ReminderDBStub(scalars_rows=[[], [], [completed, archived], []])
    assert await process_due_reminders(db, now=now, deliver_emails=False) == 0


@pytest.mark.asyncio
async def test_creator_assignee_is_deduplicated_and_cross_org_inactive_recipients_are_skipped():
    now = datetime(2026, 7, 18, 12, 0, tzinfo=timezone.utc)
    task = task_obj(due_date=now, creator_id=2, assigned_to=2)
    task.assignee = task.creator
    db = ReminderDBStub(scalars_rows=[[], [], [task], []])
    assert await process_due_reminders(db, now=now, deliver_emails=False) == 1
    assert {row.user_id for row in db.added} == {2}

    task.assignee = user_obj(8, 99)
    task.creator = user_obj(2, 1, active=False)
    db = ReminderDBStub(scalars_rows=[[], [], [task], []])
    assert await process_due_reminders(db, now=now, deliver_emails=False) == 0


@pytest.mark.asyncio
async def test_calendar_creator_and_case_assignees_receive_once_with_related_names():
    now = datetime(2026, 7, 18, 12, 0, tzinfo=timezone.utc)
    event = event_obj(start_at=now)
    assignee = user_obj(4)
    client = SimpleNamespace(id=7, name="Acme Client")
    event.case = SimpleNamespace(
        id=6, client_id=7, title="Acme Matter", client=client,
        assignments=[SimpleNamespace(user=assignee), SimpleNamespace(user=event.creator)],
    )
    db = ReminderDBStub(scalars_rows=[[event], [], [], []])
    assert await process_due_reminders(db, now=now, deliver_emails=False) == 2
    assert {row.user_id for row in db.added} == {2, 4}
    assert all(row.metadata_json["case_title"] == "Acme Matter" for row in db.added)
    assert all(row.metadata_json["client_name"] == "Acme Client" for row in db.added)


@pytest.mark.parametrize("event_type, expected", [
    ("court", "Court Event Reminder"),
    ("hearing", "Court Event Reminder"),
    ("meeting", "Meeting Reminder"),
    ("consultation", "Meeting Reminder"),
    ("deadline", "Deadline Reminder"),
    ("travel", "Calendar Event Reminder"),
])
def test_calendar_reminder_categories(event_type, expected):
    assert reminder_category("event_reminder", event_type) == expected


def test_reminder_email_has_absolute_link_utc_details_and_escaped_html(monkeypatch):
    from app.services import email as email_service
    monkeypatch.setattr(email_service.settings, "app_base_url", "https://app.example.test")
    subject, html, text = build_reminder_email(
        recipient_name="A & B", category="Court Event Reminder", record_title="Hearing <urgent>",
        scheduled_at="2026-07-18T12:00:00Z", link="/dashboard/calendar?event_id=10",
        case_title="Smith & Co", client_name="<Client>", description="Review > papers",
    )
    assert subject == "VILO Court Event Reminder: Hearing <urgent>"
    assert "https://app.example.test/dashboard/calendar?event_id=10" in html
    assert "18/07/2026, 12:00 PM UTC" in html and "UTC" in text
    assert "Hearing &lt;urgent&gt;" in html and "&lt;Client&gt;" in html and "Smith &amp; Co" in html
    assert "<urgent>" not in html


def notification_obj(notification_id=1, *, user=None, type="task_reminder", dismissed=None, email_status="pending"):
    now = datetime(2026, 7, 18, 12, 0, tzinfo=timezone.utc)
    return SimpleNamespace(
        id=notification_id, organization_id=1, user_id=(user or user_obj()).id,
        user=user or user_obj(), type=type, title="Task Due Soon: File response",
        body="Due time: 2026-07-18 12:00 UTC", is_read=False,
        metadata_json={
            "task_id": 20, "record_title": "File response", "display_category": "Task Due Soon",
            "due_date": now.isoformat(), "link": "/dashboard/tasks/20",
            "case_title": "Smith Matter", "client_name": "Smith Client",
        },
        popup_dismissed_at=dismissed, email_status=email_status, email_attempts=0,
        email_last_attempt_at=None, email_sent_at=None, email_last_error=None, created_at=now,
    )


@pytest.mark.asyncio
async def test_email_claim_increments_attempt_and_skips_missing_or_inactive_email():
    eligible = notification_obj(1)
    missing = notification_obj(2, user=user_obj(3, email=""))
    inactive = notification_obj(3, user=user_obj(4, active=False))
    db = ReminderDBStub(scalars_rows=[[eligible, missing, inactive]])
    claimed = await reminder_service._claim_reminder_emails(db, datetime.now(timezone.utc))
    assert claimed == [eligible]
    assert eligible.email_status == "sending" and eligible.email_attempts == 1
    assert missing.email_status == inactive.email_status == "skipped"
    assert db.commits == 1


@pytest.mark.asyncio
async def test_email_success_failure_retry_and_no_resend_after_success(monkeypatch):
    success = notification_obj(1, email_status="sending")
    failed = notification_obj(2, email_status="sending")
    claims = [[success, failed], [failed], []]
    sent_to = []

    async def claim(_db, _now):
        return claims.pop(0)

    outcomes = iter([True, False, True])

    async def send(to_email, *_args):
        sent_to.append(to_email)
        return next(outcomes)

    monkeypatch.setattr(reminder_service, "_claim_reminder_emails", claim)
    monkeypatch.setattr(reminder_service, "send_email", send)
    db = ReminderDBStub()
    assert await reminder_service.process_reminder_emails(db) == 1
    assert success.email_status == "sent" and success.email_sent_at is not None
    assert failed.email_status == "failed" and failed.email_last_error
    assert await reminder_service.process_reminder_emails(db) == 1
    assert failed.email_status == "sent"
    assert await reminder_service.process_reminder_emails(db) == 0
    assert len(sent_to) == 3


@pytest.mark.asyncio
async def test_email_exception_is_recorded_without_blocking_next_recipient(monkeypatch):
    first = notification_obj(1, email_status="sending")
    second = notification_obj(2, email_status="sending")

    async def claim(_db, _now):
        return [first, second]

    calls = 0

    async def send(*_args):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("smtp credential must not be stored")
        return True

    monkeypatch.setattr(reminder_service, "_claim_reminder_emails", claim)
    monkeypatch.setattr(reminder_service, "send_email", send)
    assert await reminder_service.process_reminder_emails(ReminderDBStub()) == 1
    assert first.email_status == "failed" and first.email_last_error == "SMTP delivery failed"
    assert second.email_status == "sent"


@pytest.mark.asyncio
async def test_popup_list_is_scoped_bounded_and_returns_only_db_selected_rows(monkeypatch):
    reminder = notification_obj()
    db = ReminderDBStub(scalars_rows=[[reminder]])

    async def no_process(*_args, **_kwargs):
        return 0

    monkeypatch.setattr(notifications_api, "process_due_reminders", no_process)
    current_user = user_obj(2, 1)
    response = await notifications_api.list_popup_reminders(limit=10, db=db, current_user=current_user)
    assert [item.id for item in response.items] == [1]
    assert response.items[0].metadata["task_id"] == 20


@pytest.mark.asyncio
async def test_popup_dismiss_is_idempotent_separate_from_read_and_does_not_delete():
    reminder = notification_obj()
    db = ReminderDBStub()
    db.scalar = lambda *args, **kwargs: None

    async def own_scalar(*_args, **_kwargs):
        return reminder

    db.scalar = own_scalar
    current_user = user_obj(2, 1)
    first = await notifications_api.dismiss_popup_reminder(1, db=db, current_user=current_user)
    second = await notifications_api.dismiss_popup_reminder(1, db=db, current_user=current_user)
    assert first.ok and second.popup_dismissed_at == first.popup_dismissed_at
    assert reminder.is_read is False and reminder.popup_dismissed_at is not None
    assert db.commits == 1 and reminder not in db.added


@pytest.mark.asyncio
async def test_another_user_cannot_dismiss_reminder():
    db = ReminderDBStub()
    with pytest.raises(HTTPException) as error:
        await notifications_api.dismiss_popup_reminder(1, db=db, current_user=user_obj(99, 1))
    assert error.value.status_code == 404


def test_email_claim_query_has_lock_batch_retry_and_attempt_limit():
    query = str(
        reminder_service.select(Notification)
        .where(Notification.email_attempts < reminder_service.MAX_EMAIL_ATTEMPTS)
        .with_for_update(skip_locked=True)
        .limit(reminder_service.EMAIL_BATCH_SIZE)
    )
    assert "FOR UPDATE" in query and "email_attempts" in query and "LIMIT" in query


def test_reminder_migration_backfills_history_without_enqueuing_email():
    migration = Path(__file__).parents[1] / "alembic/versions/20260723_33_reminder_popup_email_delivery.py"
    source = migration.read_text()
    assert 'down_revision: Union[str, None] = "20260722_32"' in source
    assert "SET popup_dismissed_at = created_at" in source
    assert "email_status = NULL" in source
    assert "ix_notifications_pending_popup" in source
    assert "ix_notifications_email_delivery" in source
