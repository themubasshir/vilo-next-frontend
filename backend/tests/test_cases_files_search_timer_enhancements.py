from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

from fastapi import HTTPException

from app.api.v1 import cases as cases_api
from app.api.v1 import documents as documents_api
from app.api.v1 import search as search_api
from app.api.v1 import time_entries as time_api
from app.models.case import CasePriority, CaseStatus
from app.models.enums import RecordStatus, UserRole
from app.schemas.time_entry import TimerStartRequest, TimerUpdateRequest


def user(role: str = "paralegal", *, user_id: int = 7, org_id: int = 11):
    return SimpleNamespace(id=user_id, organization_id=org_id, role=UserRole(role), status=RecordStatus.active, name="Staff")


class Rows:
    def __init__(self, values):
        self.values = values

    def all(self):
        return self.values


def case_row(status: CaseStatus = CaseStatus.archived):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=21, organization_id=11, title="Archived Appeal", description=None, client_id=31,
        status=status, priority=CasePriority.medium, created_by=7, assignments=[],
        client=SimpleNamespace(name="Acme Client"), created_at=now, updated_at=now,
    )


class CaseQueryDB:
    def __init__(self):
        self.queries = []

    async def scalar(self, query):
        self.queries.append(str(query))
        return 1

    async def scalars(self, query):
        self.queries.append(str(query))
        return Rows([case_row()])

    async def execute(self, query):
        self.queries.append(str(query))
        return Rows([(CaseStatus.active, 2), (CaseStatus.closed, 1), (CaseStatus.archived, 1)])


def test_cases_filters_compose_and_archived_is_separate_from_closed():
    db = CaseQueryDB()
    response = asyncio.run(cases_api.query_cases(
        search="C-21", status_filter="archived", assigned_user_id=7, client_id=31,
        created_from=date(2026, 1, 1), created_to=date(2026, 12, 31), page=1, per_page=10,
        db=db, current_user=user(),
    ))
    assert response.items[0].status == "archived"
    assert {row.status: row.count for row in response.counts} == {"active": 2, "closed": 1, "archived": 1}
    sql = "\n".join(db.queries).lower()
    assert "organization_id" in sql
    assert "case_assignments" in sql
    assert "cases.status" in sql
    assert "cases.client_id" in sql
    assert "cases.created_at" in sql


def document_row():
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=55, organization_id=11, case_id=21, client_id=31, uploaded_by=7,
        title="Motion", description=None, file_name="motion.pdf", file_type="application/pdf",
        file_size=100, category="case_files", visibility="internal", version=1,
        version_source="upload", version_note=None, created_at=now, updated_at=now,
        case=SimpleNamespace(title="Archived Appeal"), client=SimpleNamespace(name="Acme Client"),
        uploader=SimpleNamespace(name="Staff"),
    )


class DocumentQueryDB:
    def __init__(self):
        self.queries = []

    async def scalar(self, query):
        self.queries.append(str(query))
        return 1

    async def scalars(self, query):
        self.queries.append(str(query))
        return Rows([document_row()])


def test_files_filters_are_server_side_and_case_access_scoped():
    db = DocumentQueryDB()
    response = asyncio.run(documents_api.query_documents(
        document_id=None, search="motion", case_id=21, client_id=31, category="case_files",
        file_type="pdf", uploaded_by=7, created_from=date(2026, 1, 1), created_to=date(2026, 12, 31),
        visibility="internal", exclude_client_ids=True, sort_by="updated", page=1, per_page=10, db=db, current_user=user(),
    ))
    assert response.total == 1
    assert response.items[0].case_title == "Archived Appeal"
    sql = "\n".join(db.queries).lower()
    assert "documents.organization_id" in sql
    assert "case_assignments" in sql
    assert "documents.uploaded_by" in sql
    assert "documents.file_type" in sql
    assert "documents.category IS NULL" in "\n".join(db.queries)
    assert "documents.category !=" in "\n".join(db.queries)


class SearchDB:
    def __init__(self):
        self.queries = []

    async def execute(self, query):
        self.queries.append(str(query))
        return Rows([])


def test_global_search_queries_are_tenant_and_record_access_scoped():
    db = SearchDB()
    result = asyncio.run(search_api.global_search(q="acme", limit=5, db=db, current_user=user()))
    assert result.groups == {}
    sql = "\n".join(db.queries).lower()
    assert sql.count("organization_id") >= 6
    assert "case_assignments" in sql
    assert "documents.case_id" in sql
    assert "invoices.case_id" in sql


class TimerDB:
    def __init__(self):
        self.added = []
        self.deleted = []

    def add(self, value):
        self.added.append(value)
        if getattr(value, "id", None) is None:
            value.id = len(self.added)

    async def delete(self, value):
        self.deleted.append(value)

    async def commit(self):
        return None

    async def rollback(self):
        return None

    async def flush(self):
        return None


def test_timer_prevents_a_second_active_timer(monkeypatch):
    async def existing(*_args, **_kwargs):
        return SimpleNamespace(id=1)

    monkeypatch.setattr(time_api, "_get_active_timer", existing)
    try:
        asyncio.run(time_api.start_timer(TimerStartRequest(billable=False), db=TimerDB(), current_user=user()))
    except HTTPException as exc:
        assert exc.status_code == 409
    else:
        raise AssertionError("Expected duplicate timer rejection")


def test_stopping_timer_creates_owned_time_entry_once(monkeypatch):
    now = datetime.now(timezone.utc)
    timer = SimpleNamespace(
        id=1, organization_id=11, user_id=7, case_id=None, client_id=None,
        description="Research", billing_type="non_billable", currency="USD", is_paused=False,
        started_at=now - timedelta(minutes=8), paused_at=None, paused_seconds=0,
        created_at=now, updated_at=now, case=None, client=None,
    )

    async def active(*_args, **_kwargs):
        return timer

    async def resolved_entry(_db, _org_id, entry_id):
        entry = next(value for value in db.added if value.__class__.__name__ == "TimeEntry")
        fields = {name: getattr(entry, name) for name in (
            "id", "organization_id", "case_id", "client_id", "user_id", "invoice_id",
            "description", "start_time", "end_time", "duration_minutes", "billing_type",
            "currency", "hourly_rate", "rate_is_manual", "amount", "status", "created_at", "updated_at",
        )}
        return SimpleNamespace(**fields, case=None, client=None, user=SimpleNamespace(name="Staff"), invoice=None)

    monkeypatch.setattr(time_api, "_get_active_timer", active)
    monkeypatch.setattr(time_api, "_get_time_entry_or_404", resolved_entry)
    db = TimerDB()
    response = asyncio.run(time_api.stop_timer(TimerUpdateRequest(billable=False), db=db, current_user=user()))
    entries = [value for value in db.added if value.__class__.__name__ == "TimeEntry"]
    assert len(entries) == 1
    assert entries[0].user_id == 7 and entries[0].organization_id == 11
    assert entries[0].duration_minutes >= 8
    assert response.status == "non_billable"
    assert db.deleted == [timer]
