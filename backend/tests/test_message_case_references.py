from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import AsyncIterator

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


class MsgDBStub:
    def __init__(self, scalar_values=None, scalars_values=None):
        self.scalar_values = list(scalar_values or [])
        self.scalars_values = list(scalars_values or [])
        self.added = []

    async def scalar(self, query, *args, **kwargs):
        if self.scalar_values:
            return self.scalar_values.pop(0)
        return None

    async def scalars(self, query, *args, **kwargs):
        rows = self.scalars_values.pop(0) if self.scalars_values else []

        class _Rows:
            def __init__(self, values):
                self._values = values

            def all(self):
                return self._values

        return _Rows(rows)

    def add_all(self, objects):
        for obj in objects:
            self.add(obj)

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        for idx, obj in enumerate(self.added, start=1):
            if getattr(obj, "id", None) is None:
                obj.id = idx

    async def commit(self):
        return None

    async def refresh(self, obj):
        return None


def build_client(role: str, db: MsgDBStub, org_id: int = 1):
    user = DummyUser(id=10, organization_id=org_id, name=f"{role} user", email="u@example.com", role=UserRole(role))

    async def _get_current_user():
        return user

    async def _get_db() -> AsyncIterator[MsgDBStub]:
        yield db

    app.dependency_overrides[deps_module.get_current_user] = _get_current_user
    app.dependency_overrides[deps_module.get_db] = _get_db
    return TestClient(app)


def cleanup(client: TestClient):
    client.close()
    app.dependency_overrides.clear()


def _conversation(org=1, case_id=12):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(id=5, organization_id=org, case_id=case_id, conversation_type="internal", title="Team", created_by=10, created_at=now, updated_at=now)


def _participant(org=1):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(id=9, organization_id=org, conversation_id=5, user_id=10, role="owner", last_read_at=None, created_at=now)


def _case(org=1, case_id=12):
    return SimpleNamespace(id=case_id, organization_id=org, client_id=7, title="Smith v Brown", updated_at=datetime.now(timezone.utc))


def _message(org=1, msg_id=1):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(id=msg_id, organization_id=org, conversation_id=5, sender_id=10, parent_message_id=None, body="Hello", created_at=now, updated_at=now, deleted_at=None)


def _sender(org=1):
    return SimpleNamespace(id=10, organization_id=org, name="Sarah Khan", role=UserRole.partner)


def test_staff_can_send_message_with_case_reference_and_get_sender_name():
    db = MsgDBStub()
    conversation = _conversation()
    reference_case = _case()
    sender = _sender()
    reference_row = SimpleNamespace(id=1, organization_id=1, message_id=1, case_id=12, created_at=datetime.now(timezone.utc))

    async def scalar_side_effect(query, *args, **kwargs):
        q = str(query)
        if "conversation_participants" in q:
            return _participant()
        if "cases.id" in q:
            return reference_case
        if "conversations.id" in q:
            return conversation
        if "users.id" in q:
            return sender
        return None

    async def scalars_side_effect(query, *args, **kwargs):
        q = str(query)
        rows = [11] if "conversation_participants.user_id" in q else [reference_row] if "message_case_references" in q else []

        class _Rows:
            def __init__(self, values):
                self._values = values

            def all(self):
                return self._values

        return _Rows(rows)

    db.scalar = scalar_side_effect  # type: ignore[assignment]
    db.scalars = scalars_side_effect  # type: ignore[assignment]
    client = build_client("partner", db)
    try:
        res = client.post(
            "/api/v1/conversations/5/messages",
            json={"body": "Please review this", "case_reference_ids": [12]},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["sender_name"] == "Sarah Khan"
        assert len(body["case_references"]) == 1
        assert body["case_references"][0]["case_id"] == 12
    finally:
        cleanup(client)


def test_cross_org_case_reference_blocked():
    db = MsgDBStub(
        scalar_values=[_participant(), None],
    )
    client = build_client("admin", db)
    try:
        res = client.post(
            "/api/v1/conversations/5/messages",
            json={"body": "bad ref", "case_reference_ids": [999]},
        )
        assert res.status_code == 400
    finally:
        cleanup(client)


def test_case_search_is_org_scoped():
    db = MsgDBStub(
        scalars_values=[[_case(case_id=12), _case(case_id=13)]],
    )
    client = build_client("lawyer", db)
    try:
        res = client.get("/api/v1/conversations/cases/search?q=smith")
        assert res.status_code == 200
        body = res.json()
        assert len(body) >= 1
        assert "title" in body[0]
    finally:
        cleanup(client)
