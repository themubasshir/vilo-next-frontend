from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import role_guard
from app.db.session import get_db
from app.models.calendar_event import CalendarEvent
from app.models.case import Case, CaseAssignment
from app.models.case_timeline_event import CaseTimelineEvent
from app.models.client import Client
from app.models.expense import Expense
from app.models.invoice import Invoice
from app.models.invoice_payment import InvoicePayment
from app.models.task import Task
from app.models.time_entry import TimeEntry
from app.models.trust_ledger import TrustLedger
from app.models.trust_transaction import TrustTransaction
from app.models.user import User
from app.models.enums import UserRole
from app.schemas.billing import RevenueByStaffRow, TimeByStaffRow
from app.schemas.dashboard import DashboardWidgetsResponse
from app.services.billing import build_revenue_by_staff_report, build_time_by_staff_report
from app.services.finance import derive_invoice_status, summarize_invoice_payment_method
from app.services.message_unread import unread_messages_count as count_unread_messages
from app.services.pdf import generate_report_pdf

router = APIRouter(prefix="/reports", tags=["reports"])
OPER_REPORTS = ["partner", "admin", "lawyer"]
WIDGET_ROLES = ["partner", "admin", "lawyer", "paralegal"]
CASE_TASK_REPORTS = ["partner", "admin", "lawyer", "paralegal"]
OPEN_TASK_STATUSES = ["pending", "not_started", "in_progress", "waiting"]


def d(value):
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _time_entry_date_expr():
    return func.date(func.coalesce(TimeEntry.start_time, TimeEntry.created_at))


def _month_bounds(now: datetime) -> tuple[date, date]:
    month_start = date(now.year, now.month, 1)
    if now.month == 12:
        next_start = date(now.year + 1, 1, 1)
    else:
        next_start = date(now.year, now.month + 1, 1)
    return month_start, next_start


def _invoice_row(inv: Invoice) -> dict:
    return {
        "id": inv.id,
        "invoice_number": inv.invoice_number,
        "client_id": inv.client_id,
        "client_name": getattr(getattr(inv, "client", None), "name", None),
        "case_id": inv.case_id,
        "matter_title": getattr(getattr(inv, "case", None), "title", None),
        "status": inv.status,
        "display_status": derive_invoice_status(inv),
        "payment_method": summarize_invoice_payment_method(inv),
        "issue_date": inv.issue_date,
        "due_date": inv.due_date,
        "currency": getattr(inv, "currency", "USD"),
        "total": d(inv.total),
        "paid_amount": d(inv.paid_amount),
        "balance_due": d(inv.balance_due),
        "tax_amount": d(inv.tax_amount),
        "created_by": inv.created_by,
    }


