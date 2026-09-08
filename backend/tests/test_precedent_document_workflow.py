"""Real async persistence and protected API regression tests for precedent copies."""
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZipFile

import httpx
import pytest
import pytest_asyncio
from docx import Document as WordDocument
from jose import jwt
from sqlalchemy import JSON, event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api import deps
from app.api.v1 import documents, precedents
from app.db.base import Base
from app.main import app
from app.models.audit_log import AuditLog
from app.models.case import Case, CaseAssignment
from app.models.case_timeline_event import CaseTimelineEvent
from app.models.client import Client, ClientAssignment
from app.models.document import Document
from app.models.document_version import DocumentVersion
from app.models.enums import UserRole
from app.models.organization import Organization
from app.models.practice_area import PracticeArea
from app.models.precedent import Precedent
from app.models.user import User
from app.services import document_storage


def assert_word(data, expected):
    with ZipFile(BytesIO(data)) as package:
        assert package.testzip() is None
        assert {"[Content_Types].xml", "_rels/.rels", "word/document.xml"} <= set(package.namelist())
    word = WordDocument(BytesIO(data))
    assert "\n".join(p.text for p in word.paragraphs) == expected


@pytest_asyncio.fixture
async def workflow(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'workflow.sqlite'}")

    @event.listens_for(engine.sync_engine, "connect")
    def foreign_keys(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")

    models = [Organization, User, Client, Case, CaseAssignment, ClientAssignment,
              Precedent, PracticeArea, Document, DocumentVersion, AuditLog, CaseTimelineEvent]
    # SQLite test representation only; production JSONB schema is unchanged.
    for model in (AuditLog, CaseTimelineEvent):
        monkeypatch.setattr(model.__table__.c.metadata, "type", JSON())
    # The ORM declares the audit organization index twice; migrations already
    # create it once. Deduplicate only this temporary test database's DDL.
    audit_indexes = {index.name: index for index in AuditLog.__table__.indexes}
    monkeypatch.setattr(AuditLog.__table__, "indexes", set(audit_indexes.values()))
    async with engine.begin() as connection:
        await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[m.__table__ for m in models]))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    now = datetime.now(timezone.utc)
    async with sessions() as db:
        for org_id in (1, 2):
            db.add(Organization(id=org_id, name=f"Firm {org_id}", slug=f"firm-{org_id}", created_at=now, updated_at=now))
        await db.flush()
        for user_id, org_id, role in ((1, 1, UserRole.partner), (2, 2, UserRole.partner), (3, 1, UserRole.paralegal)):
            db.add(User(id=user_id, organization_id=org_id, name=f"Staff {user_id}", email=f"staff{user_id}@example.com", hashed_password="unused", role=role, created_at=now, updated_at=now))
        await db.flush()
        for org_id in (1, 2):
            db.add(Client(id=org_id, organization_id=org_id, name=f"Client {org_id}", created_at=now, updated_at=now))
        await db.flush()
        for org_id in (1, 2):
            db.add(Case(id=org_id, organization_id=org_id, client_id=org_id, title=f"File {org_id}", created_by=org_id, created_at=now, updated_at=now))
        await db.commit()

    actor = {"id": 1}

    async def get_db():
        async with sessions() as db:
            yield db

    async def get_user():
        async with sessions() as db:
            return await db.get(User, actor["id"])

    app.dependency_overrides[deps.get_db] = get_db
    app.dependency_overrides[deps.get_current_user] = get_user
    monkeypatch.setattr(precedents, "PRECEDENT_STORAGE_ROOT", tmp_path / "precedents")
    monkeypatch.setattr(precedents, "DOCUMENT_STORAGE_ROOT", tmp_path / "documents")
    monkeypatch.setattr(documents, "STORAGE_ROOT", tmp_path / "documents")
    monkeypatch.setattr(document_storage, "REPOSITORY_ROOT", tmp_path)
    monkeypatch.setattr(documents.settings, "onlyoffice_document_server_url", "https://office.example.test")
    monkeypatch.setattr(documents.settings, "public_backend_url", "https://api.example.test")
    monkeypatch.setattr(documents.settings, "onlyoffice_jwt_secret", "test-office-secret")
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            yield client, sessions, actor
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def create_precedent(client, kind="text"):
    text = "Affidavit & service <terms>\n\nCafé — sworn\nFinal clause"
    if kind == "text":
        response = await client.post("/api/v1/precedents", json={"name": "Affidavit of Service", "practice_area": "tort", "document_type": "affidavit", "content_text": text})
        original = None
    else:
        original = documents.render_docx_bytes(text) if kind == "docx" else b"%PDF-1.4\n%%EOF\n" if kind == "pdf" else b"legacy office file"
        response = await client.post("/api/v1/precedents/upload", data={"name": "Affidavit of Service", "practice_area": "tort", "document_type": "affidavit", "content_text": "Do not replace uploaded bytes"}, files={"file": (f"Master.{kind}", original, "application/octet-stream")})
    assert response.status_code == 200, response.text
    return response.json()["id"], text, original


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["docx", "text"])
async def test_copy_download_edit_callback_and_versions(workflow, monkeypatch, kind):
    client, sessions, _actor = workflow
    precedent_id, text, original = await create_precedent(client, kind)
    if kind == "docx":
        async with sessions() as db:
            row = await db.get(Precedent, precedent_id)
            row.file_path = str(Path(row.file_path).relative_to(document_storage.REPOSITORY_ROOT))
            await db.commit()
    master = await client.get(f"/api/v1/precedents/{precedent_id}/download")
    assert master.status_code == 200
    assert master.headers["content-type"] == documents.DOCX_MIME_TYPE
    assert_word(master.content, text)
    if original:
        assert master.content == original
    copied = await client.post(f"/api/v1/precedents/{precedent_id}/copy-to-case", json={"case_id": 1, "name": "../../Affidavit.docx", "content_text": "Legacy override must not replace source"})
    assert copied.status_code == 200, copied.text
    doc = copied.json()["document"]
    document_id = doc["id"]
    assert doc["case_id"] == doc["client_id"] == doc["organization_id"] == 1
    assert doc["uploaded_by"] == 1 and doc["version"] == 1
    assert doc["category"] == "precedent" and doc["visibility"] == "internal"
    assert doc["file_type"] == documents.DOCX_MIME_TYPE
    assert doc["file_name"].endswith(".docx") and "/" not in doc["file_name"]
    assert "file_path" not in doc
    # Legacy repository-relative files must work regardless of backend cwd,
    # including after being archived into DocumentVersion by the callback.
    async with sessions() as db:
        row = await db.get(Document, document_id)
        row.file_path = str(Path(row.file_path).relative_to(document_storage.REPOSITORY_ROOT))
        await db.commit()
    downloaded = await client.get(f"/api/v1/documents/{document_id}/download")
    assert downloaded.headers["content-type"] == documents.DOCX_MIME_TYPE
    assert "attachment;" in downloaded.headers["content-disposition"]
    assert ".docx" in downloaded.headers["content-disposition"]
    assert_word(downloaded.content, text)
    if original:
        assert downloaded.content == original
    for path in ("/api/v1/documents?case_id=1", "/api/v1/documents"):
        assert document_id in [row["id"] for row in (await client.get(path)).json()]
    filtered = await client.get("/api/v1/documents/query?category=precedent&exclude_client_ids=true")
    assert document_id in [row["id"] for row in filtered.json()["items"]]
    for mode in ("view", "edit"):
        session = await client.post(f"/api/v1/documents/{document_id}/onlyoffice/session?mode={mode}")
        assert session.status_code == 200, session.text
        config = session.json()["editor_config"]
        assert config["editorConfig"]["mode"] == mode
        assert config["document"]["permissions"]["edit"] is (mode == "edit")
        assert ("callbackUrl" in config["editorConfig"]) is (mode == "edit")
        signed = jwt.decode(config["token"], "test-office-secret", algorithms=["HS256"])
        assert signed["editorConfig"]["mode"] == mode
        file_url = urlsplit(config["document"]["url"])
        served = await client.get(f"{file_url.path}?{file_url.query}")
        assert served.content == downloaded.content

    edited = documents.render_docx_bytes("Saved for review\nSecond paragraph")
    real_async_client = httpx.AsyncClient

    def office_client(*args, **kwargs):
        return real_async_client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=edited)))

    monkeypatch.setattr(documents.httpx, "AsyncClient", office_client)
    callback = urlsplit(config["editorConfig"]["callbackUrl"])
    payload = {"status": 2, "key": config["document"]["key"], "url": "https://office.example.test/cache/edited.docx", "users": ["1"]}
    saved = await client.post(f"{callback.path}?{callback.query}", json={"token": jwt.encode(payload, "test-office-secret", algorithm="HS256")})
    assert saved.json() == {"error": 0}
    updated = (await client.get(f"/api/v1/documents/{document_id}")).json()
    assert updated["case_id"] == updated["client_id"] == 1
    assert updated["version"] == 2 and updated["version_source"] == "onlyoffice_edit"
    assert updated["file_name"] == doc["file_name"]
    assert updated["updated_at"] != doc["updated_at"]
    assert_word((await client.get(f"/api/v1/documents/{document_id}/download")).content, "Saved for review\nSecond paragraph")
    history = (await client.get(f"/api/v1/documents/{document_id}/versions")).json()
    assert len(history) == 1 and history[0]["version_number"] == 1
    old = await client.get(f"/api/v1/documents/{document_id}/versions/{history[0]['id']}/download")
    assert old.content == downloaded.content
    async with sessions() as db:
        row = await db.get(Document, document_id)
        assert row.source_precedent_id == precedent_id
        assert row.file_size == len(edited)
        assert len((await db.scalars(select(AuditLog).where(AuditLog.action == "precedent_copied_to_case"))).all()) == 1
        assert len((await db.scalars(select(CaseTimelineEvent).where(CaseTimelineEvent.event_type == "precedent_copied"))).all()) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("kind, mime", [("pdf", "application/pdf"), ("doc", "application/msword")])
