from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import inspect, or_, select
from sqlalchemy.exc import IntegrityError, NoInspectionAvailable
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import NO_VALUE
from sqlalchemy.orm import selectinload

from app.api.deps import role_guard
from app.db.session import get_db
from app.models.client import Client, ClientAssignment
from app.models.client_intake_draft import ClientIntakeDraft
from app.models.client_intake_draft_attachment import ClientIntakeDraftAttachment
from app.models.case import Case, CaseAssignment
from app.models.document import Document
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.document import DocumentResponse
from app.schemas.client import (
    AssignedUser, ClientCreate, ClientIntakeDraftAttachmentResponse, ClientIntakeDraftResponse, ClientIntakeDraftUpsert,
    ClientResponse, ClientUpdate,
)
from app.services.audit import log_audit_event
from app.services.document_storage import (
    REPOSITORY_ROOT, persist_file, resolve_stored_file, resolved_media_type, safe_original_name, validate_extension,
)

router = APIRouter(prefix="/clients", tags=["clients"])
ALLOWED_STAFF = ["partner", "admin", "lawyer", "paralegal"]
ALLOWED_EXTENSIONS = {"pdf", "doc", "docx", "jpg", "jpeg", "png"}
CLIENT_ID_TYPES = {"national_id", "trn", "passport", "driver_licence", "other"}
CLIENT_ID_TYPE_PREFIX = "Client ID type: "
CLIENT_ID_TYPE_LABELS = {
    "national_id": "National ID",
    "trn": "TRN",
    "passport": "Passport",
    "driver_licence": "Driver's License",
    "other": "Other",
}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
STORAGE_ROOT = Path("backend/storage/documents")
DRAFT_STORAGE_ROOT = Path("backend/storage/client_intake_drafts")


def _unlink_quietly(path: Path | None) -> None:
    if not path:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        # The database remains authoritative. A later storage maintenance job
        # may remove an orphan if the filesystem is temporarily unavailable.
        pass


def to_response(client: Client) -> ClientResponse:
    try:
        assignments_state = inspect(client).attrs.assignments
        loaded_assignments = assignments_state.loaded_value
        assignments = [] if loaded_assignments is NO_VALUE else loaded_assignments
    except NoInspectionAvailable:
        assignments = getattr(client, "assignments", [])
    assigned_users = [
        AssignedUser(
            id=assignment.user.id,
            name=assignment.user.name,
            email=assignment.user.email,
            role=assignment.user.role.value,
            status=assignment.user.status.value,
        )
        for assignment in assignments
        if getattr(assignment, "user", None) is not None
    ]
    return ClientResponse(
        id=client.id,
        organization_id=client.organization_id,
        name=client.name,
        email=client.email,
        phone=client.phone,
        user_id=client.user_id,
        address=client.address,
        notes=client.notes,
        client_type=client.client_type,
        trn_no=client.trn_no,
        occupation=client.occupation,
        preferred_contact_method=client.preferred_contact_method,
        date_of_birth=client.date_of_birth,
        billing_currency=client.billing_currency,
        archived_at=client.archived_at,
        assigned_users=assigned_users,
        assigned_user_ids=[user.id for user in assigned_users],
        created_at=client.created_at,
        updated_at=client.updated_at,
    )


def normalize_client_type(value: str | None) -> str:
    if not value:
        return "individual"
    normalized = value.strip().lower()
    if normalized not in {"individual", "corporate"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="client_type must be 'individual' or 'corporate'")
    return normalized


async def get_client_for_org(db: AsyncSession, organization_id: int, client_id: int) -> Client:
    client = await db.scalar(
        select(Client)
        .where(
            Client.id == client_id,
            Client.organization_id == organization_id,
        )
        .options(selectinload(Client.assignments).selectinload(ClientAssignment.user))
    )
    if not client:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    return client


def to_document_response(document: Document) -> DocumentResponse:
    return DocumentResponse(
        id=document.id,
        organization_id=document.organization_id,
        case_id=document.case_id,
        client_id=document.client_id,
        uploaded_by=document.uploaded_by,
        title=document.title,
        description=document.description,
        file_name=document.file_name,
        file_type=document.file_type,
        file_size=document.file_size,
        category=document.category,
        client_id_type=client_id_type_from_document(document),
        visibility=document.visibility,
        version=document.version,
        created_at=document.created_at,
        updated_at=document.updated_at,
    )


