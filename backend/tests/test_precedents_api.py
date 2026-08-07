from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from app.api import deps as deps_module
from app.api.v1 import precedents as precedents_module
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


class PrecedentDBStub:
    def __init__(self, scalar_values=None, scalars_values=None):
        self.scalar_values = list(scalar_values or [])
        self.scalars_values = list(scalars_values or [])
        self.added = []
        self.deleted = []

    async def scalar(self, query, *args, **kwargs):
        assert "organization_id" in str(query)
        if self.scalar_values:
            return self.scalar_values.pop(0)
        return None

    async def scalars(self, query, *args, **kwargs):
        assert "organization_id" in str(query)
        rows = self.scalars_values.pop(0) if self.scalars_values else []
        query_str = str(query)
        if "precedents.is_archived IS false" in query_str:
            rows = [row for row in rows if not getattr(row, "is_archived", False)]

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
        await self.flush()

    async def rollback(self):
        return None

    async def refresh(self, obj):
        return None

    async def delete(self, obj):
        self.deleted.append(obj)


def build_client(role: str, db: PrecedentDBStub, org_id: int = 1):
    user = DummyUser(id=10, organization_id=org_id, name=f"{role} user", email="u@example.com", role=UserRole(role))

    async def _get_current_user():
        return user

    async def _get_db() -> AsyncIterator[PrecedentDBStub]:
        yield db

    app.dependency_overrides[deps_module.get_current_user] = _get_current_user
    app.dependency_overrides[deps_module.get_db] = _get_db
    return TestClient(app)


def cleanup(client: TestClient):
    client.close()
    app.dependency_overrides.clear()


def _precedent_obj(
    precedent_id=21,
    org_id=1,
    *,
    is_archived=False,
    file_path: str | None = None,
    file_name: str | None = None,
    content_text: str | None = "Master text",
):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=precedent_id,
        organization_id=org_id,
        name="Employment Motion",
        description="Template",
        practice_area="employment",
        document_type="motion",
        tags=["urgent", "federal"],
        content_text=content_text,
        file_path=file_path,
        file_name=file_name,
        file_type="application/pdf" if file_name else None,
        file_size=120 if file_name else None,
        created_by_id=10,
        created_by=SimpleNamespace(name="Partner User"),
        updated_by_id=10,
        updated_by=SimpleNamespace(name="Partner User"),
        is_archived=is_archived,
        created_at=now,
        updated_at=now,
        archived_at=now if is_archived else None,
    )


def _case_obj(case_id=31, org_id=1, client_id=41):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=case_id,
        organization_id=org_id,
        client_id=client_id,
        title="Matter A",
        created_at=now,
        updated_at=now,
    )


def _practice_area_obj(area_id=61, org_id=1, name="Technology Law"):
    return SimpleNamespace(
        id=area_id,
        organization_id=org_id,
        name=name,
        normalized_name=name.casefold(),
        created_by=10,
        created_at=datetime.now(timezone.utc),
    )


@pytest.fixture(autouse=True)
def stub_side_effects(monkeypatch):
    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(precedents_module, "log_audit_event", _noop)
    monkeypatch.setattr(precedents_module, "create_case_timeline_event", _noop)


def test_partner_can_create_precedent():
    row = _precedent_obj()
    db = PrecedentDBStub(scalar_values=[row])
    client = build_client("partner", db)
    try:
        res = client.post(
            "/api/v1/precedents",
            json={
                "name": "Employment Motion",
                "description": "Template",
                "practice_area": "employment",
                "document_type": "motion",
                "tags": ["urgent", "federal"],
                "content_text": "Master text",
            },
        )
        assert res.status_code == 200
        body = res.json()
        assert body["name"] == "Employment Motion"
        assert body["content_text"] == "Master text"
        precedent = db.added[0]
        assert precedent.organization_id == 1
    finally:
        cleanup(client)


def test_lawyer_cannot_create_master_precedent():
    db = PrecedentDBStub()
    client = build_client("lawyer", db)
    try:
        res = client.post(
            "/api/v1/precedents",
            json={"name": "X", "practice_area": "civil", "document_type": "motion"},
        )
        assert res.status_code == 403
    finally:
        cleanup(client)