async def test_non_docx_preserves_original_and_rejects_editor(workflow, kind, mime):
    client, _sessions, _actor = workflow
    precedent_id, _text, original = await create_precedent(client, kind)
    assert (await client.get(f"/api/v1/precedents/{precedent_id}/download")).content == original
    copied = await client.post(f"/api/v1/precedents/{precedent_id}/copy-to-case", json={"case_id": 1})
    doc = copied.json()["document"]
    assert doc["file_name"] == f"Master.{kind}" and doc["file_type"] == mime
    assert (await client.get(f"/api/v1/documents/{doc['id']}/download")).content == original
    assert (await client.get(f"/api/v1/documents/{doc['id']}/view")).content == original
    assert (await client.post(f"/api/v1/documents/{doc['id']}/onlyoffice/session")).status_code == 400


@pytest.mark.asyncio
async def test_tenant_and_destination_access(workflow):
    client, sessions, actor = workflow
    precedent_id, _, _ = await create_precedent(client)
    assert (await client.post(f"/api/v1/precedents/{precedent_id}/copy-to-case", json={"case_id": 2})).status_code == 404
    actor["id"] = 2
    assert (await client.post(f"/api/v1/precedents/{precedent_id}/copy-to-case", json={"case_id": 2})).status_code == 404
    assert (await client.get(f"/api/v1/precedents/{precedent_id}/download")).status_code == 404
    actor["id"] = 3
    assert (await client.post(f"/api/v1/precedents/{precedent_id}/copy-to-case", json={"case_id": 1})).status_code == 404
    async with sessions() as db:
        db.add(CaseAssignment(case_id=1, user_id=3))
        await db.commit()
    copied = await client.post(f"/api/v1/precedents/{precedent_id}/copy-to-case", json={"case_id": 1})
    assert copied.status_code == 200, copied.text
    document_id = copied.json()["document"]["id"]
    assert (await client.get(f"/api/v1/documents/{document_id}/download")).status_code == 200
    actor["id"] = 2
    assert (await client.get(f"/api/v1/documents/{document_id}/download")).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("area", ["tort", "contracts", "corporate", "real_estate", "estate_probate", "intellectual_property", "trusts", "civil", "employment", "family", "criminal", "other"])
