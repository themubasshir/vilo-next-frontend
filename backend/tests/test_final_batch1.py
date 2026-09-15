"""Final Batch 1 regressions for File teams and assignment notifications."""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from test_message_document_notifications import messaging  # noqa: F401
from test_precedent_document_workflow import create_precedent, workflow  # noqa: F401
from app.api.v1 import tasks as tasks_api
from app.models.case import CaseAssignment
from app.models.client import ClientAssignment
from app.models.enums import UserRole
from app.models.notification import Notification
from app.models.user import User


async def add_staff(sessions, *members):
    now = datetime.now(timezone.utc)
    async with sessions() as db:
        for user_id, organization_id, role in members:
            db.add(User(
                id=user_id,
                organization_id=organization_id,
                name=f"Staff {user_id}",
                email=f"final-batch-{user_id}@example.test",
                hashed_password="unused",
                role=UserRole(role),
                created_at=now,
                updated_at=now,
            ))
        await db.commit()


@pytest.mark.asyncio
async def test_case_final_selected_set_diff_notifications_and_no_client_assignment(workflow):
    client, sessions, actor = workflow
    await add_staff(sessions, (4, 1, "admin"), (5, 1, "lawyer"), (6, 1, "partner"))

    created = await client.post("/api/v1/cases", json={
        "title": "Team File",
        "client_id": 1,
        "status": "active",
        "assigned_user_ids": [1, 3, 4, 4],
    })
    assert created.status_code == 200, created.text
    case_id = created.json()["id"]
    assert {row["id"] for row in created.json()["assigned_users"]} == {1, 3, 4}

    async with sessions() as db:
        assert await db.scalar(select(func.count(CaseAssignment.id)).where(CaseAssignment.case_id == case_id)) == 3
        assert (await db.scalars(select(ClientAssignment))).all() == []
        created_notifications = (await db.scalars(select(Notification).where(Notification.type == "case_assigned"))).all()
        assert {row.user_id for row in created_notifications} == {3, 4}
        assert all(row.metadata_json["case_id"] == case_id for row in created_notifications)
        assert all(row.metadata_json["link"] == f"/dashboard/cases/{case_id}" for row in created_notifications)

    updated = await client.patch(f"/api/v1/cases/{case_id}", json={"assigned_user_ids": [1, 3, 5, 5]})
    assert updated.status_code == 200, updated.text
    assert {row["id"] for row in updated.json()["assigned_users"]} == {1, 3, 5}

    async with sessions() as db:
        assignments = (await db.scalars(select(CaseAssignment).where(CaseAssignment.case_id == case_id))).all()
        assert {row.user_id for row in assignments} == {1, 3, 5}
        assert len(assignments) == 3
        notifications = (await db.scalars(select(Notification).where(Notification.type == "case_assigned"))).all()
        assert [row.user_id for row in notifications].count(3) == 1  # unchanged member was not notified again
        assert [row.user_id for row in notifications].count(4) == 1  # removal generated no notification
        assert [row.user_id for row in notifications].count(5) == 1
        assert all(row.user_id != actor["id"] for row in notifications)
        assert (await db.scalars(select(ClientAssignment))).all() == []


@pytest.mark.asyncio
async def test_case_team_cross_org_and_unauthorized_changes_create_nothing(workflow):
    client, sessions, actor = workflow
    await add_staff(sessions, (4, 1, "client"))
    assert (await client.patch("/api/v1/cases/1", json={"assigned_user_ids": [2]})).status_code == 400
    assert (await client.patch("/api/v1/cases/1", json={"assigned_user_ids": [4]})).status_code == 400
    actor["id"] = 4
    denied = await client.patch("/api/v1/cases/1", json={"assigned_user_ids": [3]})
    assert denied.status_code == 403
    async with sessions() as db:
        assert (await db.scalars(select(CaseAssignment).where(CaseAssignment.case_id == 1))).all() == []
        assert (await db.scalars(select(Notification))).all() == []


@pytest.mark.asyncio
async def test_case_assignment_is_persisted_unread_and_available_as_popup(messaging):
    client, _sessions, actor = messaging
    created = await client.post("/api/v1/cases", json={
        "title": "Notification File",
        "client_id": 1,
        "status": "active",
        "assigned_user_ids": [3],
    })
    assert created.status_code == 200, created.text
    actor["id"] = 3
    notification_list = (await client.get("/api/v1/notifications")).json()
    assert notification_list["unread_count"] == 1
    assert notification_list["items"][0]["type"] == "case_assigned"
    popup = (await client.get("/api/v1/notifications/popup-alerts")).json()["items"]
    assert len(popup) == 1 and popup[0]["type"] == "case_assigned"


