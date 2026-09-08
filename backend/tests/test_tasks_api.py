from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from app.api import deps as deps_module
from app.main import app
from app.models.enums import RecordStatus, UserRole


@dataclass
class DummyUser:
    id: int
    organization_id: int
    name: str
    email: str
    role: UserRole
    status: RecordStatus = RecordStatus.active
    created_at: datetime = datetime.now(timezone.utc)
    updated_at: datetime = datetime.now(timezone.utc)


class TaskDBStub:
    def __init__(self, *, scalar_values=None, scalars_rows=None):
        self.scalar_values = list(scalar_values or [])
        self.scalars_rows = list(scalars_rows or [])
        self.added = []
        self.scalar_queries = []
        self.scalars_queries = []
        self.commits = 0

    async def scalar(self, query, *args, **kwargs):
        self.scalar_queries.append(str(query))
        if self.scalar_values:
            return self.scalar_values.pop(0)
        return None

    async def scalars(self, query, *args, **kwargs):
        self.scalars_queries.append(str(query))
        rows = self.scalars_rows.pop(0) if self.scalars_rows else []

        class _Rows:
            def __init__(self, values):
                self._values = values

            def all(self):
                return self._values

        return _Rows(rows)

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        for idx, obj in enumerate(self.added, start=1):
            if getattr(obj, "id", None) is None:
                obj.id = idx

    async def commit(self):
        self.commits += 1

    async def execute(self, query, *args, **kwargs):
        return None

    async def refresh(self, obj):
        return None


def build_client(role: str, db: TaskDBStub, *, org_id: int = 1, user_id: int = 1):
    user = DummyUser(
        id=user_id,
        organization_id=org_id,
        name=f"{role} user",
        email="u@example.com",
        role=UserRole(role),
    )

    async def _get_current_user():
        return user

    async def _get_db() -> AsyncIterator[TaskDBStub]:
        yield db

    app.dependency_overrides[deps_module.get_current_user] = _get_current_user
    app.dependency_overrides[deps_module.get_db] = _get_db
    return TestClient(app)


def cleanup(client: TestClient):
    client.close()
    app.dependency_overrides.clear()


def client_obj(client_id=10, org_id=1):
    return SimpleNamespace(id=client_id, organization_id=org_id, name="Client A", email="client@example.com")


def case_obj(case_id=20, org_id=1, client_id=10):
    return SimpleNamespace(id=case_id, organization_id=org_id, client_id=client_id)


def assignee_obj(user_id=8, org_id=1, role=UserRole.lawyer):
    return SimpleNamespace(id=user_id, organization_id=org_id, name="Assignee", email="assignee@example.com", role=role)


def task_obj(
    task_id=5,
    *,
    org_id=1,
    case_id=20,
    client_id=10,
    assigned_to=8,
    created_by=1,
    title="Prepare motion",
    description="Draft filing",
    task_type="deadline",
    status="not_started",
    priority="high",
    due_date=None,
    reminder_at=None,
    notes="Internal notes",
    completed_at=None,
    archived_at=None,
):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=task_id,
        organization_id=org_id,
        case_id=case_id,
        client_id=client_id,
        assigned_to=assigned_to,
        created_by=created_by,
        title=title,
        description=description,
        task_type=task_type,
        status=status,
        priority=priority,
        due_date=due_date or (now + timedelta(days=2)),
        reminder_at=reminder_at,
        notes=notes,
        completed_at=completed_at,
        archived_at=archived_at,
        created_at=now,
        updated_at=now,
    )


def test_create_task_with_required_fields():
    db = TaskDBStub(scalar_values=[client_obj(), assignee_obj()])
    client = build_client("partner", db)
    try:
        res = client.post(
            "/api/v1/tasks",
            json={
                "title": "Collect records",
                "client_id": 10,
                "assigned_user_id": 8,
                "priority": "urgent",
                "status": "pending",
                "due_date": "2026-06-20T09:00:00Z",
            },
        )
        assert res.status_code == 200
        body = res.json()
        assert body["status"] == "not_started"
        assert body["assigned_user_id"] == 8
        assert body["client_id"] == 10
        assert body["priority"] == "urgent"
    finally:
        cleanup(client)