@router.get("/dashboard/widgets", response_model=DashboardWidgetsResponse)
async def dashboard_widgets(db: AsyncSession = Depends(get_db), current_user=Depends(role_guard(WIDGET_ROLES))):
    org_id = current_user.organization_id
    now = datetime.now(timezone.utc)
    today = now.date()
    month_start, next_month_start = _month_bounds(now)
    is_paralegal = current_user.role == UserRole.paralegal

    if is_paralegal:
        assigned_case_ids = select(CaseAssignment.case_id).where(CaseAssignment.user_id == current_user.id)
        case_scope = [Case.organization_id == org_id, Case.id.in_(assigned_case_ids)]
        task_scope = [Task.organization_id == org_id, Task.assigned_to == current_user.id, Task.archived_at.is_(None)]

        total_cases = int((await db.scalar(select(func.count(Case.id)).where(*case_scope))) or 0)
        active_cases = int((await db.scalar(select(func.count(Case.id)).where(*case_scope, Case.status == "active"))) or 0)
        closed_cases = int((await db.scalar(select(func.count(Case.id)).where(*case_scope, Case.status == "closed"))) or 0)
        pending_cases = int((await db.scalar(select(func.count(Case.id)).where(*case_scope, Case.status == "draft"))) or 0)
        high_priority_cases = int((await db.scalar(select(func.count(Case.id)).where(*case_scope, Case.priority == "high"))) or 0)
        total_tasks = int((await db.scalar(select(func.count(Task.id)).where(*task_scope))) or 0)
        stalled_cases = int((await db.scalar(select(func.count(Case.id)).where(*case_scope, Case.status == "active", Case.updated_at < (now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=30))))) or 0)
        court_cases = int((await db.scalar(
            select(func.count(func.distinct(CalendarEvent.case_id))).where(
                CalendarEvent.organization_id == org_id,
                CalendarEvent.case_id.in_(assigned_case_ids),
                CalendarEvent.event_type == "court",
            )
        )) or 0)
        case_status_percentage = int(round((active_cases / total_cases) * 100)) if total_cases else 0

        due_today_count = int((await db.scalar(
            select(func.count(Task.id)).where(
                *task_scope,
                Task.status.in_(OPEN_TASK_STATUSES),
                Task.due_date.is_not(None),
                func.date(Task.due_date) == today,
            )
        )) or 0)
        overdue_count = int((await db.scalar(
            select(func.count(Task.id)).where(
                *task_scope,
                Task.status.in_(OPEN_TASK_STATUSES),
                Task.due_date.is_not(None),
                Task.due_date < now,
            )
        )) or 0)
        unread_messages_count = await count_unread_messages(db, organization_id=org_id, user_id=current_user.id)
        priority_rows = (await db.execute(
            select(Task.id, Task.title, Task.priority, Task.due_date, Task.case_id)
            .where(*task_scope, Task.status.in_(OPEN_TASK_STATUSES))
            .order_by(Task.due_date.asc().nullslast(), Task.created_at.desc())
            .limit(8)
        )).all()

        upcoming_rows = (await db.execute(
            select(CalendarEvent.id, CalendarEvent.title, CalendarEvent.event_type, CalendarEvent.start_at, CalendarEvent.case_id)
            .where(
                CalendarEvent.organization_id == org_id,
                CalendarEvent.start_at >= now,
                ((CalendarEvent.created_by == current_user.id) | (CalendarEvent.case_id.in_(assigned_case_ids))),
            )
            .order_by(CalendarEvent.start_at.asc())
            .limit(12)
        )).all()

        case_rows = (await db.execute(
            select(Case.id, Case.title, Case.status, Client.name, User.name.label("lead_name"), func.min(Task.due_date).label("next_due"))
            .join(Client, Client.id == Case.client_id)
            .join(User, User.id == Case.created_by)
            .outerjoin(Task, and_(Task.case_id == Case.id, Task.organization_id == org_id, Task.assigned_to == current_user.id, Task.status.in_(OPEN_TASK_STATUSES), Task.archived_at.is_(None)))
            .where(*case_scope, Case.status == "active")
            .group_by(Case.id, Case.title, Case.status, Client.name, User.name)
            .order_by(Case.updated_at.desc())
            .limit(20)
        )).all()

        return {
            "firm_snapshot": {
                "total_cases": total_cases,
                "active_cases": active_cases,
                "court_cases": court_cases,
                "cases_in_court": court_cases,
                "closed_cases": closed_cases,
                "pending_cases": pending_cases,
                "high_priority_cases": high_priority_cases,
                "total_tasks": total_tasks,
                "stalled_cases": stalled_cases,
                "case_status_percentage": case_status_percentage,
            },
            "today_overview": {
                "due_today_count": due_today_count,
                "overdue_count": overdue_count,
                "unread_messages_count": unread_messages_count,
                "priority_timeline": [
                    {
                        "id": r.id,
                        "title": r.title,
                        "type": "task",
                        "priority": (r.priority or "medium"),
                        "due_date": r.due_date,
                        "related_case_id": r.case_id,
                    }
                    for r in priority_rows
                ],
            },
            "calendar_overview": {
                "month": month_start.month,
                "year": month_start.year,
                "upcoming_events": [
                    {
                        "id": r.id,
                        "title": r.title,
                        "type": r.event_type,
                        "starts_at": r.start_at,
                        "time": r.start_at.strftime("%I:%M %p"),
                        "related_case_id": r.case_id,
                    }
                    for r in upcoming_rows
                ],
            },
            "financial_overview": None,
            "billing_overview": None,
            "active_cases": [
                {
                    "case_id": r.id,
                    "display_number": f"C-{r.id}",
                    "client_name": r.name,
                    "matter": r.title,
                    "lead": r.lead_name,
                    "status": r.status,
                    "due_date": r.next_due,
                }
                for r in case_rows
            ],
        }

    total_cases = int((await db.scalar(select(func.count(Case.id)).where(Case.organization_id == org_id))) or 0)
    active_cases = int((await db.scalar(select(func.count(Case.id)).where(Case.organization_id == org_id, Case.status == "active"))) or 0)
    closed_cases = int((await db.scalar(select(func.count(Case.id)).where(Case.organization_id == org_id, Case.status == "closed"))) or 0)
    pending_cases = int((await db.scalar(select(func.count(Case.id)).where(Case.organization_id == org_id, Case.status == "draft"))) or 0)
    high_priority_cases = int((await db.scalar(select(func.count(Case.id)).where(Case.organization_id == org_id, Case.priority == "high"))) or 0)
    total_tasks = int((await db.scalar(select(func.count(Task.id)).where(Task.organization_id == org_id, Task.archived_at.is_(None)))) or 0)
    stalled_cases = int((await db.scalar(select(func.count(Case.id)).where(Case.organization_id == org_id, Case.status == "active", Case.updated_at < (now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=30))))) or 0)

    court_cases = int((await db.scalar(
        select(func.count(func.distinct(CalendarEvent.case_id))).where(
            CalendarEvent.organization_id == org_id,
            CalendarEvent.case_id.is_not(None),
            CalendarEvent.event_type == "court",
        )
    )) or 0)
    case_status_percentage = int(round((active_cases / total_cases) * 100)) if total_cases else 0

    due_today_count = int((await db.scalar(
        select(func.count(Task.id)).where(
            Task.organization_id == org_id,
            Task.status.in_(OPEN_TASK_STATUSES),
            Task.archived_at.is_(None),
            Task.due_date.is_not(None),
            func.date(Task.due_date) == today,
        )
    )) or 0)
    overdue_count = int((await db.scalar(
        select(func.count(Task.id)).where(
            Task.organization_id == org_id,
            Task.status.in_(OPEN_TASK_STATUSES),
            Task.archived_at.is_(None),
            Task.due_date.is_not(None),
            Task.due_date < now,
        )
    )) or 0)
    unread_messages_count = await count_unread_messages(db, organization_id=org_id, user_id=current_user.id)
    priority_rows = (await db.execute(
        select(Task.id, Task.title, Task.priority, Task.due_date, Task.case_id)
        .where(
            Task.organization_id == org_id,
            Task.status.in_(OPEN_TASK_STATUSES),
            Task.archived_at.is_(None),
        )
        .order_by(Task.due_date.asc().nullslast(), Task.created_at.desc())
        .limit(8)
    )).all()

    upcoming_rows = (await db.execute(
        select(CalendarEvent.id, CalendarEvent.title, CalendarEvent.event_type, CalendarEvent.start_at, CalendarEvent.case_id)
        .where(CalendarEvent.organization_id == org_id, CalendarEvent.start_at >= now)
        .order_by(CalendarEvent.start_at.asc())
        .limit(12)
    )).all()

    monthly_revenue = d(await db.scalar(
        select(func.coalesce(func.sum(Invoice.total), 0)).where(
            Invoice.organization_id == org_id,
            Invoice.issue_date >= month_start,
            Invoice.issue_date < next_month_start,
        )
    ))
    monthly_expenses = d(await db.scalar(
        select(func.coalesce(func.sum(Expense.amount), 0)).where(
            Expense.organization_id == org_id,
            Expense.expense_date >= month_start,
            Expense.expense_date < next_month_start,
        )
    ))
    trust_account_balance = d(await db.scalar(
        select(func.coalesce(func.sum(TrustLedger.current_balance), 0)).where(TrustLedger.organization_id == org_id)
    ))
    net_profit = monthly_revenue - monthly_expenses

    month_series = (await db.execute(
        select(func.date_trunc("month", Invoice.issue_date).label("month"), func.coalesce(func.sum(Invoice.total), 0).label("amount"))
        .where(Invoice.organization_id == org_id)
        .group_by("month")
        .order_by("month")
    )).all()

    paid_total = d(await db.scalar(select(func.coalesce(func.sum(Invoice.total), 0)).where(Invoice.organization_id == org_id, Invoice.status == "paid")))
    unpaid_total = d(await db.scalar(select(func.coalesce(func.sum(Invoice.balance_due), 0)).where(Invoice.organization_id == org_id, Invoice.status.in_(["sent", "overdue"]))))
    draft_total = d(await db.scalar(select(func.coalesce(func.sum(Invoice.total), 0)).where(Invoice.organization_id == org_id, Invoice.status == "draft")))
    overdue_total = d(await db.scalar(select(func.coalesce(func.sum(Invoice.balance_due), 0)).where(Invoice.organization_id == org_id, Invoice.status == "overdue")))

    case_rows = (await db.execute(
        select(Case.id, Case.title, Case.status, Client.name, User.name.label("lead_name"), func.min(Task.due_date).label("next_due"))
        .join(Client, Client.id == Case.client_id)
        .join(User, User.id == Case.created_by)
        .outerjoin(Task, and_(Task.case_id == Case.id, Task.organization_id == org_id, Task.status.in_(OPEN_TASK_STATUSES), Task.archived_at.is_(None)))
        .where(Case.organization_id == org_id, Case.status == "active")
        .group_by(Case.id, Case.title, Case.status, Client.name, User.name)
        .order_by(Case.updated_at.desc())
        .limit(20)
    )).all()

    return {
        "firm_snapshot": {
            "total_cases": total_cases,
            "active_cases": active_cases,
            "court_cases": court_cases,
            "cases_in_court": court_cases,
            "closed_cases": closed_cases,
            "pending_cases": pending_cases,
            "high_priority_cases": high_priority_cases,
            "total_tasks": total_tasks,
            "stalled_cases": stalled_cases,
            "case_status_percentage": case_status_percentage,
        },
        "today_overview": {
            "due_today_count": due_today_count,
            "overdue_count": overdue_count,
            "unread_messages_count": unread_messages_count,
            "priority_timeline": [
                {
                    "id": r.id,
                    "title": r.title,
                    "type": "task",
                    "priority": (r.priority or "medium"),
                    "due_date": r.due_date,
                    "related_case_id": r.case_id,
                }
                for r in priority_rows
            ],
        },
        "calendar_overview": {
            "month": month_start.month,
            "year": month_start.year,
            "upcoming_events": [
                {
                    "id": r.id,
                    "title": r.title,
                    "type": r.event_type,
                    "starts_at": r.start_at,
                    "time": r.start_at.strftime("%I:%M %p"),
                    "related_case_id": r.case_id,
                }
                for r in upcoming_rows
            ],
        },
        "financial_overview": {
            "monthly_revenue": monthly_revenue,
            "monthly_expenses": monthly_expenses,
            "net_profit": net_profit,
            "trust_account_balance": trust_account_balance,
            "monthly_chart_series": [{"month": r.month, "amount": d(r.amount)} for r in month_series],
        },
        "billing_overview": {
            "paid_total": paid_total,
            "unpaid_total": unpaid_total,
            "draft_total": draft_total,
            "overdue_total": overdue_total,
            "chart_series": [
                {"label": "Paid", "value": paid_total},
                {"label": "Unpaid", "value": unpaid_total},
                {"label": "Draft", "value": draft_total},
                {"label": "Overdue", "value": overdue_total},
            ],
        },
        "active_cases": [
            {
                "case_id": r.id,
                "display_number": f"C-{r.id}",
                "client_name": r.name,
                "matter": r.title,
                "lead": r.lead_name,
                "status": r.status,
                "due_date": r.next_due,
            }
            for r in case_rows
        ],
    }


