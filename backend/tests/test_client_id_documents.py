from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import AsyncIterator

from fastapi.testclient import TestClient

from app.api import deps as deps_module
from app.api.v1 import clients as clients_module
from app.api.v1 import documents as documents_module
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


class ClientDocsDBStub:
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
        return None

    async def refresh(self, obj):
        return None

    async def delete(self, obj):
        self.deleted.append(obj)


def build_client(role: str, db: ClientDocsDBStub, org_id: int = 1):
    user = DummyUser(id=10, organization_id=org_id, name=f"{role} user", email="u@example.com", role=UserRole(role))

    async def _get_current_user():
        return user

    async def _get_db() -> AsyncIterator[ClientDocsDBStub]:
        yield db

    app.dependency_overrides[deps_module.get_current_user] = _get_current_user
    app.dependency_overrides[deps_module.get_db] = _get_db
    return TestClient(app)


def cleanup(client: TestClient):
    client.close()
    app.dependency_overrides.clear()


def _client_obj(client_id=7, org_id=1):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(id=client_id, organization_id=org_id, name="Client A", created_at=now, updated_at=now)


def _doc_obj(doc_id=41, client_id=7, org_id=1, path="/tmp/f.pdf"):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=doc_id,
        organization_id=org_id,
        case_id=None,
        client_id=client_id,
        uploaded_by=10,
        title="ID Document - id.pdf",
        description="Client identity document",
        file_name="id.pdf",
        file_path=path,
        file_type="application/pdf",
        file_size=123,
        category="client_id",
        visibility="internal",
        version=1,
        created_at=now,
        updated_at=now,
    )


def test_upload_client_id_document_success_for_staff(monkeypatch):
    client_row = _client_obj()
    db = ClientDocsDBStub(scalar_values=[client_row])
    client = build_client("partner", db)

    with TemporaryDirectory() as tmpdir:
        monkeypatch.setattr(clients_module, "STORAGE_ROOT", Path(tmpdir))
        try:
            res = client.post(
                "/api/v1/clients/7/id-documents",
                files={"file": ("id.pdf", b"%PDF-1.4 sample", "application/pdf")},
            )
            assert res.status_code == 200
            body = res.json()
            assert body["client_id"] == 7
            assert body["category"] == "client_id"
            assert body["file_name"] == "id.pdf"
            assert body["client_id_type"] == "other"
        finally:
            cleanup(client)


def test_multiple_typed_client_ids_are_preserved_and_listed(monkeypatch):
    client_row = _client_obj()
    db = ClientDocsDBStub(scalar_values=[client_row, client_row, client_row, client_row])
    client = build_client("partner", db)

    with TemporaryDirectory() as tmpdir:
        monkeypatch.setattr(clients_module, "STORAGE_ROOT", Path(tmpdir))
        try:
            uploads = [
                ("national_id", "national.pdf"),
                ("passport", "passport.pdf"),
                ("trn", "trn.pdf"),
            ]
            for id_type, file_name in uploads:
                response = client.post(
                    "/api/v1/clients/7/id-documents",
                    data={"id_type": id_type},
                    files={"file": (file_name, f"%PDF-{id_type}".encode(), "application/pdf")},
                )
                assert response.status_code == 200

            created = [row for row in db.added if getattr(row, "category", None) == "client_id"]
            assert len(created) == 3
            assert [row.client_id for row in created] == [7, 7, 7]
            assert len({row.file_path for row in created}) == 3
            db.scalars_values.append(created)

            listed = client.get("/api/v1/clients/7/id-documents")
            assert listed.status_code == 200
            body = listed.json()
            assert {row["client_id_type"] for row in body} == {"national_id", "passport", "trn"}
            assert {row["file_name"] for row in body} == {"national.pdf", "passport.pdf", "trn.pdf"}
        finally:
            cleanup(client)


def test_client_id_view_serves_exact_file_inline_and_guesses_mime(monkeypatch, tmp_path):
    stored = tmp_path / "1" / "client_ids" / "7" / "stored.pdf"
    stored.parent.mkdir(parents=True)
    stored.write_bytes(b"%PDF-exact-client-id")
    client_row = _client_obj()
    doc_row = _doc_obj(path=str(stored))
    doc_row.file_type = "application/octet-stream"
    db = ClientDocsDBStub(scalar_values=[client_row, doc_row])
    client = build_client("partner", db)
    monkeypatch.setattr(clients_module, "STORAGE_ROOT", tmp_path)
    try:
        response = client.get("/api/v1/clients/7/id-documents/41/view")
        assert response.status_code == 200
        assert response.content == b"%PDF-exact-client-id"
        assert response.headers["content-type"].startswith("application/pdf")
        assert response.headers["content-disposition"].startswith("inline")
    finally:
        cleanup(client)


