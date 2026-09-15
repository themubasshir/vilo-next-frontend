from datetime import date, datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import and_, cast, func, or_, select, String
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import role_guard
from app.db.session import get_db
from app.models.case import Case, CaseAssignment
from app.models.case_timeline_event import CaseTimelineEvent
from app.models.client import Client
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.case import AssignedUser, CaseAssignmentRequest, CaseCreate, CaseListResponse, CaseResponse, CaseStatusCount, CaseUpdate
from app.schemas.timeline import CaseTimelineResponse, TimelineEventCreate, TimelineEventUpdate
from app.services.audit import log_audit_event
from app.services.access import accessible_case_condition, scope_cases
from app.services.notifications import notify_case_assigned

router = APIRouter(prefix="/cases", tags=["cases"])
ALLOWED_STAFF = ["partner", "admin", "lawyer", "paralegal"]


def validate_case_required_fields(case_status, title: str | None, client_id: int | None) -> None:
    normalized_status = getattr(case_status, "value", case_status)
    if normalized_status == "draft":
        return
    if not (title or "").strip():
        raise HTTPException(status_code=422, detail="Title is required to complete a case")
    if client_id is None:
        raise HTTPException(status_code=422, detail="Client is required to complete a case")


async def get_case_or_404(db: AsyncSession, case_id: int, current_user: User) -> Case:
    case = await db.scalar(
        scope_cases(select(Case), current_user)
        .where(Case.id == case_id)
        .options(selectinload(Case.client), selectinload(Case.assignments).selectinload(CaseAssignment.user))
        .execution_options(populate_existing=True)
    )
    if not case:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")
    return case


def serialize_case(case: Case) -> CaseResponse:
    assigned_users = [
        AssignedUser(
            id=a.user.id,
            name=a.user.name,
            email=a.user.email,
            role=a.user.role.value,
            status=a.user.status.value,
        )
        for a in case.assignments
    ]
    return CaseResponse(
        id=case.id,
        organization_id=case.organization_id,
        title=case.title,
        description=case.description,
        client_id=case.client_id,
        status=case.status.value,
        priority=case.priority.value,
        expected_completion_date=getattr(case, "expected_completion_date", None),
        created_by=case.created_by,
        assigned_users=assigned_users,
        created_at=case.created_at,
        updated_at=case.updated_at,
        client_name=getattr(getattr(case, "client", None), "name", None),
        case_number=f"C-{case.id}",
    )


async def validate_assignments(db: AsyncSession, organization_id: int, user_ids: list[int]) -> list[User]:
    if not user_ids:
        return []
    rows = await db.scalars(
        select(User).where(
            User.organization_id == organization_id,
            User.id.in_(user_ids),
            User.role != UserRole.client,
        )
    )
    users = rows.all()
    if len(users) != len(set(user_ids)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="One or more assigned users are invalid")
    return users