@router.get("/dashboard-summary")
async def dashboard_summary(db: AsyncSession = Depends(get_db), current_user=Depends(role_guard(OPER_REPORTS))):
    org_id = current_user.organization_id
    now = datetime.now(timezone.utc)

    total_clients = int((await db.scalar(select(func.count(Client.id)).where(Client.organization_id == org_id))) or 0)
    total_cases = int((await db.scalar(select(func.count(Case.id)).where(Case.organization_id == org_id))) or 0)
    active_cases = int((await db.scalar(select(func.count(Case.id)).where(Case.organization_id == org_id, Case.status == "active"))) or 0)
    closed_cases = int((await db.scalar(select(func.count(Case.id)).where(Case.organization_id == org_id, Case.status == "closed"))) or 0)
    pending_tasks = int((await db.scalar(select(func.count(Task.id)).where(Task.organization_id == org_id, Task.status.in_(OPEN_TASK_STATUSES), Task.archived_at.is_(None)))) or 0)
    overdue_tasks = int((await db.scalar(select(func.count(Task.id)).where(Task.organization_id == org_id, Task.status.in_(OPEN_TASK_STATUSES), Task.archived_at.is_(None), Task.due_date.is_not(None), Task.due_date < now))) or 0)
    upcoming_events = int((await db.scalar(select(func.count(CalendarEvent.id)).where(CalendarEvent.organization_id == org_id, CalendarEvent.start_at >= now))) or 0)
    outstanding_invoices = int((await db.scalar(select(func.count(Invoice.id)).where(Invoice.organization_id == org_id, Invoice.balance_due > 0))) or 0)
    total_invoice_amount = d(await db.scalar(select(func.coalesce(func.sum(Invoice.total), 0)).where(Invoice.organization_id == org_id)))
    total_paid_amount = d(await db.scalar(select(func.coalesce(func.sum(Invoice.paid_amount), 0)).where(Invoice.organization_id == org_id)))
    total_balance_due = d(await db.scalar(select(func.coalesce(func.sum(Invoice.balance_due), 0)).where(Invoice.organization_id == org_id)))
    total_trust_balance = d(await db.scalar(select(func.coalesce(func.sum(TrustLedger.current_balance), 0)).where(TrustLedger.organization_id == org_id)))

    recent_activity = (await db.execute(
        select(CaseTimelineEvent.id, CaseTimelineEvent.case_id, CaseTimelineEvent.actor_id, CaseTimelineEvent.event_type, CaseTimelineEvent.title, CaseTimelineEvent.created_at)
        .where(CaseTimelineEvent.organization_id == org_id)
        .order_by(CaseTimelineEvent.created_at.desc()).limit(20)
    )).all()
    upcoming_event_rows = (await db.execute(
        select(CalendarEvent.id, CalendarEvent.title, CalendarEvent.start_at, CalendarEvent.case_id, CalendarEvent.event_type)
        .where(CalendarEvent.organization_id == org_id, CalendarEvent.start_at >= now)
        .order_by(CalendarEvent.start_at.asc()).limit(10)
    )).all()
    overdue_task_rows = (await db.execute(
        select(Task.id, Task.title, Task.due_date, Task.case_id, Task.status)
        .where(Task.organization_id == org_id, Task.status.in_(OPEN_TASK_STATUSES), Task.archived_at.is_(None), Task.due_date.is_not(None), Task.due_date < now)
        .order_by(Task.due_date.asc()).limit(10)
    )).all()

    return {
        "total_clients": total_clients,
        "total_cases": total_cases,
        "active_cases": active_cases,
        "closed_cases": closed_cases,
        "pending_tasks": pending_tasks,
        "overdue_tasks": overdue_tasks,
        "upcoming_events": upcoming_events,
        "outstanding_invoices": outstanding_invoices,
        "total_invoice_amount": total_invoice_amount,
        "total_paid_amount": total_paid_amount,
        "total_balance_due": total_balance_due,
        "total_trust_balance": total_trust_balance,
        "recent_activity": [{"id": r.id, "case_id": r.case_id, "actor_id": r.actor_id, "event_type": r.event_type, "title": r.title, "created_at": r.created_at} for r in recent_activity],
        "upcoming_events_items": [{"id": r.id, "title": r.title, "start_at": r.start_at, "case_id": r.case_id, "event_type": r.event_type} for r in upcoming_event_rows],
        "overdue_tasks_items": [{"id": r.id, "title": r.title, "due_date": r.due_date, "case_id": r.case_id, "status": r.status} for r in overdue_task_rows],
        "financial_snapshot": {"invoice_total": total_invoice_amount, "paid_total": total_paid_amount, "balance_due_total": total_balance_due, "trust_balance_total": total_trust_balance},
    }