@pytest.mark.asyncio
async def test_task_assignment_create_reassign_and_unrelated_edit_notifications(messaging, monkeypatch):
    client, sessions, actor = messaging
    monkeypatch.setattr(tasks_api, "enqueue_email", lambda *args, **kwargs: None)
    async def no_reminder_suppression(*args, **kwargs):
        return None
    monkeypatch.setattr(tasks_api, "suppress_obsolete_reminders", no_reminder_suppression)
    due = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()

    created = await client.post("/api/v1/tasks", json={
        "title": "Prepare closing documents",
        "case_id": 1,
        "assigned_to": 3,
        "status": "not_started",
        "priority": "high",
        "due_date": due,
    })
    assert created.status_code == 200, created.text
    task_id = created.json()["id"]
    async with sessions() as db:
        rows = (await db.scalars(select(Notification).where(Notification.type == "task_assigned"))).all()
        assert len(rows) == 1 and rows[0].user_id == 3
        assert rows[0].metadata_json["task_id"] == task_id
        assert rows[0].metadata_json["link"] == f"/dashboard/tasks/{task_id}"

    assert (await client.patch(f"/api/v1/tasks/{task_id}", json={"title": "Prepare final closing documents"})).status_code == 200
    assert (await client.patch(f"/api/v1/tasks/{task_id}", json={"assigned_to": 3})).status_code == 200
    assert (await client.patch(f"/api/v1/tasks/{task_id}", json={"assigned_to": 4})).status_code == 200
    async with sessions() as db:
        rows = (await db.scalars(select(Notification).where(Notification.type == "task_assigned"))).all()
        assert [(row.user_id, row.metadata_json["task_id"]) for row in rows] == [(3, task_id), (4, task_id)]

    self_assigned = await client.post("/api/v1/tasks", json={
        "title": "Own task", "assigned_to": actor["id"], "status": "not_started", "priority": "medium", "due_date": due,
    })
    assert self_assigned.status_code == 200, self_assigned.text
    cross_org = await client.post("/api/v1/tasks", json={
        "title": "Wrong firm", "assigned_to": 5, "status": "not_started", "priority": "medium", "due_date": due,
    })
    assert cross_org.status_code == 400
    async with sessions() as db:
        assert await db.scalar(select(func.count(Notification.id)).where(Notification.type == "task_assigned")) == 2


@pytest.mark.asyncio
async def test_document_notifies_every_active_direct_team_role_only(messaging):
    client, sessions, _actor = messaging
    await add_staff(sessions, (7, 1, "partner"), (8, 1, "lawyer"), (9, 1, "admin"))
    async with sessions() as db:
        (await db.get(User, 4)).role = UserRole.paralegal
        db.add_all([
            CaseAssignment(case_id=1, user_id=1),
            CaseAssignment(case_id=1, user_id=4),
            CaseAssignment(case_id=1, user_id=7),
            CaseAssignment(case_id=1, user_id=8),
            CaseAssignment(case_id=1, user_id=9),
            ClientAssignment(client_id=1, user_id=6),
        ])
        await db.commit()

    uploaded = await client.post(
        "/api/v1/documents/upload",
        data={"title": "Engagement Letter", "case_id": "1"},
        files={"file": ("engagement.txt", b"terms", "text/plain")},
    )
    assert uploaded.status_code == 200, uploaded.text
    document_id = uploaded.json()["id"]
    async with sessions() as db:
        rows = (await db.scalars(select(Notification).where(Notification.type == "document_uploaded"))).all()
        assert {row.user_id for row in rows} == {3, 4, 7, 8, 9}
        assert all(row.user_id not in {1, 5, 6} for row in rows)
        assert all(row.metadata_json == {
            "document_id": document_id,
            "case_id": 1,
            "link": f"/dashboard/documents?document_id={document_id}",
        } for row in rows)

    assert (await client.post(f"/api/v1/documents/{document_id}/replace", files={"file": ("replacement.txt", b"new", "text/plain")})).status_code == 200
    assert (await client.post(f"/api/v1/documents/{document_id}/editable-content", json={"content": "edited"})).status_code == 200
    async with sessions() as db:
        assert await db.scalar(select(func.count(Notification.id)).where(Notification.type == "document_uploaded")) == 5