@router.post("", response_model=CaseResponse)
async def create_case(
    payload: CaseCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    client = None
    if payload.client_id is not None:
        client = await db.scalar(
            select(Client).where(
                Client.id == payload.client_id,
                Client.organization_id == current_user.organization_id,
            )
        )
        if not client:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Client must belong to your organization")
    validate_case_required_fields(payload.status, payload.title, payload.client_id)

    users = await validate_assignments(db, current_user.organization_id, payload.assigned_user_ids)
    now = datetime.now(timezone.utc)

    case = Case(
        organization_id=current_user.organization_id,
        title=(payload.title or "").strip() or None,
        description=payload.description,
        client_id=payload.client_id,
        status=payload.status,
        priority=payload.priority,
        expected_completion_date=payload.expected_completion_date,
        created_by=current_user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(case)
    await db.flush()

    for user in users:
        db.add(CaseAssignment(case_id=case.id, user_id=user.id))
    await notify_case_assigned(
        db,
        case=case,
        actor=current_user,
        newly_assigned_user_ids={user.id for user in users},
    )
    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="case_created",
        entity_type="case",
        entity_id=str(case.id),
        description=f"Case created: {case.title}",
        metadata_json={"client_id": case.client_id, "status": case.status.value, "priority": case.priority.value},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )

    await db.commit()
    reloaded = await get_case_or_404(db, case.id, current_user)
    return serialize_case(reloaded)


@router.get("/query", response_model=CaseListResponse)
async def query_cases(
    search: str | None = Query(default=None, min_length=1, max_length=100),
    status_filter: str | None = Query(default=None, alias="status"),
    assigned_user_id: int | None = Query(default=None, ge=1),
    client_id: int | None = Query(default=None, ge=1),
    created_from: date | None = Query(default=None),
    created_to: date | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=10, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    valid_statuses = {"draft", "active", "closed", "archived"}
    if status_filter and status_filter not in valid_statuses | {"all"}:
        raise HTTPException(status_code=400, detail="Invalid case status")

    filters = [Case.organization_id == current_user.organization_id, accessible_case_condition(current_user)]
    if status_filter and status_filter != "all":
        filters.append(Case.status == status_filter)
    if assigned_user_id is not None:
        assigned = select(CaseAssignment.case_id).where(CaseAssignment.user_id == assigned_user_id)
        filters.append(Case.id.in_(assigned))
    if client_id is not None:
        filters.append(Case.client_id == client_id)
    if created_from is not None:
        filters.append(Case.created_at >= datetime.combine(created_from, datetime.min.time(), tzinfo=timezone.utc))
    if created_to is not None:
        filters.append(Case.created_at < datetime.combine(created_to, datetime.min.time(), tzinfo=timezone.utc) + timedelta(days=1))
    if search and search.strip():
        normalized_search = search.strip()
        numeric_reference = normalized_search[2:] if normalized_search.lower().startswith("c-") else normalized_search
        term = f"%{normalized_search}%"
        filters.append(or_(Case.title.ilike(term), Client.name.ilike(term), cast(Case.id, String).ilike(f"%{numeric_reference}%")))

    base = select(Case).outerjoin(Client, Client.id == Case.client_id).where(and_(*filters))
    total = int((await db.scalar(select(func.count(Case.id)).outerjoin(Client, Client.id == Case.client_id).where(and_(*filters)))) or 0)
    rows = await db.scalars(
        base.options(
            selectinload(Case.client),
            selectinload(Case.assignments).selectinload(CaseAssignment.user),
        ).order_by(Case.created_at.desc(), Case.id.desc()).offset((page - 1) * per_page).limit(per_page)
    )
    count_filters = [Case.organization_id == current_user.organization_id, accessible_case_condition(current_user)]
    count_rows = (await db.execute(
        select(Case.status, func.count(Case.id)).where(and_(*count_filters)).group_by(Case.status)
    )).all()
    counts = [CaseStatusCount(status=getattr(row[0], "value", row[0]), count=int(row[1])) for row in count_rows]
    return CaseListResponse(
        items=[serialize_case(case) for case in rows.all()],
        total=total,
        page=page,
        per_page=per_page,
        total_pages=max(1, (total + per_page - 1) // per_page),
        counts=counts,
    )


@router.get("", response_model=list[CaseResponse])
async def list_cases(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    rows = await db.scalars(
        scope_cases(select(Case), current_user)
        .options(selectinload(Case.client), selectinload(Case.assignments).selectinload(CaseAssignment.user))
        .order_by(Case.created_at.desc())
    )
    return [serialize_case(c) for c in rows.all()]


@router.get("/{case_id}", response_model=CaseResponse)
async def get_case(
    case_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    case = await get_case_or_404(db, case_id, current_user)
    return serialize_case(case)


@router.patch("/{case_id}", response_model=CaseResponse)
async def update_case(
    case_id: int,
    payload: CaseUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    case = await get_case_or_404(db, case_id, current_user)

    if payload.client_id is not None:
        client = await db.scalar(
            select(Client).where(
                Client.id == payload.client_id,
                Client.organization_id == current_user.organization_id,
            )
        )
        if not client:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Client must belong to your organization")

    updates = payload.model_dump(exclude_unset=True, exclude={"assigned_user_ids"})
    next_status = updates.get("status", case.status)
    next_title = updates.get("title", case.title)
    next_client_id = updates.get("client_id", case.client_id)
    validate_case_required_fields(next_status, next_title, next_client_id)
    for key, value in updates.items():
        setattr(case, key, value)

    if payload.assigned_user_ids is not None:
        users = await validate_assignments(db, current_user.organization_id, payload.assigned_user_ids)
        existing_by_user = {a.user_id: a for a in case.assignments}
        wanted = set(payload.assigned_user_ids)
        newly_assigned = wanted - set(existing_by_user)
        for assignment in list(case.assignments):
            if assignment.user_id not in wanted:
                await db.delete(assignment)
        for user in users:
            if user.id not in existing_by_user:
                db.add(CaseAssignment(case_id=case.id, user_id=user.id))
        await notify_case_assigned(
            db,
            case=case,
            actor=current_user,
            newly_assigned_user_ids=newly_assigned,
        )

    case.updated_at = datetime.now(timezone.utc)
    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="case_updated",
        entity_type="case",
        entity_id=str(case.id),
        description=f"Case updated: {case.title}",
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await db.commit()
    reloaded = await get_case_or_404(db, case.id, current_user)
    return serialize_case(reloaded)


@router.delete("/{case_id}")
async def delete_case(
    case_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    case = await get_case_or_404(db, case_id, current_user)
    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="case_deleted",
        entity_type="case",
        entity_id=str(case.id),
        description=f"Case deleted: {case.title}",
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await db.delete(case)
    await db.commit()
    return {"ok": True}


@router.post("/{case_id}/assign", response_model=CaseResponse)
async def assign_case_team(
    case_id: int,
    payload: CaseAssignmentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    case = await get_case_or_404(db, case_id, current_user)
    users = await validate_assignments(db, current_user.organization_id, payload.user_ids)

    existing = {a.user_id for a in case.assignments}
    newly_assigned = {user.id for user in users} - existing
    for user in users:
        if user.id not in existing:
            db.add(CaseAssignment(case_id=case.id, user_id=user.id))

    await notify_case_assigned(
        db,
        case=case,
        actor=current_user,
        newly_assigned_user_ids=newly_assigned,
    )

    case.updated_at = datetime.now(timezone.utc)
    await db.commit()
    reloaded = await get_case_or_404(db, case.id, current_user)
    return serialize_case(reloaded)


@router.get("/{case_id}/team", response_model=list[AssignedUser])
async def get_case_team(
    case_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    case = await get_case_or_404(db, case_id, current_user)
    return [
        AssignedUser(
            id=a.user.id,
            name=a.user.name,
            email=a.user.email,
            role=a.user.role.value,
            status=a.user.status.value,
        )
        for a in case.assignments
    ]


@router.get("/{case_id}/timeline", response_model=list[CaseTimelineResponse])
async def get_case_timeline(
    case_id: int,
    search: str | None = Query(default=None),
    event_type: str | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    completed: bool | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    case = await get_case_or_404(db, case_id, current_user)
    rows = await db.scalars(
        select(CaseTimelineEvent)
        .where(
            CaseTimelineEvent.case_id == case.id,
            CaseTimelineEvent.organization_id == current_user.organization_id,
        )
        .order_by(CaseTimelineEvent.created_at.desc())
    )
    output: list[CaseTimelineResponse] = []
    q = (search or "").strip().lower()
    for e in rows.all():
        meta = e.metadata_json or {}
        ev_date_raw = meta.get("event_date")
        ev_date = None
        if ev_date_raw:
            try:
                ev_date = date.fromisoformat(str(ev_date_raw))
            except ValueError:
                ev_date = None
        row = CaseTimelineResponse(
            id=e.id,
            organization_id=e.organization_id,
            case_id=e.case_id,
            actor_id=e.actor_id,
            event_type=e.event_type,
            title=e.title,
            description=e.description,
            metadata=e.metadata_json,
            created_at=e.created_at,
            status=meta.get("status"),
            completed=meta.get("completed"),
            event_date=ev_date,
            locked=meta.get("locked"),
        )

        if q and q not in f"{row.title} {row.event_type} {row.status or ''} {row.description or ''}".lower():
            continue
        if event_type and row.event_type != event_type:
            continue
        if status_filter and row.status != status_filter:
            continue
        if completed is not None and row.completed is not None and row.completed != completed:
            continue
        if date_from and row.event_date and row.event_date < date_from:
            continue
        if date_to and row.event_date and row.event_date > date_to:
            continue
        output.append(row)
    return output


@router.post("/{case_id}/timeline", response_model=CaseTimelineResponse)
async def create_case_timeline_event(
    case_id: int,
    payload: TimelineEventCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    case = await get_case_or_404(db, case_id, current_user)
    now = datetime.now(timezone.utc)
    meta = {
        "status": payload.status or "active",
        "completed": payload.completed,
        "event_date": (payload.event_date or now.date()).isoformat(),
        "locked": False,
    }
    row = CaseTimelineEvent(
        organization_id=current_user.organization_id,
        case_id=case.id,
        actor_id=current_user.id,
        event_type=payload.event_type,
        title=payload.title,
        description=payload.description,
        metadata_json=meta,
        created_at=now,
    )
    db.add(row)
    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="timeline_event_created",
        entity_type="case_timeline_event",
        entity_id=str(row.id) if getattr(row, "id", None) else None,
        description=f"Timeline event created: {payload.title}",
        metadata_json={"case_id": case.id, "event_type": payload.event_type},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await db.commit()
    await db.refresh(row)
    return CaseTimelineResponse(
        id=row.id,
        organization_id=row.organization_id,
        case_id=row.case_id,
        actor_id=row.actor_id,
        event_type=row.event_type,
        title=row.title,
        description=row.description,
        metadata=row.metadata_json,
        created_at=row.created_at,
        status=meta["status"],
        completed=meta["completed"],
        event_date=date.fromisoformat(meta["event_date"]),
        locked=meta["locked"],
    )


@router.patch("/{case_id}/timeline/{event_id}", response_model=CaseTimelineResponse)
async def update_case_timeline_event(
    case_id: int,
    event_id: int,
    payload: TimelineEventUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    case = await get_case_or_404(db, case_id, current_user)
    row = await db.scalar(
        select(CaseTimelineEvent).where(
            CaseTimelineEvent.id == event_id,
            CaseTimelineEvent.case_id == case.id,
            CaseTimelineEvent.organization_id == current_user.organization_id,
        )
    )
    if not row:
        raise HTTPException(status_code=404, detail="Timeline event not found")

    updates = payload.model_dump(exclude_unset=True)
    if "title" in updates:
        row.title = updates["title"]
    if "event_type" in updates:
        row.event_type = updates["event_type"]
    if "description" in updates:
        row.description = updates["description"]

    meta = dict(row.metadata_json or {})
    for k in ("status", "completed", "locked"):
        if k in updates:
            meta[k] = updates[k]
    if "event_date" in updates:
        meta["event_date"] = updates["event_date"].isoformat() if updates["event_date"] else None
    row.metadata_json = meta

    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="timeline_event_updated",
        entity_type="case_timeline_event",
        entity_id=str(row.id),
        description=f"Timeline event updated: {row.title}",
        metadata_json={"case_id": case.id, "event_type": row.event_type},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await db.commit()
    await db.refresh(row)
    ev_date = None
    if meta.get("event_date"):
        try:
            ev_date = date.fromisoformat(str(meta.get("event_date")))
        except ValueError:
            ev_date = None
    return CaseTimelineResponse(
        id=row.id,
        organization_id=row.organization_id,
        case_id=row.case_id,
        actor_id=row.actor_id,
        event_type=row.event_type,
        title=row.title,
        description=row.description,
        metadata=row.metadata_json,
        created_at=row.created_at,
        status=meta.get("status"),
        completed=meta.get("completed"),
        event_date=ev_date,
        locked=meta.get("locked"),
    )


@router.delete("/{case_id}/timeline/{event_id}")
async def delete_case_timeline_event(
    case_id: int,
    event_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    case = await get_case_or_404(db, case_id, current_user)
    row = await db.scalar(
        select(CaseTimelineEvent).where(
            CaseTimelineEvent.id == event_id,
            CaseTimelineEvent.case_id == case.id,
            CaseTimelineEvent.organization_id == current_user.organization_id,
        )
    )
    if not row:
        raise HTTPException(status_code=404, detail="Timeline event not found")
    await log_audit_event(
        db,
        organization_id=current_user.organization_id,
        user_id=current_user.id,
        action="timeline_event_deleted",
        entity_type="case_timeline_event",
        entity_id=str(row.id),
        description=f"Timeline event deleted: {row.title}",
        metadata_json={"case_id": case.id, "event_type": row.event_type},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    await db.delete(row)
    await db.commit()
    return {"ok": True}
