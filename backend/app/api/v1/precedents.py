import json
from datetime import date, datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import or_, select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import role_guard
from app.api.v1.documents import STORAGE_ROOT as DOCUMENT_STORAGE_ROOT, to_response as document_to_response
from app.db.session import get_db
from app.models.case import Case
from app.models.document import Document
from app.models.precedent import Precedent
from app.models.practice_area import PracticeArea
from app.models.user import User
from app.schemas.precedent import (
    PrecedentCopyToCaseRequest,
    PrecedentCopyToCaseResponse,
    PrecedentCreate,
    PrecedentListResponse,
    PrecedentResponse,
    PrecedentSummaryResponse,
    PrecedentUpdate,
    PracticeAreaCreate,
    PracticeAreaResponse,
)
from app.services.audit import log_audit_event
from app.services.document_storage import build_text_filename, persist_file, resolve_stored_file, resolved_media_type, safe_original_name
from app.services.timeline import create_case_timeline_event

router = APIRouter(prefix="/precedents", tags=["precedents"])
MANAGE_ROLES = ["partner", "admin"]
VIEW_ROLES = ["partner", "admin", "lawyer", "paralegal"]
PRECEDENT_STORAGE_ROOT = Path("backend/storage/precedents")
VALID_SORTS = {
    "updated_at": Precedent.updated_at.desc(),
    "created_at": Precedent.created_at.desc(),
    "name": Precedent.name.asc(),
}


def normalize_tags(tags: list[str] | None) -> list[str]:
    values: list[str] = []
    for tag in tags or []:
        cleaned = str(tag).strip()
        if cleaned and cleaned not in values:
            values.append(cleaned)
    return values


def parse_tags_form(raw: str | None) -> list[str]:
    if not raw:
        return []
    value = raw.strip()
    if not value:
        return []
    if value.startswith("["):
        try:
            loaded = json.loads(value)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid tags payload") from exc
        if not isinstance(loaded, list):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid tags payload")
        return normalize_tags([str(item) for item in loaded])
    return normalize_tags(value.split(","))


def serialize_precedent(precedent: Precedent, include_content: bool = False) -> PrecedentResponse | PrecedentSummaryResponse:
    payload = dict(
        id=precedent.id,
        name=precedent.name,
        description=precedent.description,
        practice_area=precedent.practice_area,
        document_type=precedent.document_type,
        tags=list(precedent.tags or []),
        has_file=bool(precedent.file_path),
        file_name=precedent.file_name,
        file_type=precedent.file_type,
        file_size=precedent.file_size,
        created_by_id=precedent.created_by_id,
        created_by_name=getattr(getattr(precedent, "created_by", None), "name", None),
        updated_by_id=precedent.updated_by_id,
        updated_by_name=getattr(getattr(precedent, "updated_by", None), "name", None),
        is_archived=precedent.is_archived,
        created_at=precedent.created_at,
        updated_at=precedent.updated_at,
    )
    if include_content:
        return PrecedentResponse(content_text=precedent.content_text, **payload)
    return PrecedentSummaryResponse(**payload)


async def get_precedent_or_404(db: AsyncSession, precedent_id: int, organization_id: int) -> Precedent:
    precedent = await db.scalar(
        select(Precedent)
        .where(Precedent.id == precedent_id, Precedent.organization_id == organization_id)
        .options(selectinload(Precedent.created_by), selectinload(Precedent.updated_by))
    )
    if not precedent:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent not found")
    return precedent


async def get_case_or_404(db: AsyncSession, case_id: int, organization_id: int) -> Case:
    case = await db.scalar(select(Case).where(Case.id == case_id, Case.organization_id == organization_id))
    if not case:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")
    return case


