"""Persisted API tests for Batch 3 unread state, alerts, and File notifications."""
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from test_precedent_document_workflow import workflow, create_precedent  # noqa: F401
from app.api.v1 import clients, notifications
from app.db.base import Base
from app.models.calendar_event import CalendarEvent
from app.models.task import Task
from app.models.case import CaseAssignment
from app.models.client import Client
from app.models.conversation import Conversation, ConversationParticipant, Message
from app.models.document import Document
from app.models.enums import UserRole
from app.models.message_case_reference import MessageCaseReference
from app.models.notification import Notification
from app.models.user import User
from app.services.message_unread import unread_messages_count
from app.services.notifications import notify_case_document_added


@pytest_asyncio.fixture
async def messaging(workflow, monkeypatch, tmp_path):
    client, sessions, actor = workflow
    async with sessions() as db:
        connection = await db.connection()
        await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
            model.__table__ for model in (Conversation, ConversationParticipant, Message, MessageCaseReference, Task, CalendarEvent)
        ]))
        now = datetime.now(timezone.utc)
        for uid, org, role in ((4, 1, UserRole.paralegal), (5, 2, UserRole.paralegal), (6, 1, UserRole.client)):
            db.add(User(id=uid, organization_id=org, name=f"User {uid}", email=f"user{uid}@example.test", hashed_password="unused", role=role, created_at=now, updated_at=now))
        await db.flush()
        (await db.get(User, 1)).role = UserRole.admin
        (await db.get(Client, 1)).user_id = 6
        db.add_all([CaseAssignment(case_id=1, user_id=3), CaseAssignment(case_id=2, user_id=5)])
        await db.commit()
    async def no_due_reminders(*args, **kwargs):
        return 0
    monkeypatch.setattr(notifications, "process_due_reminders", no_due_reminders)
    monkeypatch.setattr(clients, "REPOSITORY_ROOT", tmp_path)
    monkeypatch.setattr(clients, "STORAGE_ROOT", tmp_path / "client-documents")
    return workflow


async def new_message(client):
    response = await client.post('/api/v1/conversations', json={"title": "Smith Matter", "conversation_type": "internal", "participant_ids": [3]})
    assert response.status_code == 200, response.text
    cid = response.json()['id']
    response = await client.post(f'/api/v1/conversations/{cid}/messages', json={"body": "Please review the file"})
    assert response.status_code == 200, response.text
    return cid, response.json()


@pytest.mark.asyncio
async def test_unread_sender_deleted_mark_read_dashboard_and_metadata(messaging):
    client, sessions, actor = messaging
    cid, message = await new_message(client)
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['unread_count'] == 0
    async with sessions() as db:
        rows = (await db.scalars(select(Notification))).all()
        assert len(rows) == 1 and rows[0].user_id == 3
        assert rows[0].type == 'message_received'
        assert rows[0].metadata_json == {'conversation_id': cid, 'message_id': message['id'], 'conversation_title': 'Smith Matter'}
        assert await unread_messages_count(db, organization_id=1, user_id=1) == 0
        assert await unread_messages_count(db, organization_id=1, user_id=3) == 1
        db.add(Notification(organization_id=1, user_id=3, type='document_uploaded', title='Document', created_at=datetime.now(timezone.utc)))
        await db.commit()
        assert await unread_messages_count(db, organization_id=1, user_id=3) == 1
    actor['id'] = 3
    assert (await client.get('/api/v1/conversations')).json()[0]['unread_count'] == 1
    dashboard = await client.get('/api/v1/reports/dashboard/widgets')
    assert dashboard.status_code == 200, dashboard.text
    assert dashboard.json()['today_overview']['unread_messages_count'] == 1
    assert (await client.post(f'/api/v1/conversations/{cid}/mark-read')).status_code == 200
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['unread_count'] == 0
    assert (await client.get('/api/v1/reports/dashboard/widgets')).json()['today_overview']['unread_messages_count'] == 0
    actor['id'] = 1
    second = (await client.post(f'/api/v1/conversations/{cid}/messages', json={'body': 'Second'})).json()
    actor['id'] = 3
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['unread_count'] == 1
    assert (await client.post(f'/api/v1/conversations/{cid}/mark-read', params={'read_through': message['created_at']})).status_code == 200
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['unread_count'] == 1
    actor['id'] = 1
    assert (await client.delete(f"/api/v1/conversations/messages/{second['id']}")).status_code == 200
    actor['id'] = 3
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['unread_count'] == 0
    async with sessions() as db:
        assert await unread_messages_count(db, organization_id=1, user_id=3) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize('uid', [2, 4, 5])