def test_partner_can_create_and_immediately_retrieve_tenant_practice_area():
    db = PrecedentDBStub(scalar_values=[None])
    client = build_client("partner", db)
    try:
        created = client.post("/api/v1/precedents/practice-areas", json={"name": "  Technology   Law  "})
        assert created.status_code == 201
        assert created.json()["name"] == "Technology Law"
        area = db.added[0]
        assert area.organization_id == 1
        assert area.normalized_name == "technology law"

        db.scalars_values.append([area])
        listed = client.get("/api/v1/precedents/practice-areas")
        assert listed.status_code == 200
        assert listed.json() == [{"id": area.id, "name": "Technology Law"}]
    finally:
        cleanup(client)


def test_practice_area_duplicate_is_case_insensitive_and_tenant_scoped():
    existing = _practice_area_obj(name="Technology Law")
    db = PrecedentDBStub(scalar_values=[existing])
    client = build_client("admin", db, org_id=1)
    try:
        duplicate = client.post("/api/v1/precedents/practice-areas", json={"name": "technology law"})
        assert duplicate.status_code == 409
        assert duplicate.json()["detail"] == "That practice area already exists"
        assert db.added == []
    finally:
        cleanup(client)

    other_tenant_db = PrecedentDBStub(scalar_values=[None])
    client = build_client("admin", other_tenant_db, org_id=2)
    try:
        created = client.post("/api/v1/precedents/practice-areas", json={"name": "Technology Law"})
        assert created.status_code == 201
        assert other_tenant_db.added[0].organization_id == 2
    finally:
        cleanup(client)


def test_lawyer_cannot_create_practice_area():
    db = PrecedentDBStub()
    client = build_client("lawyer", db)
    try:
        assert client.post("/api/v1/precedents/practice-areas", json={"name": "Technology Law"}).status_code == 403
    finally:
        cleanup(client)


def test_new_practice_area_name_can_be_assigned_to_precedent_and_legacy_category_serializes():
    custom = _precedent_obj()
    custom.practice_area = "Technology Law"
    db = PrecedentDBStub(scalar_values=[custom])
    client = build_client("partner", db)
    try:
        response = client.post(
            "/api/v1/precedents",
            json={
                "name": "Technology Agreement",
                "practice_area": "Technology Law",
                "document_type": "agreement",
                "content_text": "Terms",
            },
        )
        assert response.status_code == 200
        assert response.json()["practice_area"] == "Technology Law"
        assert db.added[0].practice_area == "Technology Law"
    finally:
        cleanup(client)

    legacy = _precedent_obj()
    legacy.practice_area = "employment"
    db = PrecedentDBStub(scalars_values=[[legacy]])
    client = build_client("paralegal", db)
    try:
        listed = client.get("/api/v1/precedents")
        assert listed.status_code == 200
        assert listed.json()["items"][0]["practice_area"] == "employment"
    finally:
        cleanup(client)


def test_client_cannot_access_precedents():
    db = PrecedentDBStub()
    client = build_client("client", db)
    try:
        assert client.get("/api/v1/precedents").status_code == 403
        assert client.get("/api/v1/precedents/1").status_code == 403
        assert client.post("/api/v1/precedents/1/copy-to-case", json={"case_id": 3}).status_code == 403
    finally:
        cleanup(client)


def test_list_search_is_org_scoped_and_tag_filtered():
    rows = [
        _precedent_obj(precedent_id=1),
        _precedent_obj(precedent_id=2, is_archived=True),
        _precedent_obj(precedent_id=3, content_text="Different", file_path=None),
    ]
    rows[2].tags = ["contracts"]
    db = PrecedentDBStub(scalars_values=[rows, rows])
    client = build_client("paralegal", db)
    try:
        res = client.get("/api/v1/precedents?tag=urgent")
        assert res.status_code == 200
        body = res.json()
        assert body["total"] == 1
        assert body["items"][0]["id"] == 1

        archived = client.get("/api/v1/precedents?include_archived=true")
        assert archived.status_code == 200
        archived_body = archived.json()
        assert archived_body["total"] == 3
    finally:
        cleanup(client)


def test_cross_org_precedent_access_blocked():
    db = PrecedentDBStub(scalar_values=[None])
    client = build_client("lawyer", db)
    try:
        res = client.get("/api/v1/precedents/999")
        assert res.status_code == 404
    finally:
        cleanup(client)