def test_create_task_linked_to_case_derives_client():
    db = TaskDBStub(scalar_values=[case_obj(), client_obj(), assignee_obj()])
    client = build_client("lawyer", db)
    try:
        res = client.post(
            "/api/v1/tasks",
            json={
                "title": "Review evidence",
                "case_id": 20,
                "assigned_to": 8,
                "priority": "high",
                "status": "in_progress",
                "task_type": "document",
                "due_date": "2026-06-21T10:00:00Z",
            },
        )
        assert res.status_code == 200
        body = res.json()
        assert body["case_id"] == 20
        assert body["client_id"] == 10
        assert body["task_type"] == "document"
    finally:
        cleanup(client)


def test_create_task_linked_to_client():
    db = TaskDBStub(scalar_values=[client_obj(), assignee_obj()])
    client = build_client("admin", db)
    try:
        res = client.post(
            "/api/v1/tasks",
            json={
                "title": "Client follow-up",
                "client_id": 10,
                "assigned_to": 8,
                "priority": "medium",
                "status": "waiting",
                "task_type": "client_follow_up",
                "due_date": "2026-06-21T10:00:00Z",
                "notes": "Call after filing arrives",
            },
        )
        assert res.status_code == 200
        assert res.json()["notes"] == "Call after filing arrives"
    finally:
        cleanup(client)


def test_create_task_rejects_case_client_mismatch():
    db = TaskDBStub(scalar_values=[case_obj(client_id=10), client_obj(client_id=11)])
    client = build_client("partner", db)
    try:
        res = client.post(
            "/api/v1/tasks",
            json={
                "title": "Mismatch",
                "case_id": 20,
                "client_id": 11,
                "assigned_to": 8,
                "priority": "medium",
                "status": "not_started",
                "due_date": "2026-06-20T09:00:00Z",
            },
        )
        assert res.status_code == 400
        assert res.json()["detail"] == "Client must match the selected case"
    finally:
        cleanup(client)


@pytest.mark.parametrize(
    "payload,scalar_values,detail",
    [
        (
            {
                "title": "Blocked",
                "case_id": 20,
                "assigned_to": 8,
                "priority": "medium",
                "status": "not_started",
                "due_date": "2026-06-20T09:00:00Z",
            },
            [None],
            "Case must belong to your organization",
        ),
        (
            {
                "title": "Blocked",
                "client_id": 10,
                "assigned_to": 8,
                "priority": "medium",
                "status": "not_started",
                "due_date": "2026-06-20T09:00:00Z",
            },
            [None],
            "Client must belong to your organization",
        ),
        (
            {
                "title": "Blocked",
                "client_id": 10,
                "assigned_to": 8,
                "priority": "medium",
                "status": "not_started",
                "due_date": "2026-06-20T09:00:00Z",
            },
            [client_obj(), None],
            "Assignee must belong to your organization",
        ),
        (
            {
                "title": "Blocked",
                "client_id": 10,
                "assigned_to": 8,
                "priority": "medium",
                "status": "not_started",
                "due_date": "2026-06-20T09:00:00Z",
            },
            [client_obj(), assignee_obj(role=UserRole.client)],
            "Client users cannot be assigned internal tasks",
        ),
    ],
)
def test_cross_org_or_client_assignment_is_blocked(payload, scalar_values, detail):
    db = TaskDBStub(scalar_values=scalar_values)
    client = build_client("partner", db)
    try:
        res = client.post("/api/v1/tasks", json=payload)
        assert res.status_code == 400
        assert res.json()["detail"] == detail
    finally:
        cleanup(client)


def test_list_filters_include_assignment_status_priority_links_and_archive_scope():
    db = TaskDBStub(scalar_values=[assignee_obj(), case_obj(), client_obj()], scalars_rows=[[task_obj()]])
    client = build_client("lawyer", db)
    try:
        res = client.get(
            "/api/v1/tasks?assigned_user_id=8&status=pending&priority=high&case_id=20&client_id=10&include_archived=false"
        )
        assert res.status_code == 200
        query = db.scalars_queries[-1]
        assert "tasks.archived_at IS NULL" in query
        assert "tasks.assigned_to =" in query
        assert "tasks.case_id =" in query
        assert "tasks.client_id =" in query
        assert "tasks.status IN" in query
        assert "tasks.priority IN" in query
    finally:
        cleanup(client)


