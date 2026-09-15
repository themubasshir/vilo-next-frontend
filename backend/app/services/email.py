import asyncio
import logging
import smtplib
from datetime import datetime, timezone
from email.message import EmailMessage
from html import escape
from urllib.parse import urljoin

from app.core.config import settings

logger = logging.getLogger(__name__)


async def send_email(to_email: str, subject: str, html_body: str, text_body: str | None = None) -> bool:
    def _send():
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = settings.smtp_from
        msg["To"] = to_email
        msg.set_content(text_body or "Please view this message in an HTML-compatible email client.")
        msg.add_alternative(html_body, subtype="html")

        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as server:
            server.starttls()
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_pass)
            server.send_message(msg)

    try:
        await asyncio.to_thread(_send)
        return True
    except Exception:
        logger.exception("Failed to send email to %s with subject %s", to_email, subject)
        return False


def _invite_template(name: str, invite_link: str, role: str) -> tuple[str, str, str]:
    subject = "You are invited to VILO"
    html = f"""
    <h2>You're invited to VILO</h2>
    <p>Hello {name},</p>
    <p>You have been invited as <strong>{role}</strong>.</p>
    <p><a href="{invite_link}">Accept your invite</a></p>
    """
    text = f"You're invited to VILO as {role}. Accept: {invite_link}"
    return subject, html, text


def _invoice_template(client_name: str, invoice_number: str, invoice_link: str) -> tuple[str, str, str]:
    subject = f"Invoice {invoice_number} from VILO"
    html = f"""
    <h2>Invoice Available</h2>
    <p>Hello {client_name},</p>
    <p>Your invoice <strong>{invoice_number}</strong> is ready.</p>
    <p><a href="{invoice_link}">View invoice</a></p>
    """
    text = f"Invoice {invoice_number} is ready. View: {invoice_link}"
    return subject, html, text


def _task_template(assignee_name: str, task_title: str, task_link: str) -> tuple[str, str, str]:
    subject = f"Task Assigned: {task_title}"
    html = f"""
    <h2>Task Assigned</h2>
    <p>Hello {assignee_name},</p>
    <p>You were assigned: <strong>{task_title}</strong>.</p>
    <p><a href="{task_link}">Open task</a></p>
    """
    text = f"Task assigned: {task_title}. Open: {task_link}"
    return subject, html, text


def _document_shared_template(client_name: str, document_title: str, document_link: str) -> tuple[str, str, str]:
    subject = f"Document Shared: {document_title}"
    html = f"""
    <h2>New Shared Document</h2>
    <p>Hello {client_name},</p>
    <p>A new document was shared with you: <strong>{document_title}</strong>.</p>
    <p><a href="{document_link}">Open document</a></p>
    """
    text = f"Document shared: {document_title}. Open: {document_link}"
    return subject, html, text


async def send_invite_email(to_email: str, role: str, token: str, name: str = "there") -> None:
    subject, html, text = build_invite_email(role=role, token=token, name=name)
    await send_email(to_email, subject, html, text)


async def send_invoice_email(to_email: str, client_name: str, invoice_number: str, invoice_id: int) -> None:
    subject, html, text = build_invoice_email(client_name=client_name, invoice_number=invoice_number, invoice_id=invoice_id)
    await send_email(to_email, subject, html, text)


async def send_task_assignment_email(to_email: str, assignee_name: str, task_title: str, task_id: int) -> None:
    subject, html, text = build_task_assignment_email(assignee_name=assignee_name, task_title=task_title, task_id=task_id)
    await send_email(to_email, subject, html, text)


async def send_document_shared_email(to_email: str, client_name: str, document_title: str, document_id: int) -> None:
    subject, html, text = build_document_shared_email(client_name=client_name, document_title=document_title, document_id=document_id)
    await send_email(to_email, subject, html, text)


def build_invite_email(*, role: str, token: str, name: str = "there") -> tuple[str, str, str]:
    link = f"{settings.app_base_url}/accept-invite?token={token}"
    return _invite_template(name, link, role)


def build_invoice_email(*, client_name: str, invoice_number: str, invoice_id: int) -> tuple[str, str, str]:
    link = f"{settings.app_base_url}/portal/invoices/{invoice_id}"
    return _invoice_template(client_name, invoice_number, link)


def build_task_assignment_email(*, assignee_name: str, task_title: str, task_id: int) -> tuple[str, str, str]:
    link = f"{settings.app_base_url}/dashboard/tasks"
    return _task_template(assignee_name, task_title, link if task_id else link)


def build_document_shared_email(*, client_name: str, document_title: str, document_id: int) -> tuple[str, str, str]:
    link = f"{settings.app_base_url}/portal/documents"
    return _document_shared_template(client_name, document_title, link if document_id else link)


def build_reminder_email(
    *,
    recipient_name: str,
    category: str,
    record_title: str,
    scheduled_at: datetime | str | None,
    link: str,
    case_title: str | None = None,
    client_name: str | None = None,
    description: str | None = None,
) -> tuple[str, str, str]:
    category_subject = {
        "Task Due Soon": "Task Reminder",
        "Task Due": "Task Reminder",
        "Task Overdue": "Overdue Task",
        "Court Event Reminder": "Court Event Reminder",
        "Meeting Reminder": "Meeting Reminder",
        "Deadline Reminder": "Deadline Reminder",
        "Calendar Event Reminder": "Calendar Reminder",
        "Event Starting": "Calendar Reminder",
    }.get(category, "Reminder")
    subject = f"VILO {category_subject}: {record_title}"
    if isinstance(scheduled_at, str):
        try:
            scheduled_at = datetime.fromisoformat(scheduled_at.replace("Z", "+00:00"))
        except ValueError:
            scheduled_at = None
    if scheduled_at is not None:
        if scheduled_at.tzinfo is None:
            scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
        scheduled_utc = scheduled_at.astimezone(timezone.utc)
        scheduled_text = f"{scheduled_utc.strftime('%d/%m/%Y')}, {scheduled_utc.strftime('%I:%M %p').lstrip('0')} UTC"
    else:
        scheduled_text = "Not scheduled"
    absolute_link = urljoin(f"{settings.app_base_url.rstrip('/')}/", (link or "/dashboard").lstrip("/"))

    safe_name = escape(recipient_name or "there")
    safe_category = escape(category)
    safe_title = escape(record_title)
    safe_date = escape(scheduled_text)
    safe_link = escape(absolute_link, quote=True)
    detail_rows = []
    text_rows = []
    if case_title:
        detail_rows.append(f"<p><strong>Case:</strong> {escape(case_title)}</p>")
        text_rows.append(f"Case: {case_title}")
    if client_name:
        detail_rows.append(f"<p><strong>Client:</strong> {escape(client_name)}</p>")
        text_rows.append(f"Client: {client_name}")
    if description:
        detail_rows.append(f"<p>{escape(description)}</p>")
        text_rows.append(description)

    html = f"""
    <h2>{safe_category}</h2>
    <p>Hello {safe_name},</p>
    <p><strong>{safe_title}</strong></p>
    <p><strong>Date and time:</strong> {safe_date}</p>
    {''.join(detail_rows)}
    <p><a href="{safe_link}">Open in VILO</a></p>
    """
    text = "\n".join([
        category,
        f"Hello {recipient_name or 'there'},",
        record_title,
        f"Date and time: {scheduled_text}",
        *text_rows,
        f"Open in VILO: {absolute_link}",
    ])
    return subject, html, text