def test_partner_can_update_master_precedent():
    row = _precedent_obj()
    updated = _precedent_obj()
    updated.content_text = "Updated text"
    db = PrecedentDBStub(scalar_values=[row, updated])
    client = build_client("admin", db)
    try:
        res = client.patch("/api/v1/precedents/21", json={"content_text": "Updated text", "tags": ["revised"]})
        assert res.status_code == 200
        body = res.json()
        assert body["content_text"] == "Updated text"
        assert db.added == []
        assert row.content_text == "Updated text"
        assert row.tags == ["revised"]
    finally:
        cleanup(client)


def test_lawyer_cannot_update_master_precedent():
    db = PrecedentDBStub()
    client = build_client("lawyer", db)
    try:
        res = client.patch("/api/v1/precedents/21", json={"name": "Changed"})
        assert res.status_code == 403
    finally:
        cleanup(client)


def test_archive_hides_precedent_from_default_list():
    active = _precedent_obj(precedent_id=1)
    archived = _precedent_obj(precedent_id=2, is_archived=True)
    db = PrecedentDBStub(scalar_values=[active, archived], scalars_values=[[active, archived]])
    client = build_client("partner", db)
    try:
        archive = client.post("/api/v1/precedents/1/archive")
        assert archive.status_code == 200
        assert archive.json()["is_archived"] is True

        listed = client.get("/api/v1/precedents")
        assert listed.status_code == 200
        body = listed.json()
        assert body["total"] == 0
    finally:
        cleanup(client)


def test_partner_can_upload_and_staff_can_download_file_without_exposing_raw_path(monkeypatch):
    with TemporaryDirectory() as tmpdir:
        stored_row = _precedent_obj(precedent_id=51, file_path=str(Path(tmpdir) / "1" / "stored.pdf"), file_name="stored.pdf", content_text=None)
        Path(stored_row.file_path).parent.mkdir(parents=True, exist_ok=True)
        Path(stored_row.file_path).write_bytes(b"%PDF-1.4 precedent")
        db = PrecedentDBStub(scalar_values=[stored_row, stored_row])
        client = build_client("partner", db)
        monkeypatch.setattr(precedents_module, "PRECEDENT_STORAGE_ROOT", Path(tmpdir))
        try:
            res = client.post(
                "/api/v1/precedents/upload",
                data={"practice_area": "employment", "document_type": "motion", "tags": "urgent,federal", "name": "Stored"},
                files={"file": ("stored.pdf", b"%PDF-1.4 precedent", "application/pdf")},
            )
            assert res.status_code == 200
            body = res.json()
            assert body["file_name"] == "stored.pdf"
            assert "file_path" not in body
            assert body["has_file"] is True

            download = client.get("/api/v1/precedents/51/download")
            assert download.status_code == 200
            assert download.content == b"%PDF-1.4 precedent"
        finally:
            cleanup(client)


def test_precedent_view_serves_exact_file_inline_with_inferred_mime(monkeypatch, tmp_path):
    stored = tmp_path / "1" / "legacy.pdf"
    stored.parent.mkdir(parents=True)
    stored.write_bytes(b"%PDF-exact-precedent")
    row = _precedent_obj(precedent_id=52, file_path=str(stored), file_name="legacy.pdf", content_text=None)
    row.file_type = "application/octet-stream"
    client = build_client("lawyer", PrecedentDBStub(scalar_values=[row]))
    monkeypatch.setattr(precedents_module, "PRECEDENT_STORAGE_ROOT", tmp_path)
    try:
        response = client.get("/api/v1/precedents/52/view")
        assert response.status_code == 200
        assert response.content == b"%PDF-exact-precedent"
        assert response.headers["content-type"].startswith("application/pdf")
        assert response.headers["content-disposition"].startswith("inline")
    finally:
        cleanup(client)


def test_precedent_view_missing_file_is_controlled_404(monkeypatch, tmp_path):
    row = _precedent_obj(
        precedent_id=53,
        file_path=str(tmp_path / "1" / "missing.pdf"),
        file_name="missing.pdf",
        content_text=None,
    )
    client = build_client("partner", PrecedentDBStub(scalar_values=[row]))
    monkeypatch.setattr(precedents_module, "PRECEDENT_STORAGE_ROOT", tmp_path)
    try:
        response = client.get("/api/v1/precedents/53/view")
        assert response.status_code == 404
        assert response.json()["detail"] == "Stored file not found"
    finally:
        cleanup(client)


def test_client_role_cannot_preview_precedent_file():
    client = build_client("client", PrecedentDBStub())
    try:
        assert client.get("/api/v1/precedents/52/view").status_code == 403
    finally:
        cleanup(client)