def build_copy_payload(precedent: Precedent, requested_name: str | None, override_text: str | None) -> tuple[str, bytes, str | None]:
    title = (requested_name or precedent.name or precedent.file_name or "Precedent Copy").strip()
    if override_text is not None:
        file_name = build_text_filename(title)
        return title, override_text.encode("utf-8"), "text/plain"

    if precedent.file_path and precedent.file_name:
        # Copy-to-case predates the shared serving helper. Keep the exact
        # existing storage reference semantics here; view/download still use
        # the constrained resolver and the copied destination is generated
        # inside DOCUMENT_STORAGE_ROOT.
        source_path = Path(precedent.file_path)
        if not source_path.is_file():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Stored precedent file not found")
        return title, source_path.read_bytes(), precedent.file_type

    if precedent.content_text:
        file_name = build_text_filename(title)
        return title, precedent.content_text.encode("utf-8"), "text/plain"

    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Precedent has no file or text content to copy")


@router.get("/practice-areas", response_model=list[PracticeAreaResponse])
async def list_practice_areas(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(VIEW_ROLES)),
):
    rows = await db.scalars(
        select(PracticeArea).where(PracticeArea.organization_id == current_user.organization_id).order_by(PracticeArea.name.asc())
    )
    return [PracticeAreaResponse(id=row.id, name=row.name) for row in rows.all()]


@router.post("/practice-areas", response_model=PracticeAreaResponse, status_code=201)
async def create_practice_area(
    payload: PracticeAreaCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(MANAGE_ROLES)),
):
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(status_code=422, detail="Practice area name is required")
    normalized = name.casefold()
    existing = await db.scalar(
        select(PracticeArea).where(
            PracticeArea.organization_id == current_user.organization_id,
            PracticeArea.normalized_name == normalized,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="That practice area already exists")
    row = PracticeArea(
        organization_id=current_user.organization_id,
        name=name,
        normalized_name=normalized,
        created_by=current_user.id,
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail="That practice area already exists") from exc
    await db.refresh(row)
    return PracticeAreaResponse(id=row.id, name=row.name)


def build_copy_filename(precedent: Precedent, title: str, override_text: str | None) -> str:
    if override_text is not None:
        return build_text_filename(title)
    if precedent.file_name:
        return safe_original_name(precedent.file_name)
    return build_text_filename(title)


@router.get("", response_model=PrecedentListResponse)
async def list_precedents(
    q: str | None = Query(default=None),
    practice_area: str | None = Query(default=None),
    document_type: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    created_by_id: int | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    include_archived: bool = Query(default=False),
    sort: str = Query(default="updated_at"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(VIEW_ROLES)),
):
    order_by = VALID_SORTS.get(sort)
    if order_by is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid sort value")

    query = (
        select(Precedent)
        .where(Precedent.organization_id == current_user.organization_id)
        .options(selectinload(Precedent.created_by), selectinload(Precedent.updated_by))
        .order_by(order_by)
    )
    if not include_archived:
        query = query.where(Precedent.is_archived.is_(False))
    if practice_area:
        query = query.where(Precedent.practice_area == practice_area)
    if document_type:
        query = query.where(Precedent.document_type == document_type)
    if created_by_id is not None:
        query = query.where(Precedent.created_by_id == created_by_id)
    if date_from:
        query = query.where(func.date(Precedent.created_at) >= date_from.isoformat())
    if date_to:
        query = query.where(func.date(Precedent.created_at) <= date_to.isoformat())
    if q:
        like = f"%{q.strip()}%"
        query = query.where(
            or_(
                Precedent.name.ilike(like),
                Precedent.description.ilike(like),
                Precedent.content_text.ilike(like),
            )
        )

    rows = (await db.scalars(query)).all()
    if tag:
        tag_value = tag.strip().lower()
        rows = [row for row in rows if any(str(item).lower() == tag_value for item in (row.tags or []))]

    total = len(rows)
    page = rows[offset : offset + limit]
    return PrecedentListResponse(
        items=[serialize_precedent(row) for row in page],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("", response_model=PrecedentResponse)
async def create_precedent(
    payload: PrecedentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(MANAGE_ROLES)),
):
    now = datetime.now(timezone.utc)
    precedent = Precedent(
        organization_id=current_user.organization_id,
        name=payload.name.strip(),
        description=payload.description,
        practice_area=payload.practice_area,
        document_type=payload.document_type,
        tags=normalize_tags(payload.tags),
        content_text=payload.content_text,
        created_by_id=current_user.id,
        updated_by_id=current_user.id,
        is_archived=False,
        created_at=now,
        updated_at=now,
    )
    db.add(precedent)
    await db.flush()
    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="precedent_created",
        entity_type="precedent",
        entity_id=str(precedent.id),
        description=f"Precedent created: {precedent.name}",
        metadata_json={"document_type": precedent.document_type, "practice_area": precedent.practice_area},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await db.commit()
    precedent = await get_precedent_or_404(db, precedent.id, current_user.organization_id)
    return serialize_precedent(precedent, include_content=True)


@router.post("/upload", response_model=PrecedentResponse)
async def upload_precedent(
    practice_area: str = Form(...),
    document_type: str = Form(...),
    file: UploadFile = File(...),
    name: str | None = Form(default=None),
    description: str | None = Form(default=None),
    tags: str | None = Form(default=None),
    content_text: str | None = Form(default=None),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(MANAGE_ROLES)),
):
    original_name = safe_original_name(file.filename or "")
    data = await file.read()
    stored_path, _stored_name = persist_file(PRECEDENT_STORAGE_ROOT, current_user.organization_id, original_name, data)
    now = datetime.now(timezone.utc)
    precedent = Precedent(
        organization_id=current_user.organization_id,
        name=(name or Path(original_name).stem).strip(),
        description=description,
        practice_area=practice_area,
        document_type=document_type,
        tags=parse_tags_form(tags),
        content_text=content_text,
        file_path=stored_path,
        file_name=original_name,
        file_type=file.content_type,
        file_size=len(data),
        created_by_id=current_user.id,
        updated_by_id=current_user.id,
        is_archived=False,
        created_at=now,
        updated_at=now,
    )
    db.add(precedent)
    await db.flush()
    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="precedent_uploaded",
        entity_type="precedent",
        entity_id=str(precedent.id),
        description=f"Precedent uploaded: {precedent.name}",
        metadata_json={"file_name": precedent.file_name, "document_type": precedent.document_type},
        ip_address=request.client.host if request and request.client else None,
        user_agent=request.headers.get("user-agent") if request else None,
    )
    await db.commit()
    precedent = await get_precedent_or_404(db, precedent.id, current_user.organization_id)
    return serialize_precedent(precedent, include_content=True)


