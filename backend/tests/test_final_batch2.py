from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from app.api import deps as deps_module
from app.api.v1 import documents as documents_module
from app.main import app
from app.models.audit_log import AuditLog
from app.models.case_timeline_event import CaseTimelineEvent
from app.models.enums import RecordStatus, UserRole


REPO_ROOT = Path(__file__).resolve().parents[2]


class DocumentDeleteDBStub:
    def __init__(self):
        self.added = []
        self.deleted = []
        self.commits = 0

    def add(self, value):
        self.added.append(value)

    async def flush(self):
        for index, value in enumerate(self.added, start=1):
            if getattr(value, "id", None) is None:
                value.id = index

    async def delete(self, value):
        self.deleted.append(value)

    async def commit(self):
        self.commits += 1


def document_row(path: Path, *, document_id: int = 51, case_id: int | None = 7, source_precedent_id: int | None = None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"selected document")
    return SimpleNamespace(
        id=document_id,
        organization_id=1,
        case_id=case_id,
        client_id=12,
        source_precedent_id=source_precedent_id,
        title="Engagement Letter",
        file_name="engagement.pdf",
        file_path=str(path),
    )


def document_delete_client(monkeypatch, role: str, db: DocumentDeleteDBStub, document, *, visible=True):
    user = SimpleNamespace(
        id=3,
        organization_id=1,
        name=f"{role} user",
        email=f"{role}@example.com",
        role=UserRole(role),
        status=RecordStatus.active,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )

    async def get_current_user():
        return user

    async def get_db() -> AsyncIterator[DocumentDeleteDBStub]:
        yield db

    async def get_document(_db, document_id, current_user):
        if not visible or document_id != document.id or current_user.organization_id != document.organization_id:
            return None
        return document

    app.dependency_overrides[deps_module.get_current_user] = get_current_user
    app.dependency_overrides[deps_module.get_db] = get_db
    monkeypatch.setattr(documents_module, "get_org_document", get_document)
    return TestClient(app)


@pytest.mark.parametrize("role", ["admin", "partner"])
def test_admin_and_partner_delete_case_document_with_audit_and_timeline(monkeypatch, tmp_path, role):
    db = DocumentDeleteDBStub()
    document = document_row(tmp_path / role / "engagement.pdf")
    client = document_delete_client(monkeypatch, role, db, document)
    try:
        response = client.delete(f"/api/v1/documents/{document.id}")
        assert response.status_code == 200
        assert response.json() == {"ok": True}
        assert db.deleted == [document]
        assert db.commits == 1
        assert not Path(document.file_path).exists()
        timeline = next(value for value in db.added if isinstance(value, CaseTimelineEvent))
        audit = next(value for value in db.added if isinstance(value, AuditLog))
        assert timeline.event_type == "document_deleted"
        assert timeline.metadata_json["document_id"] == document.id
        assert audit.action == "document_deleted"
        assert audit.entity_id == str(document.id)
    finally:
        client.close()
        app.dependency_overrides.clear()


@pytest.mark.parametrize("role", ["lawyer", "paralegal"])
def test_lawyer_and_paralegal_cannot_delete_case_document(monkeypatch, tmp_path, role):
    db = DocumentDeleteDBStub()
    document = document_row(tmp_path / role / "protected.pdf")
    client = document_delete_client(monkeypatch, role, db, document)
    try:
        response = client.delete(f"/api/v1/documents/{document.id}")
        assert response.status_code == 403
        assert db.deleted == []
        assert db.commits == 0
        assert Path(document.file_path).exists()
    finally:
        client.close()
        app.dependency_overrides.clear()


def test_assigned_paralegal_still_cannot_delete_accessible_case_document(monkeypatch, tmp_path):
    db = DocumentDeleteDBStub()
    document = document_row(tmp_path / "assigned" / "protected.pdf")
    client = document_delete_client(monkeypatch, "paralegal", db, document, visible=True)
    try:
        assert client.delete(f"/api/v1/documents/{document.id}").status_code == 403
        assert db.deleted == []
    finally:
        client.close()
        app.dependency_overrides.clear()


def test_cross_org_document_delete_is_non_disclosing(monkeypatch, tmp_path):
    db = DocumentDeleteDBStub()
    document = document_row(tmp_path / "other-org" / "hidden.pdf")
    client = document_delete_client(monkeypatch, "admin", db, document, visible=False)
    try:
        response = client.delete(f"/api/v1/documents/{document.id}")
        assert response.status_code == 404
        assert response.json()["detail"] == "Document not found"
        assert db.deleted == []
    finally:
        client.close()
        app.dependency_overrides.clear()