def test_cross_org_precedent_file_preview_is_non_disclosing_404():
    client = build_client("admin", PrecedentDBStub(scalar_values=[None]), org_id=2)
    try:
        assert client.get("/api/v1/precedents/52/view").status_code == 404
    finally:
        cleanup(client)


def test_authorized_staff_can_copy_precedent_to_case(monkeypatch):
    with TemporaryDirectory() as tmpdir:
        source_path = Path(tmpdir) / "source.pdf"
        source_path.write_bytes(b"MASTER_BINARY")
        precedent = _precedent_obj(precedent_id=9, file_path=str(source_path), file_name="source.pdf", content_text="Master text")
        case = _case_obj(case_id=77)
        db = PrecedentDBStub(scalar_values=[precedent, case])
        client = build_client("lawyer", db)
        monkeypatch.setattr(precedents_module, "DOCUMENT_STORAGE_ROOT", Path(tmpdir))
        try:
            res = client.post("/api/v1/precedents/9/copy-to-case", json={"case_id": 77, "name": "Filed Motion"})
            assert res.status_code == 200
            body = res.json()
            assert body["precedent_id"] == 9
            assert body["case_id"] == 77
            assert body["document"]["title"] == "Filed Motion"
            document = db.added[0]
            assert document.source_precedent_id == 9
            assert document.visibility == "internal"
            assert Path(document.file_path).read_bytes() == b"MASTER_BINARY"
            assert document.file_path != str(source_path)
        finally:
            cleanup(client)


def test_cross_org_case_copy_blocked(monkeypatch):
    precedent = _precedent_obj(precedent_id=9, content_text="Master text")
    db = PrecedentDBStub(scalar_values=[precedent, None])
    client = build_client("paralegal", db)
    with TemporaryDirectory() as tmpdir:
        monkeypatch.setattr(precedents_module, "DOCUMENT_STORAGE_ROOT", Path(tmpdir))
        try:
            res = client.post("/api/v1/precedents/9/copy-to-case", json={"case_id": 777})
            assert res.status_code == 404
        finally:
            cleanup(client)


@pytest.mark.asyncio
async def test_master_edit_after_copy_does_not_mutate_existing_copied_document(monkeypatch, tmp_path):
    source_path = tmp_path / "master.pdf"
    source_path.write_bytes(b"MASTER_V1")
    precedent = _precedent_obj(precedent_id=12, file_path=str(source_path), file_name="master.pdf", content_text="Master text")
    case = _case_obj(case_id=55)
    db = PrecedentDBStub(scalar_values=[precedent, case])
    user = DummyUser(id=10, organization_id=1, name="Lawyer", email="l@example.com", role=UserRole.lawyer)
    request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"), headers={})
    monkeypatch.setattr(precedents_module, "DOCUMENT_STORAGE_ROOT", tmp_path)

    result = await precedents_module.copy_precedent_to_case(
        precedent_id=12,
        payload=precedents_module.PrecedentCopyToCaseRequest(case_id=55, name="Case Copy"),
        request=request,
        db=db,
        current_user=user,
    )
    copied_document = db.added[0]
    copied_path = Path(copied_document.file_path)
    assert copied_path.read_bytes() == b"MASTER_V1"

    precedent.name = "Updated Master"
    precedent.content_text = "Changed later"
    source_path.write_bytes(b"MASTER_V2")

    assert result.document.title == "Case Copy"
    assert copied_document.description == "Copied from precedent: Employment Motion"
    assert copied_path.read_bytes() == b"MASTER_V1"


def test_text_only_precedent_copy_creates_usable_case_document(monkeypatch):
    with TemporaryDirectory() as tmpdir:
        precedent = _precedent_obj(precedent_id=13, file_path=None, file_name=None, content_text="Template clause")
        case = _case_obj(case_id=88)
        db = PrecedentDBStub(scalar_values=[precedent, case])
        client = build_client("paralegal", db)
        monkeypatch.setattr(precedents_module, "DOCUMENT_STORAGE_ROOT", Path(tmpdir))
        try:
            res = client.post("/api/v1/precedents/13/copy-to-case", json={"case_id": 88})
            assert res.status_code == 200
            body = res.json()
            assert body["document"]["file_name"].endswith(".txt")
            document = db.added[0]
            assert Path(document.file_path).read_text() == "Template clause"
        finally:
            cleanup(client)