def normalize_client_id_type(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    if normalized not in CLIENT_ID_TYPES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid ID type")
    return normalized


def client_id_type_from_document(document: Document) -> str | None:
    if document.category != "client_id":
        return None
    description = (document.description or "").strip()
    if description.startswith(CLIENT_ID_TYPE_PREFIX):
        value = description.removeprefix(CLIENT_ID_TYPE_PREFIX).strip().lower()
        if value in CLIENT_ID_TYPES:
            return value
    return "other"


def _safe_original_name(original: str) -> str:
    name = Path(original or "").name.strip()
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid file name")
    return name


def _validate_extension(file_name: str) -> str:
    parts = file_name.rsplit(".", 1)
    if len(parts) != 2:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File extension is required")
    ext = parts[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported file type")
    return ext


async def validate_client_user(db: AsyncSession, organization_id: int, user_id: int | None) -> User | None:
    if user_id is None:
        return None
    user = await db.scalar(select(User).where(User.id == user_id, User.organization_id == organization_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Linked user must belong to your organization")
    if user.role != UserRole.client:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Linked user must have client role")
    return user


async def validate_assignments(db: AsyncSession, organization_id: int, user_ids: list[int]) -> list[User]:
    if not user_ids:
        return []
    unique_user_ids = list(dict.fromkeys(user_ids))
    rows = await db.scalars(select(User).where(User.organization_id == organization_id, User.id.in_(unique_user_ids)))
    users = rows.all()
    if len(users) != len(unique_user_ids):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="One or more assigned users are invalid")
    users_by_id = {user.id: user for user in users}
    ordered_users = [users_by_id[user_id] for user_id in unique_user_ids]
    allowed_roles = {UserRole.partner, UserRole.admin, UserRole.lawyer, UserRole.paralegal}
    if any(user.role not in allowed_roles for user in ordered_users):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Assigned users must be eligible staff members")
    if any(user.status.value != "active" for user in ordered_users):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Assigned users must be active")
    return ordered_users


async def sync_client_assignments(client: Client, users: list[User], db: AsyncSession) -> None:
    wanted = {user.id for user in users}
    result = await db.execute(select(ClientAssignment).where(ClientAssignment.client_id == client.id))
    existing_assignments = result.scalars().all()
    existing_by_user = {assignment.user_id: assignment for assignment in existing_assignments}

    for assignment in existing_assignments:
        if assignment.user_id in wanted:
            continue
        await db.delete(assignment)

    for user in users:
        if user.id in existing_by_user:
            continue
        assignment = ClientAssignment(client_id=client.id, user_id=user.id)
        db.add(assignment)


@router.post("", response_model=ClientResponse)
async def create_client(
    payload: ClientCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    await validate_client_user(db, current_user.organization_id, payload.user_id)
    assigned_users = await validate_assignments(db, current_user.organization_id, payload.assigned_user_ids)
    now = datetime.now(timezone.utc)
    client = Client(
        organization_id=current_user.organization_id,
        name=payload.name,
        email=payload.email,
        phone=payload.phone,
        user_id=payload.user_id,
        address=payload.address,
        notes=payload.notes,
        client_type=normalize_client_type(payload.client_type),
        trn_no=payload.trn_no,
        occupation=payload.occupation,
        preferred_contact_method=payload.preferred_contact_method,
        date_of_birth=payload.date_of_birth,
        billing_currency=payload.billing_currency or "JMD",
        archived_at=payload.archived_at,
        created_at=now,
        updated_at=now,
    )
    db.add(client)
    try:
        await db.flush()
        await sync_client_assignments(client, assigned_users, db)
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Client could not be created because of a duplicate or conflicting record") from exc
    except Exception:
        await db.rollback()
        raise
    client = await get_client_for_org(db, current_user.organization_id, client.id)
    return to_response(client)


@router.get("", response_model=list[ClientResponse])
async def list_clients(
    status_filter: str = Query("all", alias="status"),
    q: str | None = Query(default=None, max_length=100),
    limit: int | None = Query(default=None, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    query = (
        select(Client)
        .where(Client.organization_id == current_user.organization_id)
        .options(selectinload(Client.assignments).selectinload(ClientAssignment.user))
    )
    if status_filter == "active":
        query = query.where(Client.archived_at.is_(None))
    elif status_filter == "archived":
        query = query.where(Client.archived_at.is_not(None))
    elif status_filter != "all":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="status must be one of: all, active, archived")
    if q and q.strip():
        search = f"%{q.strip()}%"
        query = query.where(
            or_(
                Client.name.ilike(search),
                Client.email.ilike(search),
                Client.trn_no.ilike(search),
            )
        )

    query = query.order_by(Client.name.asc() if q and q.strip() else Client.created_at.desc())
    if limit is not None:
        query = query.limit(limit)
    rows = await db.scalars(query)
    return [to_response(c) for c in rows.all()]


def serialize_intake_draft(draft: ClientIntakeDraft) -> ClientIntakeDraftResponse:
    try:
        loaded_attachment = inspect(draft).attrs.attachment.loaded_value
        attachment = None if loaded_attachment is NO_VALUE else loaded_attachment
    except NoInspectionAvailable:
        attachment = getattr(draft, "attachment", None)
    return ClientIntakeDraftResponse(
        id=draft.id,
        organization_id=draft.organization_id,
        created_by=draft.created_by,
        payload=draft.payload or {},
        attachment=serialize_intake_attachment(attachment) if attachment else None,
        created_at=draft.created_at,
        updated_at=draft.updated_at,
    )


def serialize_intake_attachment(attachment: ClientIntakeDraftAttachment) -> ClientIntakeDraftAttachmentResponse:
    return ClientIntakeDraftAttachmentResponse(
        id=attachment.id,
        file_name=attachment.file_name,
        file_type=attachment.file_type,
        file_size=attachment.file_size,
        created_at=attachment.created_at,
        updated_at=attachment.updated_at,
    )


async def get_intake_draft(db: AsyncSession, draft_id: int, current_user: User) -> ClientIntakeDraft:
    draft = await db.scalar(
        select(ClientIntakeDraft).where(
            ClientIntakeDraft.id == draft_id,
            ClientIntakeDraft.organization_id == current_user.organization_id,
        ).options(selectinload(ClientIntakeDraft.attachment))
    )
    if not draft:
        raise HTTPException(status_code=404, detail="Client intake draft not found")
    if draft.created_by != current_user.id and current_user.role.value not in {"partner", "admin"}:
        raise HTTPException(status_code=403, detail="You do not have permission to access this client intake draft")
    return draft


@router.get("/intake-drafts", response_model=list[ClientIntakeDraftResponse])
async def list_intake_drafts(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    query = select(ClientIntakeDraft).where(ClientIntakeDraft.organization_id == current_user.organization_id)
    if current_user.role.value not in {"partner", "admin"}:
        query = query.where(ClientIntakeDraft.created_by == current_user.id)
    rows = await db.scalars(query.options(selectinload(ClientIntakeDraft.attachment)).order_by(ClientIntakeDraft.updated_at.desc()))
    return [serialize_intake_draft(row) for row in rows.all()]


@router.post("/intake-drafts", response_model=ClientIntakeDraftResponse)
async def create_intake_draft(
    payload: ClientIntakeDraftUpsert,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    now = datetime.now(timezone.utc)
    draft = ClientIntakeDraft(
        organization_id=current_user.organization_id,
        created_by=current_user.id,
        payload=payload.payload,
        created_at=now,
        updated_at=now,
    )
    db.add(draft)
    await db.commit()
    await db.refresh(draft)
    return serialize_intake_draft(draft)


@router.patch("/intake-drafts/{draft_id}", response_model=ClientIntakeDraftResponse)
async def update_intake_draft(
    draft_id: int,
    payload: ClientIntakeDraftUpsert,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    draft = await get_intake_draft(db, draft_id, current_user)
    draft.payload = payload.payload
    draft.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(draft)
    return serialize_intake_draft(draft)


@router.delete("/intake-drafts/{draft_id}")
async def discard_intake_draft(
    draft_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    draft = await get_intake_draft(db, draft_id, current_user)
    attachment_path = None
    if draft.attachment:
        try:
            attachment_path = resolve_stored_file(draft.attachment.file_path, DRAFT_STORAGE_ROOT)
        except HTTPException:
            attachment_path = None
    await db.delete(draft)
    await db.commit()
    _unlink_quietly(attachment_path)
    return {"ok": True}


@router.post("/intake-drafts/{draft_id}/attachment", response_model=ClientIntakeDraftAttachmentResponse)
async def upload_intake_draft_attachment(
    draft_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    draft = await get_intake_draft(db, draft_id, current_user)
    original_name = safe_original_name(file.filename or "")
    validate_extension(original_name, ALLOWED_EXTENSIONS)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="File exceeds upload size limit")

    new_path, _ = persist_file(DRAFT_STORAGE_ROOT, current_user.organization_id, original_name, data)
    old_path = None
    attachment = draft.attachment
    if attachment:
        try:
            old_path = resolve_stored_file(attachment.file_path, DRAFT_STORAGE_ROOT)
        except HTTPException:
            old_path = None
        attachment.file_name = original_name
        attachment.file_path = new_path
        attachment.file_type = file.content_type
        attachment.file_size = len(data)
        attachment.updated_at = datetime.now(timezone.utc)
    else:
        now = datetime.now(timezone.utc)
        attachment = ClientIntakeDraftAttachment(
            organization_id=current_user.organization_id,
            draft_id=draft.id,
            uploaded_by=current_user.id,
            file_name=original_name,
            file_path=new_path,
            file_type=file.content_type,
            file_size=len(data),
            created_at=now,
            updated_at=now,
        )
        db.add(attachment)
    try:
        await db.commit()
        await db.refresh(attachment)
    except Exception:
        await db.rollback()
        _unlink_quietly(Path(new_path))
        raise
    if old_path and old_path != Path(new_path):
        _unlink_quietly(old_path)
    return serialize_intake_attachment(attachment)


@router.get("/intake-drafts/{draft_id}/attachment/download")
async def download_intake_draft_attachment(
    draft_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    draft = await get_intake_draft(db, draft_id, current_user)
    if not draft.attachment:
        raise HTTPException(status_code=404, detail="Draft attachment not found")
    path = resolve_stored_file(draft.attachment.file_path, DRAFT_STORAGE_ROOT)
    return FileResponse(
        path=str(path),
        filename=draft.attachment.file_name,
        media_type=draft.attachment.file_type or "application/octet-stream",
    )


@router.get("/intake-drafts/{draft_id}/attachment/view")
async def view_intake_draft_attachment(
    draft_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    draft = await get_intake_draft(db, draft_id, current_user)
    if not draft.attachment:
        raise HTTPException(status_code=404, detail="Draft attachment not found")
    path = resolve_stored_file(draft.attachment.file_path, DRAFT_STORAGE_ROOT)
    return FileResponse(
        path=str(path),
        filename=draft.attachment.file_name,
        media_type=draft.attachment.file_type or "application/octet-stream",
        content_disposition_type="inline",
    )


@router.delete("/intake-drafts/{draft_id}/attachment")
async def remove_intake_draft_attachment(
    draft_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    draft = await get_intake_draft(db, draft_id, current_user)
    if not draft.attachment:
        raise HTTPException(status_code=404, detail="Draft attachment not found")
    try:
        path = resolve_stored_file(draft.attachment.file_path, DRAFT_STORAGE_ROOT)
    except HTTPException:
        path = None
    await db.delete(draft.attachment)
    await db.commit()
    _unlink_quietly(path)
    return {"ok": True}


@router.post("/intake-drafts/{draft_id}/complete", response_model=ClientResponse)
async def complete_intake_draft(
    draft_id: int,
    payload: ClientCreate,
    include_attachment: bool = Query(default=True),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    draft = await get_intake_draft(db, draft_id, current_user)
    await validate_client_user(db, current_user.organization_id, payload.user_id)
    assigned_users = await validate_assignments(db, current_user.organization_id, payload.assigned_user_ids)
    now = datetime.now(timezone.utc)
    client = Client(
        organization_id=current_user.organization_id,
        name=payload.name,
        email=payload.email,
        phone=payload.phone,
        user_id=payload.user_id,
        address=payload.address,
        notes=payload.notes,
        client_type=normalize_client_type(payload.client_type),
        trn_no=payload.trn_no,
        occupation=payload.occupation,
        preferred_contact_method=payload.preferred_contact_method,
        date_of_birth=payload.date_of_birth,
        billing_currency=payload.billing_currency or "JMD",
        archived_at=payload.archived_at,
        created_at=now,
        updated_at=now,
    )
    temporary_path = None
    final_path = None
    db.add(client)
    try:
        await db.flush()
        await sync_client_assignments(client, assigned_users, db)
        if draft.attachment:
            temporary_path = resolve_stored_file(draft.attachment.file_path, DRAFT_STORAGE_ROOT)
        if draft.attachment and include_attachment:
            final_path, _ = persist_file(
                STORAGE_ROOT,
                current_user.organization_id,
                draft.attachment.file_name,
                temporary_path.read_bytes(),
            )
            db.add(Document(
                organization_id=current_user.organization_id,
                client_id=client.id,
                case_id=None,
                uploaded_by=current_user.id,
                title=f"ID Document - {draft.attachment.file_name}",
                description="Client identity document",
                file_name=draft.attachment.file_name,
                file_path=final_path,
                file_type=draft.attachment.file_type,
                file_size=draft.attachment.file_size,
                category="client_id",
                visibility="internal",
                version=1,
                version_source="upload",
                created_at=now,
                updated_at=now,
            ))
        await db.delete(draft)
        await db.commit()
    except Exception:
        await db.rollback()
        if final_path:
            _unlink_quietly(Path(final_path))
        raise
    _unlink_quietly(temporary_path)
    client = await get_client_for_org(db, current_user.organization_id, client.id)
    return to_response(client)


@router.get("/{client_id}", response_model=ClientResponse)
async def get_client(
    client_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    client = await get_client_for_org(db, current_user.organization_id, client_id)
    return to_response(client)


@router.patch("/{client_id}", response_model=ClientResponse)
async def update_client(
    client_id: int,
    payload: ClientUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    client = await get_client_for_org(db, current_user.organization_id, client_id)

    updates = payload.model_dump(exclude_unset=True, exclude={"assigned_user_ids"})
    if "user_id" in updates:
        await validate_client_user(db, current_user.organization_id, updates["user_id"])
    if "client_type" in updates and updates["client_type"] is not None:
        updates["client_type"] = normalize_client_type(updates["client_type"])
    for key, value in updates.items():
        setattr(client, key, value)
    if payload.assigned_user_ids is not None:
        users = await validate_assignments(db, current_user.organization_id, payload.assigned_user_ids)
        await sync_client_assignments(client, users, db)
    client.updated_at = datetime.now(timezone.utc)

    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Client could not be updated because of a duplicate or conflicting record") from exc
    except Exception:
        await db.rollback()
        raise
    client = await get_client_for_org(db, current_user.organization_id, client.id)
    return to_response(client)


@router.delete("/{client_id}")
async def delete_client(
    client_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    client = await get_client_for_org(db, current_user.organization_id, client_id)

    await db.delete(client)
    await db.commit()
    return {"ok": True}


@router.post("/{client_id}/id-documents", response_model=DocumentResponse)
async def upload_client_id_document(
    client_id: int,
    id_type: str = Form(default="other"),
    file: UploadFile = File(...),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    client = await get_client_for_org(db, current_user.organization_id, client_id)
    await require_client_id_access(db, current_user, client_id)
    normalized_id_type = normalize_client_id_type(id_type)

    original_name = _safe_original_name(file.filename or "")
    ext = _validate_extension(original_name)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File exceeds upload size limit")

    org_dir = (REPOSITORY_ROOT / STORAGE_ROOT) / str(current_user.organization_id) / "client_ids" / str(client.id)
    org_dir.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid4().hex}.{ext}"
    file_path = org_dir / stored_name
    file_path.write_bytes(data)

    now = datetime.now(timezone.utc)
    document = Document(
        organization_id=current_user.organization_id,
        client_id=client.id,
        case_id=None,
        uploaded_by=current_user.id,
        title=f"{CLIENT_ID_TYPE_LABELS[normalized_id_type]} - {original_name}",
        description=f"{CLIENT_ID_TYPE_PREFIX}{normalized_id_type}",
        file_name=original_name,
        file_path=str(file_path),
        file_type=file.content_type,
        file_size=len(data),
        category="client_id",
        visibility="internal",
        version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(document)
    await db.flush()
    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="client_id_document_uploaded",
        entity_type="document",
        entity_id=str(document.id),
        description=f"Client ID document uploaded: {document.file_name}",
        metadata_json={"client_id": client.id, "id_type": normalized_id_type},
        ip_address=request.client.host if request and request.client else None,
        user_agent=request.headers.get("user-agent") if request else None,
    )
    await db.commit()
    await db.refresh(document)
    return to_document_response(document)


@router.get("/{client_id}/id-documents", response_model=list[DocumentResponse])
async def list_client_id_documents(
    client_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    client = await get_client_for_org(db, current_user.organization_id, client_id)
    await require_client_id_access(db, current_user, client_id)
    rows = await db.scalars(
        select(Document)
        .where(
            Document.organization_id == current_user.organization_id,
            Document.client_id == client.id,
            Document.category == "client_id",
        )
        .order_by(Document.created_at.desc())
    )
    return [to_document_response(d) for d in rows.all()]


async def get_client_document_for_org(
    db: AsyncSession,
    organization_id: int,
    client_id: int,
    document_id: int,
) -> Document:
    await get_client_for_org(db, organization_id, client_id)
    doc = await db.scalar(
        select(Document).where(
            Document.id == document_id,
            Document.organization_id == organization_id,
            Document.client_id == client_id,
            Document.category == "client_id",
        )
    )
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    return doc


async def require_client_id_access(db: AsyncSession, current_user: User, client_id: int) -> None:
    if current_user.role.value in {"partner", "admin", "lawyer"}:
        return
    assigned_client = await db.scalar(
        select(ClientAssignment.id).join(Client, Client.id == ClientAssignment.client_id).where(
            Client.organization_id == current_user.organization_id,
            ClientAssignment.client_id == client_id,
            ClientAssignment.user_id == current_user.id,
        )
    )
    assigned_case = await db.scalar(
        select(CaseAssignment.id)
        .join(Case, Case.id == CaseAssignment.case_id)
        .where(
            Case.organization_id == current_user.organization_id,
            Case.client_id == client_id,
            CaseAssignment.user_id == current_user.id,
        )
    )
    if assigned_client is None and assigned_case is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to view this document")


@router.get("/{client_id}/id-documents/{document_id}/download")
async def download_client_id_document(
    client_id: int,
    document_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    doc = await get_client_document_for_org(db, current_user.organization_id, client_id, document_id)
    await require_client_id_access(db, current_user, client_id)
    path = resolve_stored_file(doc.file_path, STORAGE_ROOT)
    return FileResponse(path=str(path), filename=doc.file_name, media_type=resolved_media_type(doc.file_name, doc.file_type))


@router.get("/{client_id}/id-documents/{document_id}/view")
async def view_client_id_document(
    client_id: int,
    document_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    doc = await get_client_document_for_org(db, current_user.organization_id, client_id, document_id)
    await require_client_id_access(db, current_user, client_id)
    path = resolve_stored_file(doc.file_path, STORAGE_ROOT)
    return FileResponse(
        path=str(path),
        filename=doc.file_name,
        media_type=resolved_media_type(doc.file_name, doc.file_type),
        content_disposition_type="inline",
    )


@router.delete("/{client_id}/id-documents/{document_id}")
async def delete_client_id_document(
    client_id: int,
    document_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    doc = await get_client_document_for_org(db, current_user.organization_id, client_id, document_id)
    await require_client_id_access(db, current_user, client_id)
    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="client_id_document_deleted",
        entity_type="document",
        entity_id=str(doc.id),
        description=f"Client ID document deleted: {doc.file_name}",
        metadata_json={"client_id": client_id},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    path = Path(doc.file_path)
    if path.exists():
        path.unlink(missing_ok=True)
    await db.delete(doc)
    await db.commit()
    return {"ok": True}
