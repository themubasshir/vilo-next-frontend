from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import role_guard
from app.db.session import get_db
from app.models.case import Case
from app.models.client import Client
from app.models.enums import UserRole
from app.models.task import Task
from app.models.user import User
from app.schemas.task import TaskCreate, TaskResponse, TaskUpdate
from app.services.email import build_task_assignment_email
from app.services.jobs import enqueue_email
from app.services.notifications import create_notification
from app.services.timeline import create_case_timeline_event
from app.services.reminders import suppress_obsolete_reminders

router = APIRouter(prefix="/tasks", tags=["tasks"])
ALLOWED_STAFF = ["partner", "admin", "lawyer", "paralegal"]
VALID_STATUS = {"not_started", "in_progress", "waiting", "completed"}
STATUS_ALIASES = {
    "pending": "not_started",
    "todo": "not_started",
    "not-started": "not_started",
    "in-progress": "in_progress",
    "on_hold": "waiting",
    "hold": "waiting",
    "done": "completed",
    "cancelled": "completed",
}
VALID_PRIORITY = {"low", "medium", "high", "urgent"}
PRIORITY_ALIASES = {"normal": "medium", "critical": "urgent"}
VALID_TASK_TYPES = {"general", "deadline", "court", "client_follow_up", "document", "billing", "other"}
WORKFLOW_ONLY_FIELDS = {"status"}
TASK_TYPE_ALIASES = {
    "client-follow-up": "client_follow_up",
    "follow_up": "client_follow_up",
    "followup": "client_follow_up",
}
OPEN_TASK_STATUSES = ("not_started", "in_progress", "waiting", "pending")
COMPLETED_STATUS_EQUIVALENTS = {"completed", "cancelled"}


def _normalize_token(value: str) -> str:
    return value.strip().lower()