@router.get("/{precedent_id}", response_model=PrecedentResponse)
async def get_precedent(
    precedent_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(VIEW_ROLES)),
):
    precedent = await get_precedent_or_404(db, precedent_id, current_user.organization_id)
    return serialize_precedent(precedent, include_content=True)


@router.patch("/{precedent_id}", response_model=PrecedentResponse)
async def update_precedent(
    precedent_id: int,
    payload: PrecedentUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(MANAGE_ROLES)),
):
    precedent = await get_precedent_or_404(db, precedent_id, current_user.organization_id)
    updates = payload.model_dump(exclude_unset=True)
    if "tags" in updates:
        updates["tags"] = normalize_tags(updates["tags"])
    for key, value in updates.items():
        setattr(precedent, key, value)
    precedent.updated_by_id = current_user.id
    precedent.updated_at = datetime.now(timezone.utc)

    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="precedent_updated",
        entity_type="precedent",
        entity_id=str(precedent.id),
        description=f"Precedent updated: {precedent.name}",
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await db.commit()
    precedent = await get_precedent_or_404(db, precedent.id, current_user.organization_id)
    return serialize_precedent(precedent, include_content=True)


@router.get("/{precedent_id}/download")
async def download_precedent(
    precedent_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(VIEW_ROLES)),
):
    precedent = await get_precedent_or_404(db, precedent_id, current_user.organization_id)
    if not precedent.file_path or not precedent.file_name:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent file not found")
    path = resolve_stored_file(precedent.file_path, PRECEDENT_STORAGE_ROOT)
    return FileResponse(path=str(path), filename=precedent.file_name, media_type=resolved_media_type(precedent.file_name, precedent.file_type))