async def test_conversation_participant_and_tenant_security(messaging, uid):
    client, _, actor = messaging
    cid, _ = await new_message(client)
    actor['id'] = uid
    assert (await client.get('/api/v1/conversations')).json() == []
    for path in (f'/api/v1/conversations/{cid}', f'/api/v1/conversations/{cid}/messages'):
        assert (await client.get(path)).status_code == 403
    assert (await client.post(f'/api/v1/conversations/{cid}/mark-read')).status_code == 403
    assert (await client.post(f'/api/v1/conversations/{cid}/messages', json={'body': 'No access'})).status_code == 403


@pytest.mark.asyncio
async def test_popup_ownership_dismiss_persistence_and_separate_read(messaging):
    client, sessions, actor = messaging
    cid, _ = await new_message(client)
    actor['id'] = 3
    alert = (await client.get('/api/v1/notifications/popup-alerts')).json()['items'][0]
    nid = alert['id']
    assert alert['type'] == 'message_received'
    assert (await client.get('/api/v1/notifications/popup-reminders')).json()['items'] == []
    for uid in (1, 2, 4):
        actor['id'] = uid
        assert (await client.get('/api/v1/notifications/popup-alerts')).json()['items'] == []
        assert (await client.post(f'/api/v1/notifications/{nid}/dismiss-popup')).status_code == 404
        await client.post('/api/v1/notifications/mark-read', json={'notification_ids': [nid]})
    actor['id'] = 3
    first = await client.post(f'/api/v1/notifications/{nid}/dismiss-popup')
    second = await client.post(f'/api/v1/notifications/{nid}/dismiss-popup')
    assert first.json()["ok"] and second.json()["ok"]
    assert first.json()["popup_dismissed_at"].rstrip("Z") == second.json()["popup_dismissed_at"].rstrip("Z")
    assert (await client.get('/api/v1/notifications/popup-alerts')).json()['items'] == []
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['unread_count'] == 1
    assert (await client.get('/api/v1/notifications')).json()['items'][0]['is_read'] is False
    await client.post('/api/v1/notifications/mark-read', json={'notification_ids': [nid]})
    assert (await client.get('/api/v1/notifications')).json()['items'][0]['is_read'] is True
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['unread_count'] == 1
    actor['id'] = 1
    await client.post(f'/api/v1/conversations/{cid}/messages', json={'body': 'Later'})
    actor['id'] = 3
    later = (await client.get('/api/v1/notifications/popup-alerts')).json()['items']
    assert len(later) == 1 and later[0]['id'] != nid
    await client.post('/api/v1/notifications/mark-all-read')
    assert (await client.get('/api/v1/notifications/popup-alerts')).json()['items'] == []


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['task_reminder', 'task_due', 'task_overdue', 'event_reminder', 'event_due'])
async def test_existing_reminder_endpoints_and_read_behavior(messaging, kind):
    client, sessions, actor = messaging
    actor['id'] = 3
    async with sessions() as db:
        item = Notification(organization_id=1, user_id=3, type=kind, title='Reminder', is_read=True, created_at=datetime.now(timezone.utc), metadata_json={'task_id': 9} if kind.startswith('task') else {'calendar_event_id': 7})
        db.add(item)
        await db.commit()
        nid = item.id
    for route in ('popup-reminders', 'popup-alerts'):
        rows = (await client.get(f'/api/v1/notifications/{route}')).json()['items']
        assert len(rows) == 1 and rows[0]['id'] == nid
    assert (await client.post(f'/api/v1/notifications/{nid}/dismiss-popup')).status_code == 200
    assert (await client.get('/api/v1/notifications/popup-reminders')).json()['items'] == []


@pytest.mark.asyncio
@pytest.mark.parametrize('role', ['admin', 'partner', 'lawyer', 'paralegal'])
async def test_file_upload_recipients_metadata_dedupe_and_replace(messaging, role):
    client, sessions, actor = messaging
    async with sessions() as db:
        (await db.get(User, 1)).role = UserRole(role)
        db.add(CaseAssignment(case_id=1, user_id=1))
        db.add(CaseAssignment(case_id=1, user_id=5))
        await db.commit()
    response = await client.post('/api/v1/documents/upload', data={'title': 'Evidence', 'case_id': '1'}, files={'file': ('evidence.txt', b'proof', 'text/plain')})
    assert response.status_code == 200, response.text
    doc = response.json()
    async with sessions() as db:
        rows = (await db.scalars(select(Notification))).all()
        assert len(rows) == 1 and rows[0].user_id == 3 and rows[0].organization_id == 1
        assert rows[0].type == 'document_uploaded' and rows[0].title == 'New document in File 1' and rows[0].body == 'Evidence'
        assert rows[0].metadata_json == {'document_id': doc['id'], 'case_id': 1, 'link': '/dashboard/cases/1?tab=documents'}
        assert rows[0].email_status is None
        await notify_case_document_added(db, document=await db.get(Document, doc['id']), actor_id=1)
        await db.commit()
        assert len((await db.scalars(select(Notification))).all()) == 1
    response = await client.post(f"/api/v1/documents/{doc['id']}/replace", files={'file': ('new.txt', b'new version', 'text/plain')})
    assert response.status_code == 200, response.text
    async with sessions() as db:
        assert len((await db.scalars(select(Notification))).all()) == 1