def normalize_status(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = _normalize_token(value)
    return STATUS_ALIASES.get(normalized, normalized)


def normalize_priority(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = _normalize_token(value)
    return PRIORITY_ALIASES.get(normalized, normalized)


def normalize_task_type(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = _normalize_token(value)
    return TASK_TYPE_ALIASES.get(normalized, normalized)


def is_completed_status(value: str | None) -> bool:
    if value is None:
        return False
    return _normalize_token(value) in COMPLETED_STATUS_EQUIVALENTS or normalize_status(value) == "completed"


def is_task_overdue(task: Task, *, today: date | None = None) -> bool:
    if not task.due_date or task.archived_at is not None or is_completed_status(task.status):
        return False
    compare_day = today or datetime.now(timezone.utc).date()
    return task.due_date.astimezone(timezone.utc).date() < compare_day


def serialize(task: Task) -> TaskResponse:
    normalized_status = normalize_status(task.status) or "not_started"
    normalized_priority = normalize_priority(task.priority) or "medium"
    normalized_task_type = normalize_task_type(task.task_type) or "general"
    return TaskResponse(
        id=task.id,
        organization_id=task.organization_id,
        case_id=task.case_id,
        client_id=task.client_id,
        assigned_to=task.assigned_to,
        assigned_user_id=task.assigned_to,
        created_by=task.created_by,
        title=task.title,
        description=task.description,
        task_type=normalized_task_type,
        status=normalized_status,
        priority=normalized_priority,
        due_date=task.due_date,
        reminder_at=task.reminder_at,
        notes=task.notes,
        completed_at=task.completed_at,
        archived_at=task.archived_at,
        is_overdue=is_task_overdue(task),
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


async def get_task_or_404(db: AsyncSession, organization_id: int, task_id: int) -> Task:
    task = await db.scalar(select(Task).where(Task.id == task_id, Task.organization_id == organization_id))
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return task


async def validate_case(db: AsyncSession, organization_id: int, case_id: int | None) -> Case | None:
    if case_id is None:
        return None
    case = await db.scalar(select(Case).where(Case.id == case_id, Case.organization_id == organization_id))
    if not case:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Case must belong to your organization")
    return case


async def validate_client(db: AsyncSession, organization_id: int, client_id: int | None) -> Client | None:
    if client_id is None:
        return None
    client = await db.scalar(select(Client).where(Client.id == client_id, Client.organization_id == organization_id))
    if not client:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Client must belong to your organization")
    return client


async def validate_assignee(db: AsyncSession, organization_id: int, user_id: int | None) -> User | None:
    if user_id is None:
        return None
    user = await db.scalar(select(User).where(User.id == user_id, User.organization_id == organization_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Assignee must belong to your organization")
    if user.role == UserRole.client:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Client users cannot be assigned internal tasks")
    return user


async def resolve_links(
    db: AsyncSession,
    *,
    organization_id: int,
    case_id: int | None,
    client_id: int | None,
) -> tuple[Case | None, Client | None, int | None]:
    case = await validate_case(db, organization_id, case_id)
    client = await validate_client(db, organization_id, client_id)

    resolved_client_id = client.id if client else None
    if case:
        if resolved_client_id is not None and case.client_id != resolved_client_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Client must match the selected case")
        if resolved_client_id is None:
            resolved_client_id = case.client_id
            client = await validate_client(db, organization_id, resolved_client_id)

    return case, client, resolved_client_id


def validate_values(status_value: str | None, priority_value: str | None, task_type_value: str | None) -> tuple[str | None, str | None, str | None]:
    normalized_status = normalize_status(status_value)
    normalized_priority = normalize_priority(priority_value)
    normalized_task_type = normalize_task_type(task_type_value)

    if normalized_status is not None and normalized_status not in VALID_STATUS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid task status")
    if normalized_priority is not None and normalized_priority not in VALID_PRIORITY:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid task priority")
    if normalized_task_type is not None and normalized_task_type not in VALID_TASK_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid task type")
    return normalized_status, normalized_priority, normalized_task_type


def _day_bounds(target_day: date) -> tuple[datetime, datetime]:
    start = datetime.combine(target_day, time.min, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    return start, end


def _week_bounds(today: date) -> tuple[datetime, datetime]:
    week_start = today - timedelta(days=today.weekday())
    start = datetime.combine(week_start, time.min, tzinfo=timezone.utc)
    end = start + timedelta(days=7)
    return start, end


async def maybe_notify_assignee(
    *,
    db: AsyncSession,
    background_tasks: BackgroundTasks,
    current_user: User,
    task: Task,
    assignee: User | None,
    previous_assigned_to: int | None,
) -> None:
    if not task.assigned_to or task.assigned_to == current_user.id or task.assigned_to == previous_assigned_to:
        return
    if assignee is None:
        assignee = await validate_assignee(db, current_user.organization_id, task.assigned_to)
    if assignee is None:
        return
    await create_notification(
        db,
        organization_id=current_user.organization_id,
        user_id=task.assigned_to,
        type="task_assigned",
        title="Task Assigned",
        body=f"{current_user.name} assigned you to the task: {task.title}.",
        metadata_json={
            "task_id": task.id,
            "case_id": task.case_id,
            "actor_user_id": current_user.id,
            "link": f"/dashboard/tasks/{task.id}",
        },
    )
    if assignee.email:
        subject, html_body, text_body = build_task_assignment_email(assignee_name=assignee.name, task_title=task.title, task_id=task.id)
        enqueue_email(background_tasks, to_email=assignee.email, subject=subject, html_body=html_body, text_body=text_body)


@router.post("", response_model=TaskResponse)
async def create_task(
    payload: TaskCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    normalized_status, normalized_priority, normalized_task_type = validate_values(payload.status, payload.priority, payload.task_type)
    case, _client, resolved_client_id = await resolve_links(
        db,
        organization_id=current_user.organization_id,
        case_id=payload.case_id,
        client_id=payload.client_id,
    )
    assignee = await validate_assignee(db, current_user.organization_id, payload.assigned_to)

    now = datetime.now(timezone.utc)
    task = Task(
        organization_id=current_user.organization_id,
        case_id=case.id if case else None,
        client_id=resolved_client_id,
        assigned_to=payload.assigned_to,
        created_by=current_user.id,
        title=payload.title,
        description=payload.description,
        task_type=normalized_task_type or "general",
        status=normalized_status or "not_started",
        priority=normalized_priority or "medium",
        due_date=payload.due_date,
        reminder_at=payload.reminder_at,
        notes=payload.notes,
        completed_at=now if normalized_status == "completed" else None,
        archived_at=None,
        created_at=now,
        updated_at=now,
    )
    db.add(task)
    await db.flush()

    if task.case_id:
        await create_case_timeline_event(
            db,
            organization_id=current_user.organization_id,
            case_id=task.case_id,
            actor_id=current_user.id,
            event_type="task_created",
            title=f"Task created: {task.title}",
            metadata_json={"task_id": task.id, "status": task.status, "priority": task.priority},
        )

    await maybe_notify_assignee(
        db=db,
        background_tasks=background_tasks,
        current_user=current_user,
        task=task,
        assignee=assignee,
        previous_assigned_to=None,
    )

    await db.commit()
    await db.refresh(task)
    return serialize(task)


@router.get("", response_model=list[TaskResponse])
async def list_tasks(
    assigned_user_id: int | None = Query(default=None),
    assigned_to: int | None = Query(default=None),
    status_value: str | None = Query(default=None, alias="status"),
    priority: str | None = Query(default=None),
    due_date: date | None = Query(default=None),
    due_from: date | None = Query(default=None),
    due_to: date | None = Query(default=None),
    task_type: str | None = Query(default=None),
    case_id: int | None = Query(default=None),
    client_id: int | None = Query(default=None),
    quick_view: str | None = Query(default="all"),
    include_archived: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    org_id = current_user.organization_id
    query = select(Task).where(Task.organization_id == org_id)

    if not include_archived:
        query = query.where(Task.archived_at.is_(None))

    assignee_id = assigned_user_id if assigned_user_id is not None else assigned_to
    if assignee_id is not None:
        await validate_assignee(db, org_id, assignee_id)
        query = query.where(Task.assigned_to == assignee_id)

    normalized_status = normalize_status(status_value)
    if normalized_status is not None:
        if normalized_status not in VALID_STATUS:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid task status")
        query = query.where(Task.status.in_({status_value, normalized_status} if status_value else {normalized_status}))

    normalized_priority = normalize_priority(priority)
    if normalized_priority is not None:
        if normalized_priority not in VALID_PRIORITY:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid task priority")
        query = query.where(Task.priority.in_({priority, normalized_priority} if priority else {normalized_priority}))

    normalized_task_type = normalize_task_type(task_type)
    if normalized_task_type is not None:
        if normalized_task_type not in VALID_TASK_TYPES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid task type")
        query = query.where(Task.task_type.in_({task_type, normalized_task_type} if task_type else {normalized_task_type}))

    if case_id is not None:
        await validate_case(db, org_id, case_id)
        query = query.where(Task.case_id == case_id)

    if client_id is not None:
        await validate_client(db, org_id, client_id)
        query = query.where(Task.client_id == client_id)

    if due_date is not None:
        start, end = _day_bounds(due_date)
        query = query.where(Task.due_date >= start, Task.due_date < end)

    if due_from is not None:
        start, _ = _day_bounds(due_from)
        query = query.where(Task.due_date >= start)

    if due_to is not None:
        _, end = _day_bounds(due_to)
        query = query.where(Task.due_date < end)

    today = datetime.now(timezone.utc).date()
    quick_view_value = (quick_view or "all").strip().lower()
    if quick_view_value == "my_tasks":
        query = query.where(Task.assigned_to == current_user.id)
    elif quick_view_value == "due_today":
        start, end = _day_bounds(today)
        query = query.where(Task.due_date >= start, Task.due_date < end, Task.status.in_(OPEN_TASK_STATUSES))
    elif quick_view_value == "overdue":
        start, _ = _day_bounds(today)
        query = query.where(Task.due_date.is_not(None), Task.due_date < start, Task.status.in_(OPEN_TASK_STATUSES))
    elif quick_view_value == "this_week":
        start, end = _week_bounds(today)
        query = query.where(Task.due_date >= start, Task.due_date < end)
    elif quick_view_value == "high_priority":
        query = query.where(Task.priority.in_(["high", "urgent"]))
    elif quick_view_value == "completed":
        query = query.where(Task.status.in_(["completed", "cancelled"]))
    elif quick_view_value != "all":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid quick view")

    rows = await db.scalars(query.order_by(Task.due_date.asc().nullslast(), Task.created_at.desc()))
    return [serialize(task) for task in rows.all()]


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    task = await get_task_or_404(db, current_user.organization_id, task_id)
    return serialize(task)


@router.patch("/{task_id}", response_model=TaskResponse)
async def update_task(
    task_id: int,
    payload: TaskUpdate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    task = await get_task_or_404(db, current_user.organization_id, task_id)
    updates = payload.model_dump(exclude_unset=True)
    if current_user.role not in {UserRole.admin, UserRole.partner} and not set(updates).issubset(WORKFLOW_ONLY_FIELDS):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to edit this task.")
    reminder_material_fields = {"due_date", "reminder_at", "status", "archived_at", "assigned_to", "case_id", "client_id", "title"}
    if reminder_material_fields.intersection(updates):
        await suppress_obsolete_reminders(
            db, organization_id=current_user.organization_id, entity="task", entity_id=task.id,
        )

    normalized_status, normalized_priority, normalized_task_type = validate_values(
        updates.get("status"),
        updates.get("priority"),
        updates.get("task_type"),
    )
    previous_assigned_to = task.assigned_to

    if "case_id" in updates or "client_id" in updates:
        case_id = updates["case_id"] if "case_id" in updates else task.case_id
        client_id = updates["client_id"] if "client_id" in updates else task.client_id
        case, _client, resolved_client_id = await resolve_links(
            db,
            organization_id=current_user.organization_id,
            case_id=case_id,
            client_id=client_id,
        )
        task.case_id = case.id if case else None
        task.client_id = resolved_client_id

    assignee = None
    if "assigned_to" in updates:
        assignee = await validate_assignee(db, current_user.organization_id, updates["assigned_to"])
        task.assigned_to = updates["assigned_to"]

    if "title" in updates:
        task.title = updates["title"]
    if "description" in updates:
        task.description = updates["description"]
    if "task_type" in updates:
        task.task_type = normalized_task_type or task.task_type
    if "status" in updates:
        task.status = normalized_status or task.status
    if "priority" in updates:
        task.priority = normalized_priority or task.priority
    if "due_date" in updates:
        task.due_date = updates["due_date"]
    if "reminder_at" in updates:
        task.reminder_at = updates["reminder_at"]
    if "notes" in updates:
        task.notes = updates["notes"]
    if "completed_at" in updates:
        task.completed_at = updates["completed_at"]
    if "archived_at" in updates:
        task.archived_at = updates["archived_at"]

    if is_completed_status(task.status):
        if task.completed_at is None:
            task.completed_at = datetime.now(timezone.utc)
    else:
        task.completed_at = None

    task.updated_at = datetime.now(timezone.utc)
    await maybe_notify_assignee(
        db=db,
        background_tasks=background_tasks,
        current_user=current_user,
        task=task,
        assignee=assignee,
        previous_assigned_to=previous_assigned_to,
    )
    await db.commit()
    await db.refresh(task)
    return serialize(task)


@router.post("/{task_id}/complete", response_model=TaskResponse)
async def complete_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    task = await get_task_or_404(db, current_user.organization_id, task_id)

    now = datetime.now(timezone.utc)
    task.status = "completed"
    task.completed_at = now
    task.updated_at = now

    await suppress_obsolete_reminders(
        db, organization_id=current_user.organization_id, entity="task", entity_id=task.id, now=now,
    )

    if task.case_id:
        await create_case_timeline_event(
            db,
            organization_id=current_user.organization_id,
            case_id=task.case_id,
            actor_id=current_user.id,
            event_type="task_completed",
            title=f"Task completed: {task.title}",
            metadata_json={"task_id": task.id},
        )

    await db.commit()
    await db.refresh(task)
    return serialize(task)


@router.post("/{task_id}/archive", response_model=TaskResponse)
async def archive_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    task = await get_task_or_404(db, current_user.organization_id, task_id)
    now = datetime.now(timezone.utc)
    task.archived_at = now
    task.updated_at = now
    await suppress_obsolete_reminders(
        db, organization_id=current_user.organization_id, entity="task", entity_id=task.id, now=now,
    )
    await db.commit()
    await db.refresh(task)
    return serialize(task)


@router.delete("/{task_id}")
async def delete_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(role_guard(ALLOWED_STAFF)),
):
    task = await get_task_or_404(db, current_user.organization_id, task_id)
    if current_user.role != UserRole.admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to delete this task.")
    now = datetime.now(timezone.utc)
    task.archived_at = task.archived_at or now
    task.updated_at = now
    await suppress_obsolete_reminders(
        db, organization_id=current_user.organization_id, entity="task", entity_id=task.id, now=now,
    )
    await db.commit()
    return {"ok": True, "archived": True}