@router.get("/cases")
async def cases_report(status: str | None = None, priority: str | None = None, client_id: int | None = None, date_from: date | None = None, date_to: date | None = None, db: AsyncSession = Depends(get_db), current_user=Depends(role_guard(CASE_TASK_REPORTS))):
    org_id = current_user.organization_id
    filters = [Case.organization_id == org_id]
    if status: filters.append(Case.status == status)
    if priority: filters.append(Case.priority == priority)
    if client_id: filters.append(Case.client_id == client_id)
    if date_from: filters.append(func.date(Case.created_at) >= date_from)
    if date_to: filters.append(func.date(Case.created_at) <= date_to)

    rows = (await db.execute(select(Case.id, Case.title, Case.status, Case.priority, Case.client_id, Case.created_at).where(and_(*filters)).order_by(Case.created_at.desc()))).all()
    crows = (await db.execute(select(Case.status, func.count(Case.id)).where(and_(*filters)).group_by(Case.status))).all()
    cmap = {k: int(v) for k, v in crows}

    return {
        "cases": [{"id": r.id, "title": r.title, "status": r.status, "priority": r.priority, "client_id": r.client_id, "created_at": r.created_at} for r in rows],
        "total_count": len(rows),
        "status_counts": {"draft": cmap.get("draft", 0), "active": cmap.get("active", 0), "closed": cmap.get("closed", 0), "archived": cmap.get("archived", 0)},
    }