@pytest.mark.parametrize(
    "quick_view,expected_fragment",
    [
        ("due_today", "date"),
        ("overdue", "tasks.due_date <"),
        ("this_week", "tasks.due_date >="),
        ("high_priority", "tasks.priority IN"),
        ("completed", "tasks.status IN"),
        ("my_tasks", "tasks.assigned_to ="),
    ],
)
def test_list_quick_views_apply_expected_predicates(quick_view, expected_fragment):
    db = TaskDBStub(scalars_rows=[[task_obj()]])
    client = build_client("lawyer", db)
    try:
        res = client.get(f"/api/v1/tasks?quick_view={quick_view}")
        assert res.status_code == 200
        assert expected_fragment in db.scalars_queries[-1]
    finally:
        cleanup(client)


def test_patch_status_update_normalizes_and_sets_completed_at():
    existing = task_obj(status="not_started", completed_at=None)
    db = TaskDBStub(scalar_values=[existing])
    client = build_client("admin", db)
    try:
        res = client.patch("/api/v1/tasks/5", json={"status": "done"})
        assert res.status_code == 200
        body = res.json()
        assert body["status"] == "completed"
        assert body["completed_at"] is not None
    finally:
        cleanup(client)


def test_patch_priority_update():
    existing = task_obj(priority="medium")
    db = TaskDBStub(scalar_values=[existing])
    client = build_client("admin", db)
    try:
        res = client.patch("/api/v1/tasks/5", json={"priority": "critical"})
        assert res.status_code == 200
        assert res.json()["priority"] == "urgent"
    finally:
        cleanup(client)


def test_admin_can_edit_protected_task_fields():
    existing = task_obj(title="Original title")
    db = TaskDBStub(scalar_values=[existing])
    client = build_client("admin", db)
    try:
        res = client.patch("/api/v1/tasks/5", json={"title": "Admin revision"})
        assert res.status_code == 200
        assert res.json()["title"] == "Admin revision"
        assert db.commits == 1
    finally:
        cleanup(client)


def test_admin_can_delete_task():
    existing = task_obj(archived_at=None)
    db = TaskDBStub(scalar_values=[existing])
    client = build_client("admin", db)
    try:
        res = client.delete("/api/v1/tasks/5")
        assert res.status_code == 200
        assert res.json() == {"ok": True, "archived": True}
        assert existing.archived_at is not None
        assert db.commits == 1
    finally:
        cleanup(client)


@pytest.mark.parametrize("role", ["partner", "lawyer", "paralegal"])
def test_non_admin_cannot_edit_protected_task_fields(role):
    existing = task_obj(title="Original title")
    db = TaskDBStub(scalar_values=[existing])
    client = build_client(role, db)
    try:
        res = client.patch("/api/v1/tasks/5", json={"title": "Unauthorized revision"})
        assert res.status_code == 403
        assert res.json()["detail"] == "You do not have permission to edit this task."
        assert existing.title == "Original title"
        assert db.commits == 0
    finally:
        cleanup(client)


@pytest.mark.parametrize("role", ["partner", "lawyer", "paralegal"])
def test_non_admin_cannot_delete_task(role):
    existing = task_obj(archived_at=None)
    db = TaskDBStub(scalar_values=[existing])
    client = build_client(role, db)
    try:
        res = client.delete("/api/v1/tasks/5")
        assert res.status_code == 403
        assert res.json()["detail"] == "You do not have permission to delete this task."
        assert existing.archived_at is None
        assert db.commits == 0
    finally:
        cleanup(client)


def test_paralegal_can_still_change_task_status():
    existing = task_obj(status="not_started")
    db = TaskDBStub(scalar_values=[existing])
    client = build_client("paralegal", db)
    try:
        res = client.patch("/api/v1/tasks/5", json={"status": "in_progress"})
        assert res.status_code == 200
        assert res.json()["status"] == "in_progress"
    finally:
        cleanup(client)