async def test_standard_and_legacy_areas_roundtrip(workflow, area):
    client, _, _ = workflow
    created = await client.post("/api/v1/precedents", json={"name": "Template", "practice_area": area, "document_type": "contract", "content_text": "Terms"})
    assert created.status_code == 200, created.text
    assert created.json()["practice_area"] == area
    assert (await client.get("/api/v1/precedents")).json()["items"][0]["practice_area"] == area


@pytest.mark.asyncio
async def test_invalid_word_and_external_storage_fail_without_copy(workflow, tmp_path):
    client, sessions, _ = workflow
    precedent_id, _, _ = await create_precedent(client, "docx")
    async with sessions() as db:
        row = await db.get(Precedent, precedent_id)
        Path(row.file_path).write_bytes(b"not a Word package")
    rejected = await client.post(f"/api/v1/precedents/{precedent_id}/copy-to-case", json={"case_id": 1})
    assert rejected.status_code == 400
    external = tmp_path / "outside.docx"
    external.write_bytes(documents.render_docx_bytes("Outside approved storage"))
    async with sessions() as db:
        row = await db.get(Precedent, precedent_id)
        row.file_path = str(external)
        await db.commit()
    assert (await client.post(f"/api/v1/precedents/{precedent_id}/copy-to-case", json={"case_id": 1})).status_code == 404
    assert (await client.get("/api/v1/documents")).json() == []


@pytest.mark.asyncio
async def test_word_download_remains_available_when_office_is_unconfigured(workflow, monkeypatch):
    client, _, _ = workflow
    precedent_id, text, _ = await create_precedent(client)
    copied = await client.post(f"/api/v1/precedents/{precedent_id}/copy-to-case", json={"case_id": 1})
    document_id = copied.json()["document"]["id"]
    monkeypatch.setattr(documents.settings, "onlyoffice_document_server_url", None)
    assert (await client.post(f"/api/v1/documents/{document_id}/onlyoffice/session?mode=edit")).status_code == 503
    assert_word((await client.get(f"/api/v1/documents/{document_id}/download")).content, text)