def test_case_document_delete_targets_exact_copy_without_touching_sibling_master_or_client(monkeypatch, tmp_path):
    db = DocumentDeleteDBStub()
    selected = document_row(tmp_path / "case" / "selected.pdf", source_precedent_id=91)
    sibling = document_row(tmp_path / "case" / "sibling.pdf", document_id=52)
    master = SimpleNamespace(id=91, is_archived=False, name="Master")
    client_record = SimpleNamespace(id=12, name="Client")
    api_client = document_delete_client(monkeypatch, "admin", db, selected)
    try:
        assert api_client.delete(f"/api/v1/documents/{selected.id}").status_code == 200
        assert db.deleted == [selected]
        assert Path(sibling.file_path).exists()
        assert master.is_archived is False
        assert client_record.name == "Client"
    finally:
        api_client.close()
        app.dependency_overrides.clear()


def test_non_case_document_delete_permissions_are_not_narrowed(monkeypatch, tmp_path):
    db = DocumentDeleteDBStub()
    document = document_row(tmp_path / "general" / "document.pdf", case_id=None)
    client = document_delete_client(monkeypatch, "lawyer", db, document)
    try:
        assert client.delete(f"/api/v1/documents/{document.id}").status_code == 200
        assert db.deleted == [document]
    finally:
        client.close()
        app.dependency_overrides.clear()


@pytest.mark.parametrize(
    "timezone_name,timestamp,expected_time",
    [
        ("UTC", "2026-09-18T14:30:00Z", "14:30"),
        ("Asia/Dhaka", "2026-09-18T14:30:00Z", "20:30"),
        ("America/New_York", "2026-09-18T14:30:00Z", "10:30"),
    ],
)
def test_task_due_helper_splits_combines_and_avoids_date_drift(timezone_name, timestamp, expected_time):
    script = f"""
      import {{ combineTaskDueDateTime, splitTaskDueDateTime }} from './lib/taskDueDateTime.js';
      const timed = splitTaskDueDateTime('{timestamp}');
      const dateOnlyIso = combineTaskDueDateTime('2026-09-18', '');
      const dateOnly = splitTaskDueDateTime(dateOnlyIso);
      const changedTime = splitTaskDueDateTime(combineTaskDueDateTime('2026-09-18', '14:30'));
      console.log(JSON.stringify({{ timed, dateOnly, changedTime }}));
    """
    env = {**os.environ, "TZ": timezone_name}
    result = subprocess.run(
        ["node", "--experimental-default-type=module", "--input-type=module", "-e", script],
        cwd=REPO_ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    assert payload["timed"] == {"due_date": "2026-09-18", "due_time": expected_time}
    assert payload["dateOnly"] == {"due_date": "2026-09-18", "due_time": ""}
    assert payload["changedTime"] == {"due_date": "2026-09-18", "due_time": "14:30"}


def test_task_and_precedent_frontend_archive_workflows_are_absent():
    tasks_list = (REPO_ROOT / "app/dashboard/tasks/page.jsx").read_text()
    tasks_detail = (REPO_ROOT / "app/dashboard/tasks/[id]/page.jsx").read_text()
    precedents = (REPO_ROOT / "app/dashboard/precedents/page.jsx").read_text()
    assert '"archived", "Archived"' not in tasks_list
    assert "include_archived=true" not in tasks_list
    assert ">Archive<" not in tasks_list + tasks_detail + precedents
    assert ">Restore<" not in tasks_list + tasks_detail + precedents
    assert "Include archived" not in precedents


def test_task_due_controls_and_case_document_delete_flow_are_separate_and_targeted():
    tasks_list = (REPO_ROOT / "app/dashboard/tasks/page.jsx").read_text()
    tasks_detail = (REPO_ROOT / "app/dashboard/tasks/[id]/page.jsx").read_text()
    case_detail = (REPO_ROOT / "app/dashboard/cases/[id]/page.jsx").read_text()
    assert tasks_list.count("Due Time (optional)") == 1
    assert tasks_detail.count("Due Time (optional)") == 1
    assert 'type="time" value={form.due_time}' in tasks_list + tasks_detail
    assert "includeTime\n                  value={form.due_date}" not in tasks_list + tasks_detail
    assert "dueUnchanged ? form.original_due_date" in tasks_detail
    assert "Select a Due Time to use a reminder relative to the task due time." in tasks_list
    assert "current.filter((doc) => Number(doc.id) !== Number(deletedId))" in case_detail
    assert "Are you sure you want to delete this document from this case/file? This action cannot be undone." in case_detail
    assert 'currentUser?.role === "admin" || currentUser?.role === "partner"' in case_detail