@pytest.mark.asyncio
async def test_no_case_and_client_ids_do_not_notify_and_client_share_survives(messaging):
    client, sessions, actor = messaging
    for data in ({'title': 'Standalone'}, {'title': 'Client file', 'client_id': '1'}, {'title': 'Passport', 'client_id': '1', 'category': 'client_id'}):
        response = await client.post('/api/v1/documents/upload', data=data, files={'file': ('id.pdf', b'%PDF-1.4\n%%EOF', 'application/pdf')})
        assert response.status_code == 200, response.text
    response = await client.post('/api/v1/clients/1/id-documents', data={'id_type': 'passport'}, files={'file': ('id.pdf', b'%PDF-1.4\n%%EOF', 'application/pdf')})
    assert response.status_code == 200, response.text
    async with sessions() as db:
        assert (await db.scalars(select(Notification))).all() == []
    response = await client.post('/api/v1/documents/upload', data={'title': 'Shared', 'case_id': '1', 'visibility': 'client_visible'}, files={'file': ('shared.txt', b'shared', 'text/plain')})
    assert response.status_code == 200, response.text
    async with sessions() as db:
        rows = (await db.scalars(select(Notification))).all()
        assert {(row.type, row.user_id) for row in rows} == {('document_uploaded', 3), ('document_shared', 6)}


@pytest.mark.asyncio
async def test_precedent_copy_notifies_assigned_paralegal_once(messaging):
    client, sessions, actor = messaging
    pid, _, _ = await create_precedent(client)
    response = await client.post(f'/api/v1/precedents/{pid}/copy-to-case', json={'case_id': 1})
    assert response.status_code == 200, response.text
    doc = response.json()['document']
    async with sessions() as db:
        rows = (await db.scalars(select(Notification))).all()
        assert len(rows) == 1 and rows[0].user_id == 3
        assert rows[0].metadata_json['document_id'] == doc['id']
    response = await client.post(f"/api/v1/documents/{doc['id']}/editable-content", json={'content': 'Updated draft'})
    assert response.status_code == 200, response.text
    async with sessions() as db:
        assert len((await db.scalars(select(Notification))).all()) == 1


@pytest.mark.asyncio
async def test_multiple_assigned_paralegals_each_receive_one(messaging):
    client, sessions, actor = messaging
    async with sessions() as db:
        db.add(CaseAssignment(case_id=1, user_id=4))
        await db.commit()
    response = await client.post('/api/v1/documents/upload', data={'title': 'Filing', 'case_id': '1'}, files={'file': ('filing.txt', b'filing', 'text/plain')})
    assert response.status_code == 200, response.text
    async with sessions() as db:
        rows = (await db.scalars(select(Notification))).all()
        assert len(rows) == 2 and {row.user_id for row in rows} == {3, 4}


@pytest.mark.asyncio
async def test_real_task_calendar_reminders_in_generalized_popup(messaging, monkeypatch):
    from app.services.reminders import process_due_reminders
    client, sessions, actor = messaging
    monkeypatch.setattr(notifications, 'process_due_reminders', process_due_reminders)
    now = datetime.now(timezone.utc)
    async with sessions() as db:
        db.add(Task(organization_id=1, created_by=3, assigned_to=3, title='Review', due_date=now, reminder_at=now, created_at=now, updated_at=now))
        db.add(CalendarEvent(organization_id=1, created_by=3, title='Hearing', event_type='court', start_at=now, reminder_at=now, created_at=now, updated_at=now))
        await db.commit()
    actor['id'] = 3
    response = await client.get('/api/v1/notifications/popup-alerts')
    assert response.status_code == 200, response.text
    rows = response.json()['items']
    assert {'task_reminder', 'task_due', 'event_reminder', 'event_due'} <= {row['type'] for row in rows}
    for row in rows:
        assert row['metadata']['link'].startswith('/dashboard/tasks/' if row['type'].startswith('task') else '/dashboard/calendar?event_id=')
    again = (await client.get('/api/v1/notifications/popup-reminders')).json()['items']
    assert {row['id'] for row in again} == {row['id'] for row in rows}