@router.get("/financial")
async def financial_report(date_from: date | None = None, date_to: date | None = None, db: AsyncSession = Depends(get_db), current_user=Depends(role_guard(OPER_REPORTS))):
    org_id = current_user.organization_id
    inv_filters = [Invoice.organization_id == org_id]
    exp_filters = [Expense.organization_id == org_id]
    te_filters = [TimeEntry.organization_id == org_id]
    te_date = _time_entry_date_expr()
    if date_from:
        inv_filters.append(Invoice.issue_date >= date_from)
        exp_filters.append(Expense.expense_date >= date_from)
        te_filters.append(te_date >= date_from)
    if date_to:
        inv_filters.append(Invoice.issue_date <= date_to)
        exp_filters.append(Expense.expense_date <= date_to)
        te_filters.append(te_date <= date_to)

    invoice_totals = d(await db.scalar(select(func.coalesce(func.sum(Invoice.total), 0)).where(and_(*inv_filters))))
    paid_totals = d(await db.scalar(select(func.coalesce(func.sum(Invoice.paid_amount), 0)).where(and_(*inv_filters))))
    outstanding_totals = d(await db.scalar(select(func.coalesce(func.sum(Invoice.balance_due), 0)).where(and_(*inv_filters))))
    expense_totals = d(await db.scalar(select(func.coalesce(func.sum(Expense.amount), 0)).where(and_(*exp_filters))))
    billable_minutes_total = d(await db.scalar(select(func.coalesce(func.sum(TimeEntry.duration_minutes), 0)).where(and_(*te_filters), TimeEntry.status.in_(["billable", "invoiced"]))))
    billable_hours_total = (billable_minutes_total / Decimal("60")).quantize(Decimal("0.01")) if billable_minutes_total else Decimal("0.00")
    billable_time_total = d(await db.scalar(select(func.coalesce(func.sum(TimeEntry.amount), 0)).where(and_(*te_filters), TimeEntry.status.in_(["billable", "invoiced"]))))

    month_rows = (await db.execute(
        select(func.date_trunc("month", Invoice.issue_date).label("month"), func.coalesce(func.sum(Invoice.total), 0).label("amount"))
        .where(and_(*inv_filters)).group_by("month").order_by("month")
    )).all()

    return {
        "invoice_totals": invoice_totals,
        "paid_totals": paid_totals,
        "outstanding_totals": outstanding_totals,
        "expense_totals": expense_totals,
        "billable_time_total": billable_time_total,
        "billable_hours_total": billable_hours_total,
        "revenue_by_month": [{"month": r.month, "amount": d(r.amount)} for r in month_rows],
    }