@router.get("/{precedent_id}/view")
async def view_precedent(
    precedent_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(VIEW_ROLES)),
):
    precedent = await get_precedent_or_404(db, precedent_id, current_user.organization_id)
    path = resolve_stored_file(precedent.file_path, PRECEDENT_STORAGE_ROOT)
    return FileResponse(
        path=str(path),
        media_type=resolved_media_type(precedent.file_name, precedent.file_type),
        content_disposition_type="inline",
        filename=precedent.file_name or path.name,
    )


@router.post("/{precedent_id}/archive", response_model=PrecedentResponse)
async def archive_precedent(
    precedent_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(MANAGE_ROLES)),
):
    precedent = await get_precedent_or_404(db, precedent_id, current_user.organization_id)
    now = datetime.now(timezone.utc)
    precedent.is_archived = True
    precedent.archived_at = now
    precedent.updated_at = now
    precedent.updated_by_id = current_user.id

    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="precedent_archived",
        entity_type="precedent",
        entity_id=str(precedent.id),
        description=f"Precedent archived: {precedent.name}",
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await db.commit()
    precedent = await get_precedent_or_404(db, precedent.id, current_user.organization_id)
    return serialize_precedent(precedent, include_content=True)


@router.delete("/{precedent_id}")
async def delete_precedent(
    precedent_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(MANAGE_ROLES)),
):
    precedent = await get_precedent_or_404(db, precedent_id, current_user.organization_id)
    now = datetime.now(timezone.utc)
    precedent.is_archived = True
    precedent.archived_at = now
    precedent.updated_at = now
    precedent.updated_by_id = current_user.id

    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="precedent_deleted",
        entity_type="precedent",
        entity_id=str(precedent.id),
        description=f"Precedent deleted: {precedent.name}",
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await db.commit()
    return {"ok": True}


@router.post("/{precedent_id}/copy-to-case", response_model=PrecedentCopyToCaseResponse)
async def copy_precedent_to_case(
    precedent_id: int,
    payload: PrecedentCopyToCaseRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(VIEW_ROLES)),
):
    precedent = await get_precedent_or_404(db, precedent_id, current_user.organization_id)
    case = await get_case_or_404(db, payload.case_id, current_user.organization_id)

    title, data, file_type = build_copy_payload(precedent, payload.name, payload.content_text)
    file_name = build_copy_filename(precedent, title, payload.content_text)
    file_path, _stored_name = persist_file(DOCUMENT_STORAGE_ROOT, current_user.organization_id, file_name, data)
    now = datetime.now(timezone.utc)

    document = Document(
        organization_id=current_user.organization_id,
        case_id=case.id,
        client_id=case.client_id,
        source_precedent_id=precedent.id,
        uploaded_by=current_user.id,
        title=title,
        description=f"Copied from precedent: {precedent.name}",
        file_name=file_name,
        file_path=file_path,
        file_type=file_type,
        file_size=len(data),
        category="precedent",
        visibility="internal",
        version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(document)
    await db.flush()
    await create_case_timeline_event(
        db,
        organization_id=current_user.organization_id,
        case_id=case.id,
        actor_id=current_user.id,
        event_type="precedent_copied",
        title=f"Precedent copied to case: {title}",
        metadata_json={"document_id": document.id, "precedent_id": precedent.id},
    )
    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="precedent_copied_to_case",
        entity_type="document",
        entity_id=str(document.id),
        description=f"Precedent copied to case document: {title}",
        metadata_json={"case_id": case.id, "precedent_id": precedent.id},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await db.commit()
    await db.refresh(document)
    return PrecedentCopyToCaseResponse(
        precedent_id=precedent.id,
        case_id=case.id,
        document=document_to_response(document),
    )