def test_client_id_view_missing_underlying_file_is_controlled_404(monkeypatch, tmp_path):
    client_row = _client_obj()
    doc_row = _doc_obj(path=str(tmp_path / "1" / "missing.pdf"))
    db = ClientDocsDBStub(scalar_values=[client_row, doc_row])
    client = build_client("partner", db)
    monkeypatch.setattr(clients_module, "STORAGE_ROOT", tmp_path)
    try:
        response = client.get("/api/v1/clients/7/id-documents/41/view")
        assert response.status_code == 404
        assert response.json()["detail"] == "Stored file not found"
    finally:
        cleanup(client)


def test_unassigned_paralegal_cannot_view_client_id(monkeypatch, tmp_path):
    stored = tmp_path / "1" / "stored.pdf"
    stored.parent.mkdir(parents=True)
    stored.write_bytes(b"%PDF-protected")
    db = ClientDocsDBStub(scalar_values=[_client_obj(), _doc_obj(path=str(stored)), None, None])
    client = build_client("paralegal", db)
    monkeypatch.setattr(clients_module, "STORAGE_ROOT", tmp_path)
    try:
        response = client.get("/api/v1/clients/7/id-documents/41/view")
        assert response.status_code == 403
    finally:
        cleanup(client)


def test_list_client_id_documents_scoped_to_client_org():
    client_row = _client_obj()
    doc_row = _doc_obj(client_id=7)
    db = ClientDocsDBStub(scalar_values=[client_row], scalars_values=[[doc_row]])
    client = build_client("lawyer", db)
    try:
        res = client.get("/api/v1/clients/7/id-documents")
        assert res.status_code == 200
        body = res.json()
        assert len(body) == 1
        assert body[0]["client_id"] == 7
    finally:
        cleanup(client)


def test_download_client_id_document_cross_org_blocked_404():
    db = ClientDocsDBStub(scalar_values=[None])
    client = build_client("admin", db)
    try:
        res = client.get("/api/v1/clients/999/id-documents/41/download")
        assert res.status_code == 404
    finally:
        cleanup(client)


def test_delete_client_id_document_cross_org_blocked_404():
    client_row = _client_obj(client_id=7, org_id=1)
    db = ClientDocsDBStub(scalar_values=[client_row, None])
    client = build_client("admin", db)
    try:
        res = client.delete("/api/v1/clients/7/id-documents/999")
        assert res.status_code == 404
    finally:
        cleanup(client)


def test_client_role_cannot_upload_or_delete_client_id_documents():
    db = ClientDocsDBStub()
    client = build_client("client", db)
    try:
        upload = client.post(
            "/api/v1/clients/7/id-documents",
            files={"file": ("id.pdf", b"%PDF", "application/pdf")},
        )
        delete = client.delete("/api/v1/clients/7/id-documents/41")
        assert upload.status_code == 403
        assert delete.status_code == 403
    finally:
        cleanup(client)


def test_upload_rejects_unsupported_file_type(monkeypatch):
    client_row = _client_obj()
    db = ClientDocsDBStub(scalar_values=[client_row])
    client = build_client("partner", db)
    with TemporaryDirectory() as tmpdir:
        monkeypatch.setattr(clients_module, "STORAGE_ROOT", Path(tmpdir))
        try:
            res = client.post(
                "/api/v1/clients/7/id-documents",
                files={"file": ("script.exe", b"MZ...", "application/octet-stream")},
            )
            assert res.status_code == 400
        finally:
            cleanup(client)


def test_existing_case_document_upload_flow_still_works(monkeypatch):
    db = ClientDocsDBStub()
    client = build_client("partner", db)
    with TemporaryDirectory() as tmpdir:
        monkeypatch.setattr(documents_module, "STORAGE_ROOT", Path(tmpdir))
        try:
            res = client.post(
                "/api/v1/documents/upload",
                data={"title": "Case Doc", "visibility": "internal"},
                files={"file": ("memo.pdf", b"%PDF-case", "application/pdf")},
            )
            assert res.status_code == 200
            body = res.json()
            assert body["file_name"] == "memo.pdf"
            assert body["case_id"] is None
        finally:
            cleanup(client)