@router.get("/invoices")
async def invoice_reports(
    date_from: date | None = None,
    date_to: date | None = None,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(role_guard(OPER_REPORTS)),
):
    org_id = current_user.organization_id
    filters = [Invoice.organization_id == org_id]
    if date_from:
        filters.append(Invoice.issue_date >= date_from)
    if date_to:
        filters.append(Invoice.issue_date <= date_to)

    invoices = (
        await db.scalars(
            select(Invoice)
            .where(and_(*filters))
            .options(
                selectinload(Invoice.client),
                selectinload(Invoice.case),
                selectinload(Invoice.payments),
            )
            .order_by(Invoice.issue_date.desc(), Invoice.created_at.desc())
        )
    ).all()
    rows = [_invoice_row(inv) for inv in invoices]
    paid_rows = [row for row in rows if row["display_status"] == "paid"]
    unpaid_rows = [row for row in rows if row["balance_due"] > 0 and row["display_status"] not in {"cancelled"}]
    overdue_rows = [row for row in rows if row["display_status"] == "overdue"]
    outstanding_rows = [row for row in rows if row["balance_due"] > 0 and row["display_status"] not in {"cancelled"}]

    revenue_filters = [InvoicePayment.organization_id == org_id, InvoicePayment.voided_at.is_(None)]
    if date_from:
        revenue_filters.append(InvoicePayment.paid_at >= date_from)
    if date_to:
        revenue_filters.append(InvoicePayment.paid_at <= date_to)

    revenue_by_period_rows = (
        await db.execute(
            select(
                func.date_trunc("month", InvoicePayment.paid_at).label("period"),
                InvoicePayment.currency.label("currency"),
                func.coalesce(func.sum(InvoicePayment.amount), 0).label("amount"),
            )
            .where(and_(*revenue_filters))
            .group_by("period", InvoicePayment.currency)
            .order_by("period")
        )
    ).all()
    revenue_by_client_rows = (
        await db.execute(
            select(
                Invoice.client_id,
                Client.name.label("client_name"),
                InvoicePayment.currency,
                func.coalesce(func.sum(InvoicePayment.amount), 0).label("amount"),
            )
            .join(Invoice, Invoice.id == InvoicePayment.invoice_id)
            .join(Client, Client.id == Invoice.client_id)
            .where(and_(*revenue_filters))
            .group_by(Invoice.client_id, Client.name, InvoicePayment.currency)
            .order_by(func.coalesce(func.sum(InvoicePayment.amount), 0).desc(), Client.name.asc())
        )
    ).all()
    revenue_by_matter_rows = (
        await db.execute(
            select(
                Invoice.case_id,
                Case.title.label("matter_title"),
                InvoicePayment.currency,
                func.coalesce(func.sum(InvoicePayment.amount), 0).label("amount"),
            )
            .join(Invoice, Invoice.id == InvoicePayment.invoice_id)
            .outerjoin(Case, Case.id == Invoice.case_id)
            .where(and_(*revenue_filters))
            .group_by(Invoice.case_id, Case.title, InvoicePayment.currency)
            .order_by(func.coalesce(func.sum(InvoicePayment.amount), 0).desc())
        )
    ).all()
    revenue_by_staff_rows = (
        await db.execute(
            select(
                Invoice.created_by.label("staff_id"),
                User.name.label("staff_name"),
                InvoicePayment.currency,
                func.coalesce(func.sum(InvoicePayment.amount), 0).label("amount"),
            )
            .join(Invoice, Invoice.id == InvoicePayment.invoice_id)
            .outerjoin(User, User.id == Invoice.created_by)
            .where(and_(*revenue_filters))
            .group_by(Invoice.created_by, User.name, InvoicePayment.currency)
            .order_by(func.coalesce(func.sum(InvoicePayment.amount), 0).desc())
        )
    ).all()
    tax_rows = (
        await db.execute(
            select(
                InvoicePayment.currency,
                func.coalesce(func.sum((Invoice.tax_amount * InvoicePayment.amount) / func.nullif(Invoice.total, 0)), 0).label("amount"),
            )
            .join(Invoice, Invoice.id == InvoicePayment.invoice_id)
            .where(and_(*revenue_filters))
            .group_by(InvoicePayment.currency)
            .order_by(InvoicePayment.currency.asc())
        )
    ).all()

    payment_method_totals: dict[str, Decimal] = {"Unpaid": Decimal("0.00"), "Direct": Decimal("0.00"), "Trust": Decimal("0.00"), "Mixed": Decimal("0.00"), "Voided/Reversed": Decimal("0.00")}
    payment_method_counts: dict[str, int] = {key: 0 for key in payment_method_totals}
    for row in rows:
        label = row["payment_method"]
        payment_method_counts[label] = payment_method_counts.get(label, 0) + 1
        payment_method_totals[label] = d(payment_method_totals.get(label, Decimal("0.00")) + row["paid_amount"])

    return {
        "paid_invoices": paid_rows,
        "unpaid_invoices": unpaid_rows,
        "overdue_invoices": overdue_rows,
        "outstanding_invoices": outstanding_rows,
        "totals": {
            "paid_count": len(paid_rows),
            "unpaid_count": len(unpaid_rows),
            "overdue_count": len(overdue_rows),
            "outstanding_balance": sum((d(row["balance_due"]) for row in outstanding_rows), Decimal("0.00")),
        },
        "revenue_by_period": [{"period": row.period, "currency": row.currency, "amount": d(row.amount)} for row in revenue_by_period_rows],
        "revenue_by_client": [{"client_id": row.client_id, "client_name": row.client_name, "currency": row.currency, "amount": d(row.amount)} for row in revenue_by_client_rows],
        "revenue_by_matter": [{"case_id": row.case_id, "matter_title": row.matter_title, "currency": row.currency, "amount": d(row.amount)} for row in revenue_by_matter_rows],
        "revenue_by_staff": [{"staff_id": row.staff_id, "staff_name": row.staff_name, "currency": row.currency, "amount": d(row.amount)} for row in revenue_by_staff_rows],
        "gct_tax_report": [{"currency": row.currency, "amount": d(row.amount)} for row in tax_rows],
        "payment_method_report": {
            "counts": payment_method_counts,
            "totals": {key: d(value) for key, value in payment_method_totals.items()},
        },
    }


