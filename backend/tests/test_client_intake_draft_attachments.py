from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

from app.api.v1 import clients as clients_api
from app.models.client import Client
from app.models.client_intake_draft_attachment import ClientIntakeDraftAttachment
from app.models.document import Document
from app.models.enums import UserRole
from app.schemas.client import ClientCreate


def user(*, user_id=7, organization_id=11, role=UserRole.paralegal):
    return SimpleNamespace(id=user_id, organization_id=organization_id, role=role, name="Asha Staff", email="asha@example.test")


def upload(name="identity.pdf", content=b"%PDF identity", content_type="application/pdf"):
    return UploadFile(filename=name, file=BytesIO(content), headers=Headers({"content-type": content_type}))


def attachment(path: Path, *, attachment_id=4, draft_id=3, organization_id=11):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=attachment_id,
        organization_id=organization_id,
        draft_id=draft_id,
        uploaded_by=7,
        file_name="identity.pdf",
        file_path=str(path),
        file_type="application/pdf",
        file_size=path.stat().st_size,
        created_at=now,
        updated_at=now,
    )


def draft(*, attachment_row=None, creator_id=7, organization_id=11):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=3,
        organization_id=organization_id,
        created_by=creator_id,
        payload={"first_name": "Asha"},
        attachment=attachment_row,
        created_at=now,
        updated_at=now,
    )


class DraftDB:
    def __init__(self, scalar_result=None, *, fail_commit=False):
        self.scalar_result = scalar_result
        self.fail_commit = fail_commit
        self.added = []
        self.deleted = []
        self.rolled_back = False

    async def scalar(self, query):
        return self.scalar_result

    async def execute(self, query):
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: []))

    def add(self, row):
        self.added.append(row)
        if isinstance(row, Client) and getattr(row, "id", None) is None:
            row.id = 101
        if isinstance(row, Document) and getattr(row, "id", None) is None:
            row.id = 202
        if isinstance(row, ClientIntakeDraftAttachment) and getattr(row, "id", None) is None:
            row.id = 303

    async def flush(self):
        return None

    async def commit(self):
        if self.fail_commit:
            raise RuntimeError("commit failed")

    async def rollback(self):
        self.rolled_back = True

    async def refresh(self, row):
        return None

    async def delete(self, row):
        self.deleted.append(row)


@pytest.mark.asyncio
async def test_save_draft_with_client_id_attachment(monkeypatch, tmp_path):
    intake = draft()
    db = DraftDB()
    monkeypatch.setattr(clients_api, "DRAFT_STORAGE_ROOT", tmp_path)

    async def get_draft(*_args, **_kwargs):
        return intake

    monkeypatch.setattr(clients_api, "get_intake_draft", get_draft)
    result = await clients_api.upload_intake_draft_attachment(
        draft_id=intake.id, file=upload(), db=db, current_user=user(),
    )

    assert result.file_name == "identity.pdf"
    assert result.file_size == len(b"%PDF identity")
    saved = next(row for row in db.added if isinstance(row, ClientIntakeDraftAttachment))
    assert Path(saved.file_path).read_bytes() == b"%PDF identity"
    assert saved.organization_id == 11


def test_reopen_draft_returns_attachment_metadata(tmp_path):
    stored = tmp_path / "identity.pdf"
    stored.write_bytes(b"identity")
    response = clients_api.serialize_intake_draft(draft(attachment_row=attachment(stored)))
    assert response.attachment is not None
    assert response.attachment.file_name == "identity.pdf"
    assert not hasattr(response.attachment, "file_path")


@pytest.mark.asyncio
async def test_secure_view_and_download_draft_attachment(monkeypatch, tmp_path):
    stored = tmp_path / "identity.pdf"
    stored.write_bytes(b"%PDF secure")
    intake = draft(attachment_row=attachment(stored))
    monkeypatch.setattr(clients_api, "DRAFT_STORAGE_ROOT", tmp_path)

    async def get_draft(*_args, **_kwargs):
        return intake

    monkeypatch.setattr(clients_api, "get_intake_draft", get_draft)
    view = await clients_api.view_intake_draft_attachment(intake.id, db=DraftDB(), current_user=user())
    download = await clients_api.download_intake_draft_attachment(intake.id, db=DraftDB(), current_user=user())
    assert Path(view.path).read_bytes() == b"%PDF secure"
    assert view.headers["content-disposition"].startswith("inline")
    assert download.headers["content-disposition"].startswith("attachment")