def test_document_upload_can_link_direct_client(monkeypatch):
    client_row = _client_obj()
    db = ClientDocsDBStub(scalar_values=[client_row])
    client = build_client("partner", db)
    with TemporaryDirectory() as tmpdir:
        monkeypatch.setattr(documents_module, "STORAGE_ROOT", Path(tmpdir))
        try:
            res = client.post(
                "/api/v1/documents/upload",
                data={"title": "Client Doc", "visibility": "internal", "client_id": "7"},
                files={"file": ("memo.pdf", b"%PDF-client", "application/pdf")},
            )
            assert res.status_code == 200
            body = res.json()
            assert body["client_id"] == 7
            assert body["case_id"] is None
        finally:
            cleanup(client)


def test_authorized_document_preview_serves_exact_file_inline(monkeypatch, tmp_path):
    stored = tmp_path / "1" / "stored.png"
    stored.parent.mkdir(parents=True)
    stored.write_bytes(b"PNG-exact-document")
    doc_row = _doc_obj(path=str(stored))
    doc_row.file_name = "evidence.png"
    doc_row.file_type = "application/octet-stream"
    doc_row.category = "evidence"
    db = ClientDocsDBStub(scalar_values=[doc_row])
    client = build_client("lawyer", db)
    monkeypatch.setattr(documents_module, "STORAGE_ROOT", tmp_path)
    try:
        response = client.get("/api/v1/documents/41/view")
        assert response.status_code == 200
        assert response.content == b"PNG-exact-document"
        assert response.headers["content-type"].startswith("image/png")
        assert response.headers["content-disposition"].startswith("inline")
    finally:
        cleanup(client)


def test_authorized_pdf_preview_returns_valid_bytes_type_and_filename(monkeypatch, tmp_path):
    pdf_bytes = b"%PDF-1.7\n% VILO preview fixture\n%%EOF\n"
    stored = tmp_path / "1" / "stored.pdf"
    stored.parent.mkdir(parents=True)
    stored.write_bytes(pdf_bytes)
    doc_row = _doc_obj(path=str(stored))
    doc_row.file_name = "signed agreement.pdf"
    doc_row.file_type = "application/octet-stream"
    db = ClientDocsDBStub(scalar_values=[doc_row])
    client = build_client("lawyer", db)
    monkeypatch.setattr(documents_module, "STORAGE_ROOT", tmp_path)
    try:
        response = client.get("/api/v1/documents/41/view")
        assert response.status_code == 200
        assert response.content == pdf_bytes
        assert response.content.startswith(b"%PDF-")
        assert response.headers["content-type"].startswith("application/pdf")
        disposition = response.headers["content-disposition"]
        assert disposition.startswith("inline")
        assert "signed%20agreement.pdf" in disposition
    finally:
        cleanup(client)


def test_document_preview_missing_file_is_controlled_404(monkeypatch, tmp_path):
    doc_row = _doc_obj(path=str(tmp_path / "1" / "missing.pdf"))
    doc_row.category = "evidence"
    client = build_client("admin", ClientDocsDBStub(scalar_values=[doc_row]))
    monkeypatch.setattr(documents_module, "STORAGE_ROOT", tmp_path)
    try:
        response = client.get("/api/v1/documents/41/view")
        assert response.status_code == 404
        assert response.json()["detail"] == "Stored file not found"
    finally:
        cleanup(client)


def test_cross_org_document_preview_is_non_disclosing_404():
    client = build_client("admin", ClientDocsDBStub(scalar_values=[None]), org_id=2)
    try:
        assert client.get("/api/v1/documents/41/view").status_code == 404
    finally:
        cleanup(client)


def test_client_role_cannot_preview_internal_document():
    client = build_client("client", ClientDocsDBStub())
    try:
        assert client.get("/api/v1/documents/41/view").status_code == 403
    finally:
        cleanup(client)


def test_paralegal_document_scope_includes_client_and_case_assignments():
    user = DummyUser(id=10, organization_id=1, name="Paralegal", email="p@example.com", role=UserRole.paralegal)
    condition = str(documents_module.accessible_document_condition(user))
    assert "client_assignments" in condition
    assert "case_assignments" in condition