@router.get("/billing/revenue-by-staff", response_model=list[RevenueByStaffRow])
async def revenue_by_staff_report(
    date_from: date | None = None,
    date_to: date | None = None,
    staff_user_id: int | None = None,
    currency: str | None = None,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(role_guard(OPER_REPORTS)),
):
    return [RevenueByStaffRow(**row) for row in await build_revenue_by_staff_report(
        db,
        organization_id=current_user.organization_id,
        date_from=date_from,
        date_to=date_to,
        staff_user_id=staff_user_id,
        currency=currency,
    )]


@router.get("/billing/time-by-staff", response_model=list[TimeByStaffRow])
async def time_by_staff_report(
    date_from: date | None = None,
    date_to: date | None = None,
    staff_user_id: int | None = None,
    currency: str | None = None,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(role_guard(OPER_REPORTS)),
):
    return [TimeByStaffRow(**row) for row in await build_time_by_staff_report(
        db,
        organization_id=current_user.organization_id,
        date_from=date_from,
        date_to=date_to,
        staff_user_id=staff_user_id,
        currency=currency,
    )]


@router.get("/trust")
async def trust_report(db: AsyncSession = Depends(get_db), current_user=Depends(role_guard(OPER_REPORTS))):
    org_id = current_user.organization_id
    total_trust_balance = d(await db.scalar(select(func.coalesce(func.sum(TrustLedger.current_balance), 0)).where(TrustLedger.organization_id == org_id)))
    by_client = (await db.execute(select(TrustLedger.client_id, func.coalesce(func.sum(TrustLedger.current_balance), 0).label("bal")).where(TrustLedger.organization_id == org_id).group_by(TrustLedger.client_id))).all()
    by_case = (await db.execute(select(TrustLedger.case_id, func.coalesce(func.sum(TrustLedger.current_balance), 0).label("bal")).where(TrustLedger.organization_id == org_id).group_by(TrustLedger.case_id))).all()
    recent = (await db.execute(select(TrustTransaction.id, TrustTransaction.transaction_type, TrustTransaction.amount, TrustTransaction.client_id, TrustTransaction.case_id, TrustTransaction.transaction_date).where(TrustTransaction.organization_id == org_id).order_by(TrustTransaction.created_at.desc()).limit(20))).all()

    sum_client = sum((d(r.bal) for r in by_client), Decimal("0"))
    return {
        "total_trust_balance": total_trust_balance,
        "balances_by_client": [{"client_id": r.client_id, "balance": d(r.bal)} for r in by_client],
        "balances_by_case": [{"case_id": r.case_id, "balance": d(r.bal)} for r in by_case],
        "recent_trust_transactions": [{"id": r.id, "transaction_type": r.transaction_type, "amount": d(r.amount), "client_id": r.client_id, "case_id": r.case_id, "transaction_date": r.transaction_date} for r in recent],
        "reconciliation_status": total_trust_balance == sum_client,
    }