@pytest.mark.asyncio
async def test_unauthorized_draft_attachment_access_returns_403():
    db = DraftDB(scalar_result=draft(creator_id=99))
    with pytest.raises(HTTPException) as exc:
        await clients_api.get_intake_draft(db, 3, user())
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_cross_tenant_draft_attachment_access_is_hidden():
    db = DraftDB(scalar_result=None)
    with pytest.raises(HTTPException) as exc:
        await clients_api.get_intake_draft(db, 3, user())
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_replace_draft_attachment_removes_old_file_after_commit(monkeypatch, tmp_path):
    old_file = tmp_path / "old.pdf"
    old_file.write_bytes(b"old")
    existing = attachment(old_file)
    intake = draft(attachment_row=existing)
    monkeypatch.setattr(clients_api, "DRAFT_STORAGE_ROOT", tmp_path)

    async def get_draft(*_args, **_kwargs):
        return intake

    monkeypatch.setattr(clients_api, "get_intake_draft", get_draft)
    result = await clients_api.upload_intake_draft_attachment(
        intake.id, upload(content=b"new"), db=DraftDB(), current_user=user(),
    )
    assert result.file_size == 3
    assert not old_file.exists()
    assert Path(existing.file_path).read_bytes() == b"new"


@pytest.mark.asyncio
async def test_remove_draft_attachment_deletes_record_and_file(monkeypatch, tmp_path):
    stored = tmp_path / "identity.pdf"
    stored.write_bytes(b"identity")
    existing = attachment(stored)
    intake = draft(attachment_row=existing)
    db = DraftDB()
    monkeypatch.setattr(clients_api, "DRAFT_STORAGE_ROOT", tmp_path)

    async def get_draft(*_args, **_kwargs):
        return intake

    monkeypatch.setattr(clients_api, "get_intake_draft", get_draft)
    assert await clients_api.remove_intake_draft_attachment(intake.id, db=db, current_user=user()) == {"ok": True}
    assert existing in db.deleted
    assert not stored.exists()


@pytest.mark.asyncio
async def test_complete_draft_preserves_uploaded_id_as_client_document(monkeypatch, tmp_path):
    draft_root = tmp_path / "drafts"
    final_root = tmp_path / "documents"
    draft_root.mkdir()
    stored = draft_root / "identity.pdf"
    stored.write_bytes(b"%PDF final")
    intake = draft(attachment_row=attachment(stored))
    db = DraftDB()
    monkeypatch.setattr(clients_api, "DRAFT_STORAGE_ROOT", draft_root)
    monkeypatch.setattr(clients_api, "STORAGE_ROOT", final_root)

    async def get_draft(*_args, **_kwargs):
        return intake

    async def get_client(_db, _org_id, _client_id):
        return next(row for row in db.added if isinstance(row, Client))

    monkeypatch.setattr(clients_api, "get_intake_draft", get_draft)
    monkeypatch.setattr(clients_api, "get_client_for_org", get_client)
    result = await clients_api.complete_intake_draft(
        intake.id,
        ClientCreate(name="Asha Brown", email="asha@example.com"),
        include_attachment=True,
        db=db,
        current_user=user(),
    )

    document = next(row for row in db.added if isinstance(row, Document))
    assert result.id == 101
    assert document.client_id == 101
    assert document.category == "client_id"
    assert Path(document.file_path).read_bytes() == b"%PDF final"
    assert not stored.exists()
    assert intake in db.deleted


@pytest.mark.asyncio
async def test_discard_draft_cleans_up_temporary_attachment(monkeypatch, tmp_path):
    stored = tmp_path / "identity.pdf"
    stored.write_bytes(b"identity")
    intake = draft(attachment_row=attachment(stored))
    db = DraftDB()
    monkeypatch.setattr(clients_api, "DRAFT_STORAGE_ROOT", tmp_path)

    async def get_draft(*_args, **_kwargs):
        return intake

    monkeypatch.setattr(clients_api, "get_intake_draft", get_draft)
    assert await clients_api.discard_intake_draft(intake.id, db=db, current_user=user()) == {"ok": True}
    assert intake in db.deleted
    assert not stored.exists()


@pytest.mark.asyncio
async def test_failed_completion_keeps_draft_attachment(monkeypatch, tmp_path):
    draft_root = tmp_path / "drafts"
    final_root = tmp_path / "documents"
    draft_root.mkdir()
    stored = draft_root / "identity.pdf"
    stored.write_bytes(b"%PDF original")
    intake = draft(attachment_row=attachment(stored))
    db = DraftDB(fail_commit=True)
    monkeypatch.setattr(clients_api, "DRAFT_STORAGE_ROOT", draft_root)
    monkeypatch.setattr(clients_api, "STORAGE_ROOT", final_root)

    async def get_draft(*_args, **_kwargs):
        return intake

    monkeypatch.setattr(clients_api, "get_intake_draft", get_draft)
    with pytest.raises(RuntimeError, match="commit failed"):
        await clients_api.complete_intake_draft(
            intake.id,
            ClientCreate(name="Asha Brown", email="asha@example.com"),
            include_attachment=True,
            db=db,
            current_user=user(),
        )

    assert db.rolled_back is True
    assert stored.read_bytes() == b"%PDF original"
    final_files = list(final_root.rglob("*")) if final_root.exists() else []
    assert not [path for path in final_files if path.is_file()]