@pytest.mark.parametrize("method", ["patch", "delete"])
def test_task_mutation_cross_organization_lookup_remains_hidden(method):
    db = TaskDBStub(scalar_values=[None])
    client = build_client("admin", db, org_id=99)
    try:
        response = client.patch("/api/v1/tasks/5", json={"title": "Blocked"}) if method == "patch" else client.delete("/api/v1/tasks/5")
        assert response.status_code == 404
        assert response.json()["detail"] == "Task not found"
        assert db.commits == 0
    finally:
        cleanup(client)


def test_mark_complete_endpoint():
    existing = task_obj(status="in_progress", completed_at=None)
    db = TaskDBStub(scalar_values=[existing])
    client = build_client("partner", db)
    try:
        res = client.post("/api/v1/tasks/5/complete")
        assert res.status_code == 200
        assert res.json()["status"] == "completed"
        assert res.json()["completed_at"] is not None
    finally:
        cleanup(client)


def test_archive_endpoint_and_active_list_behavior():
    existing = task_obj(archived_at=None)
    db = TaskDBStub(scalar_values=[existing], scalars_rows=[[existing]])
    client = build_client("partner", db)
    try:
        archive_res = client.post("/api/v1/tasks/5/archive")
        assert archive_res.status_code == 200
        assert archive_res.json()["archived_at"] is not None

        list_res = client.get("/api/v1/tasks")
        assert list_res.status_code == 200
        assert "tasks.archived_at IS NULL" in db.scalars_queries[-1]
    finally:
        cleanup(client)


def test_task_detail_response_includes_full_fields():
    existing = task_obj(reminder_at=datetime(2026, 6, 20, 8, 0, tzinfo=timezone.utc))
    db = TaskDBStub(scalar_values=[existing])
    client = build_client("lawyer", db)
    try:
        res = client.get("/api/v1/tasks/5")
        assert res.status_code == 200
        body = res.json()
        assert body["task_type"] == "deadline"
        assert body["notes"] == "Internal notes"
        assert body["reminder_at"].startswith("2026-06-20T08:00:00")
        assert body["assigned_user_id"] == 8
    finally:
        cleanup(client)


def test_is_overdue_behavior_excludes_completed_and_archived():
    overdue = task_obj(due_date=datetime.now(timezone.utc) - timedelta(days=2), status="in_progress")
    completed = task_obj(task_id=6, due_date=datetime.now(timezone.utc) - timedelta(days=2), status="completed", completed_at=datetime.now(timezone.utc))
    archived = task_obj(task_id=7, due_date=datetime.now(timezone.utc) - timedelta(days=2), status="waiting", archived_at=datetime.now(timezone.utc))
    db = TaskDBStub(scalars_rows=[[overdue, completed, archived]])
    client = build_client("lawyer", db)
    try:
        res = client.get("/api/v1/tasks?include_archived=true")
        assert res.status_code == 200
        rows = {item["id"]: item for item in res.json()}
        assert rows[5]["is_overdue"] is True
        assert rows[6]["is_overdue"] is False
        assert rows[7]["is_overdue"] is False
    finally:
        cleanup(client)


def test_client_role_cannot_manage_tasks():
    db = TaskDBStub()
    client = build_client("client", db)
    try:
        res = client.post(
            "/api/v1/tasks",
            json={
                "title": "Blocked",
                "client_id": 10,
                "assigned_to": 8,
                "priority": "medium",
                "status": "not_started",
                "due_date": "2026-06-20T09:00:00Z",
            },
        )
        assert res.status_code == 403
    finally:
        cleanup(client)


def test_calendar_can_include_task_due_items():
    task = task_obj()
    db = TaskDBStub(scalars_rows=[[], [task]])
    client = build_client("lawyer", db)
    try:
        res = client.get("/api/v1/calendar/events?include_tasks=true")
        assert res.status_code == 200
        body = res.json()
        assert len(body) == 1
        assert body[0]["source_type"] == "task"
        assert body[0]["task_id"] == task.id
        assert body[0]["event_type"] == "task"
    finally:
        cleanup(client)