@router.get("/tasks")
async def tasks_report(status: str | None = None, assigned_to: int | None = None, case_id: int | None = None, db: AsyncSession = Depends(get_db), current_user=Depends(role_guard(CASE_TASK_REPORTS))):
    org_id = current_user.organization_id
    filters = [Task.organization_id == org_id, Task.archived_at.is_(None)]
    if status: filters.append(Task.status == status)
    if assigned_to: filters.append(Task.assigned_to == assigned_to)
    if case_id: filters.append(Task.case_id == case_id)

    rows = (await db.execute(select(Task.id, Task.title, Task.status, Task.priority, Task.assigned_to, Task.case_id, Task.due_date).where(and_(*filters)).order_by(Task.created_at.desc()))).all()
    crows = (await db.execute(select(Task.status, func.count(Task.id)).where(and_(*filters)).group_by(Task.status))).all()
    cmap = {k: int(v) for k, v in crows}
    overdue_count = int((await db.scalar(select(func.count(Task.id)).where(and_(*filters), Task.status.in_(OPEN_TASK_STATUSES), Task.due_date.is_not(None), Task.due_date < datetime.now(timezone.utc)))) or 0)

    return {
        "total_tasks": len(rows),
        "pending_count": cmap.get("pending", 0) + cmap.get("not_started", 0),
        "in_progress_count": cmap.get("in_progress", 0) + cmap.get("waiting", 0),
        "completed_count": cmap.get("completed", 0),
        "cancelled_count": cmap.get("cancelled", 0),
        "waiting_count": cmap.get("waiting", 0),
        "not_started_count": cmap.get("not_started", 0),
        "overdue_count": overdue_count,
        "tasks": [{"id": r.id, "title": r.title, "status": r.status, "priority": r.priority, "assigned_to": r.assigned_to, "case_id": r.case_id, "due_date": r.due_date} for r in rows],
    }


@router.get("/activity")
async def activity_report(db: AsyncSession = Depends(get_db), current_user=Depends(role_guard(OPER_REPORTS))):
    org_id = current_user.organization_id
    rows = (await db.execute(
        select(CaseTimelineEvent.id, CaseTimelineEvent.case_id, CaseTimelineEvent.actor_id, CaseTimelineEvent.event_type, CaseTimelineEvent.title, CaseTimelineEvent.created_at)
        .where(CaseTimelineEvent.organization_id == org_id)
        .order_by(CaseTimelineEvent.created_at.desc()).limit(100)
    )).all()
    return {"activity": [{"id": r.id, "case_id": r.case_id, "actor_id": r.actor_id, "event_type": r.event_type, "title": r.title, "created_at": r.created_at} for r in rows]}


@router.get("/financial/pdf")
async def financial_report_pdf(
    date_from: date | None = None,
    date_to: date | None = None,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(role_guard(OPER_REPORTS)),
):
    generated = await generate_report_pdf(
        "financial",
        {"date_from": date_from, "date_to": date_to},
        db=db,
        organization_id=current_user.organization_id,
    )
    return FileResponse(path=str(generated.file_path), filename=generated.filename, media_type="application/pdf")


@router.get("/trust/pdf")
async def trust_report_pdf(db: AsyncSession = Depends(get_db), current_user=Depends(role_guard(OPER_REPORTS))):
    generated = await generate_report_pdf("trust", {}, db=db, organization_id=current_user.organization_id)
    return FileResponse(path=str(generated.file_path), filename=generated.filename, media_type="application/pdf")


@router.get("/cases/pdf")
async def cases_report_pdf(
    status: str | None = None,
    priority: str | None = None,
    client_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(role_guard(CASE_TASK_REPORTS)),
):
    generated = await generate_report_pdf(
        "cases",
        {"status": status, "priority": priority, "client_id": client_id, "date_from": date_from, "date_to": date_to},
        db=db,
        organization_id=current_user.organization_id,
    )
    return FileResponse(path=str(generated.file_path), filename=generated.filename, media_type="application/pdf")
