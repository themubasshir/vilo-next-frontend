import argparse
import asyncio
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from io import BytesIO
from pathlib import Path

from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas
from sqlalchemy import delete, select

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from app.core.security import hash_password
from app.db.session import SessionLocal
from app.models.audit_log import AuditLog
from app.models.calendar_event import CalendarEvent
from app.models.case import Case, CaseAssignment, CasePriority, CaseStatus
from app.models.case_note import CaseNote
from app.models.case_timeline_event import CaseTimelineEvent
from app.models.client import Client
from app.models.conversation import Conversation, ConversationParticipant, Message
from app.models.document import Document
from app.models.enums import RecordStatus, UserRole
from app.models.expense import Expense
from app.models.invoice import Invoice
from app.models.invoice_line_item import InvoiceLineItem
from app.models.notification import Notification
from app.models.organization import Organization
from app.models.task import Task
from app.models.time_entry import TimeEntry
from app.models.trust_account import TrustAccount
from app.models.trust_ledger import TrustLedger
from app.models.trust_transaction import TrustTransaction
from app.models.user import User


DEMO_ORG_NAME = "VILO Demo Law Firm"
DEMO_ORG_SLUG = "vilo-demo"
DEMO_PASSWORD = "DemoPass123!"
DEMO_MARKER = "[VILO_DEMO]"
STORAGE_ROOT = ROOT_DIR / "storage" / "documents"


@dataclass
class SeedContext:
    org: Organization
    users: dict[str, User]
    clients: dict[str, Client]
    cases: dict[str, Case]


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def get_or_create_org(db) -> Organization:
    now = now_utc()
    org = await db.scalar(select(Organization).where(Organization.slug == DEMO_ORG_SLUG))
    if org:
        org.name = DEMO_ORG_NAME
        org.status = RecordStatus.active
        org.updated_at = now
        return org

    org = Organization(
        name=DEMO_ORG_NAME,
        slug=DEMO_ORG_SLUG,
        status=RecordStatus.active,
        created_at=now,
        updated_at=now,
    )
    db.add(org)
    await db.flush()
    return org


async def reset_demo_data(db):
    org = await db.scalar(select(Organization).where(Organization.slug == DEMO_ORG_SLUG))
    if org:
        org_id = org.id
        # Delete org-owned rows in FK-safe order for RESTRICT links.
        await db.execute(delete(Message).where(Message.organization_id == org_id))
        await db.execute(delete(ConversationParticipant).where(ConversationParticipant.organization_id == org_id))
        await db.execute(delete(Conversation).where(Conversation.organization_id == org_id))
        await db.execute(delete(Notification).where(Notification.organization_id == org_id))
        await db.execute(delete(AuditLog).where(AuditLog.organization_id == org_id))
        await db.execute(delete(TrustTransaction).where(TrustTransaction.organization_id == org_id))
        await db.execute(delete(TrustLedger).where(TrustLedger.organization_id == org_id))
        await db.execute(delete(TrustAccount).where(TrustAccount.organization_id == org_id))
        await db.execute(delete(InvoiceLineItem).where(InvoiceLineItem.organization_id == org_id))
        await db.execute(delete(Invoice).where(Invoice.organization_id == org_id))
        await db.execute(delete(TimeEntry).where(TimeEntry.organization_id == org_id))
        await db.execute(delete(Expense).where(Expense.organization_id == org_id))
        await db.execute(delete(CaseNote).where(CaseNote.organization_id == org_id))
        await db.execute(delete(Document).where(Document.organization_id == org_id))
        await db.execute(delete(CalendarEvent).where(CalendarEvent.organization_id == org_id))
        await db.execute(delete(CaseTimelineEvent).where(CaseTimelineEvent.organization_id == org_id))
        await db.execute(delete(Task).where(Task.organization_id == org_id))
        await db.execute(delete(CaseAssignment).where(CaseAssignment.case_id.in_(select(Case.id).where(Case.organization_id == org_id))))
        await db.execute(delete(Case).where(Case.organization_id == org_id))
        await db.execute(delete(Client).where(Client.organization_id == org_id))
        await db.execute(delete(User).where(User.organization_id == org_id))
        await db.delete(org)
        await db.flush()


async def upsert_user(db, org_id: int, name: str, email: str, role: UserRole) -> User:
    now = now_utc()
    user = await db.scalar(select(User).where(User.email == email))
    if user:
        user.organization_id = org_id
        user.name = name
        user.role = role
        user.status = RecordStatus.active
        user.hashed_password = hash_password(DEMO_PASSWORD)
        user.updated_at = now
        return user

    user = User(
        organization_id=org_id,
        name=name,
        email=email,
        hashed_password=hash_password(DEMO_PASSWORD),
        role=role,
        status=RecordStatus.active,
        created_at=now,
        updated_at=now,
    )
    db.add(user)
    await db.flush()
    return user


async def upsert_client(db, org_id: int, payload: dict) -> Client:
    now = now_utc()
    client = await db.scalar(
        select(Client).where(Client.organization_id == org_id, Client.email == payload["email"])
    )
    if not client:
        client = Client(
            organization_id=org_id,
            name=payload["name"],
            email=payload["email"],
            phone=payload["phone"],
            address=payload["address"],
            notes=f"{DEMO_MARKER} {payload.get('notes', '')}".strip(),
            client_type=payload["client_type"],
            trn_no=payload.get("trn_no"),
            preferred_contact_method=payload.get("preferred_contact_method"),
            date_of_birth=payload.get("date_of_birth"),
            billing_currency=payload.get("billing_currency", "USD"),
            archived_at=payload.get("archived_at"),
            created_at=now,
            updated_at=now,
            user_id=payload.get("user_id"),
        )
        db.add(client)
        await db.flush()
        return client

    client.name = payload["name"]
    client.phone = payload["phone"]
    client.address = payload["address"]
    client.notes = f"{DEMO_MARKER} {payload.get('notes', '')}".strip()
    client.client_type = payload["client_type"]
    client.trn_no = payload.get("trn_no")
    client.preferred_contact_method = payload.get("preferred_contact_method")
    client.date_of_birth = payload.get("date_of_birth")
    client.billing_currency = payload.get("billing_currency", "USD")
    client.archived_at = payload.get("archived_at")
    client.user_id = payload.get("user_id")
    client.updated_at = now
    return client


async def upsert_case(db, org_id: int, created_by: int, title: str, description: str, client_id: int, status: CaseStatus, priority: CasePriority, created_at: datetime) -> Case:
    row = await db.scalar(select(Case).where(Case.organization_id == org_id, Case.title == title))
    if row:
        row.description = description
        row.client_id = client_id
        row.status = status
        row.priority = priority
        row.updated_at = now_utc()
        return row

    row = Case(
        organization_id=org_id,
        title=title,
        description=description,
        client_id=client_id,
        status=status,
        priority=priority,
        created_by=created_by,
        created_at=created_at,
        updated_at=created_at,
    )
    db.add(row)
    await db.flush()
    return row


async def ensure_assignment(db, case_id: int, user_id: int):
    row = await db.scalar(select(CaseAssignment).where(CaseAssignment.case_id == case_id, CaseAssignment.user_id == user_id))
    if not row:
        db.add(CaseAssignment(case_id=case_id, user_id=user_id))


async def upsert_timeline_event(db, org_id: int, case_id: int, actor_id: int, title: str, event_type: str, offset_days: int, completed: bool, status: str, locked: bool):
    row = await db.scalar(select(CaseTimelineEvent).where(CaseTimelineEvent.organization_id == org_id, CaseTimelineEvent.case_id == case_id, CaseTimelineEvent.title == title))
    meta = {
        "event_date": (date.today() + timedelta(days=offset_days)).isoformat(),
        "completed": completed,
        "status": status,
        "locked": locked,
    }
    if row:
        row.event_type = event_type
        row.actor_id = actor_id
        row.metadata_json = meta
        row.created_at = row.created_at
        return
    db.add(CaseTimelineEvent(
        organization_id=org_id,
        case_id=case_id,
        actor_id=actor_id,
        event_type=event_type,
        title=title,
        description=f"{DEMO_MARKER} {title}",
        metadata_json=meta,
        created_at=now_utc(),
    ))


async def upsert_calendar_event(db, org_id: int, created_by: int, title: str, event_type: str, start_at: datetime, case_id: int | None = None):
    row = await db.scalar(select(CalendarEvent).where(CalendarEvent.organization_id == org_id, CalendarEvent.title == title, CalendarEvent.start_at == start_at))
    if row:
        row.event_type = event_type
        row.case_id = case_id
        row.updated_at = now_utc()
        return
    db.add(CalendarEvent(
        organization_id=org_id,
        case_id=case_id,
        created_by=created_by,
        title=title,
        description=f"{DEMO_MARKER} Calendar item",
        event_type=event_type,
        start_at=start_at,
        end_at=start_at + timedelta(hours=1),
        location="Downtown Office",
        created_at=now_utc(),
        updated_at=now_utc(),
    ))


async def upsert_task(db, org_id: int, created_by: int, assigned_to: int, case_id: int, title: str, due_date: datetime, status: str, priority: str):
    row = await db.scalar(select(Task).where(Task.organization_id == org_id, Task.title == title))
    if row:
        row.case_id = case_id
        row.assigned_to = assigned_to
        row.status = status
        row.priority = priority
        row.due_date = due_date
        row.completed_at = now_utc() if status == "completed" else None
        row.updated_at = now_utc()
        return
    db.add(Task(
        organization_id=org_id,
        case_id=case_id,
        assigned_to=assigned_to,
        created_by=created_by,
        title=title,
        description=f"{DEMO_MARKER} Task",
        status=status,
        priority=priority,
        due_date=due_date,
        completed_at=now_utc() if status == "completed" else None,
        created_at=now_utc(),
        updated_at=now_utc(),
    ))


async def ensure_file(path: Path, content: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def build_demo_pdf(title: str) -> bytes:
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=LETTER)
    pdf.setTitle(title)
    pdf.setFont("Helvetica-Bold", 16)
    pdf.drawString(72, 720, title)
    pdf.setFont("Helvetica", 10)
    pdf.drawString(72, 698, "VILO demo document")
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


async def upsert_document(db, org_id: int, uploader_id: int, title: str, file_name: str, category: str, case_id: int | None, client_id: int | None, make_file: bool):
    row = await db.scalar(select(Document).where(Document.organization_id == org_id, Document.title == title, Document.category == category))
    file_path = STORAGE_ROOT / str(org_id) / "demo" / file_name
    file_bytes = build_demo_pdf(title)
    if make_file:
        await ensure_file(file_path, file_bytes)
    if row:
        row.case_id = case_id
        row.client_id = client_id
        row.file_name = file_name
        row.file_path = str(file_path)
        row.file_type = "application/pdf"
        row.file_size = len(file_bytes)
        row.updated_at = now_utc()
        return row
    row = Document(
        organization_id=org_id,
        case_id=case_id,
        client_id=client_id,
        uploaded_by=uploader_id,
        title=title,
        description=f"{DEMO_MARKER} document",
        file_name=file_name,
        file_path=str(file_path),
        file_type="application/pdf",
        file_size=len(file_bytes),
        category=category,
        visibility="internal",
        version=1,
        created_at=now_utc(),
        updated_at=now_utc(),
    )
    db.add(row)
    await db.flush()
    return row


async def upsert_case_note(db, org_id: int, case_id: int, author_id: int, note: str, visibility: str):
    row = await db.scalar(select(CaseNote).where(CaseNote.organization_id == org_id, CaseNote.case_id == case_id, CaseNote.note == note))
    if row:
        row.visibility = visibility
        row.updated_at = now_utc()
        return
    db.add(CaseNote(
        organization_id=org_id,
        case_id=case_id,
        created_by=author_id,
        note=note,
        visibility=visibility,
        created_at=now_utc(),
        updated_at=now_utc(),
    ))


async def upsert_time_entry(db, org_id: int, case_id: int, user_id: int, description: str, hours: Decimal, rate: Decimal, entry_date: date):
    row = await db.scalar(select(TimeEntry).where(TimeEntry.organization_id == org_id, TimeEntry.case_id == case_id, TimeEntry.description == description, TimeEntry.entry_date == entry_date))
    if row:
        row.hours = hours
        row.rate = rate
        row.updated_at = now_utc()
        return row
    row = TimeEntry(
        organization_id=org_id,
        case_id=case_id,
        user_id=user_id,
        description=description,
        hours=hours,
        rate=rate,
        billable=True,
        billed=False,
        entry_date=entry_date,
        created_at=now_utc(),
        updated_at=now_utc(),
    )
    db.add(row)
    await db.flush()
    return row


async def upsert_expense(db, org_id: int, case_id: int, client_id: int, created_by: int, description: str, amount: Decimal, expense_date: date):
    row = await db.scalar(select(Expense).where(Expense.organization_id == org_id, Expense.description == description, Expense.expense_date == expense_date))
    if row:
        row.amount = amount
        row.updated_at = now_utc()
        return row
    row = Expense(
        organization_id=org_id,
        case_id=case_id,
        client_id=client_id,
        created_by=created_by,
        description=description,
        category="operations",
        amount=amount,
        expense_date=expense_date,
        billable=True,
        billed=False,
        created_at=now_utc(),
        updated_at=now_utc(),
    )
    db.add(row)
    await db.flush()
    return row


async def upsert_invoice(db, org_id: int, created_by: int, client_id: int, case_id: int | None, invoice_number: str, status: str, issue_date: date, due_date: date, subtotal: Decimal, tax: Decimal, paid: Decimal):
    row = await db.scalar(select(Invoice).where(Invoice.organization_id == org_id, Invoice.invoice_number == invoice_number))
    total = subtotal + tax
    balance = total - paid
    if row:
        row.client_id = client_id
        row.case_id = case_id
        row.status = status
        row.issue_date = issue_date
        row.due_date = due_date
        row.subtotal = subtotal
        row.tax_amount = tax
        row.total = total
        row.paid_amount = paid
        row.balance_due = balance
        row.updated_at = now_utc()
        return row
    row = Invoice(
        organization_id=org_id,
        client_id=client_id,
        case_id=case_id,
        invoice_number=invoice_number,
        status=status,
        issue_date=issue_date,
        due_date=due_date,
        subtotal=subtotal,
        tax_amount=tax,
        total=total,
        paid_amount=paid,
        balance_due=balance,
        notes=f"{DEMO_MARKER} invoice",
        created_by=created_by,
        created_at=now_utc(),
        updated_at=now_utc(),
    )
    db.add(row)
    await db.flush()
    return row


async def replace_invoice_lines(db, org_id: int, invoice_id: int, lines: list[dict]):
    await db.execute(delete(InvoiceLineItem).where(InvoiceLineItem.organization_id == org_id, InvoiceLineItem.invoice_id == invoice_id))
    for line in lines:
        db.add(InvoiceLineItem(
            organization_id=org_id,
            invoice_id=invoice_id,
            line_type=line["line_type"],
            description=line["description"],
            quantity=Decimal(str(line["quantity"])),
            unit_price=Decimal(str(line["unit_price"])),
            amount=Decimal(str(line["amount"])),
            time_entry_id=line.get("time_entry_id"),
            expense_id=line.get("expense_id"),
            created_at=now_utc(),
        ))


async def upsert_trust_account(db, org_id: int):
    row = await db.scalar(select(TrustAccount).where(TrustAccount.organization_id == org_id, TrustAccount.name == "Main Trust Account"))
    if row:
        row.updated_at = now_utc()
        return row
    row = TrustAccount(
        organization_id=org_id,
        name="Main Trust Account",
        bank_name="National Bank",
        account_number_last4="4455",
        status="active",
        created_at=now_utc(),
        updated_at=now_utc(),
    )
    db.add(row)
    await db.flush()
    return row


async def upsert_ledger(db, org_id: int, account_id: int, client_id: int, case_id: int | None, balance: Decimal):
    row = await db.scalar(
        select(TrustLedger).where(
            TrustLedger.organization_id == org_id,
            TrustLedger.trust_account_id == account_id,
            TrustLedger.client_id == client_id,
            TrustLedger.case_id == case_id,
        )
    )
    if row:
        row.current_balance = balance
        row.updated_at = now_utc()
        return row
    row = TrustLedger(
        organization_id=org_id,
        trust_account_id=account_id,
        client_id=client_id,
        case_id=case_id,
        current_balance=balance,
        created_at=now_utc(),
        updated_at=now_utc(),
    )
    db.add(row)
    await db.flush()
    return row


async def upsert_trust_txn(db, org_id: int, account_id: int, ledger_id: int, client_id: int, case_id: int | None, invoice_id: int | None, created_by: int, txn_type: str, amount: Decimal, tx_date: date, description: str):
    row = await db.scalar(select(TrustTransaction).where(TrustTransaction.organization_id == org_id, TrustTransaction.description == description, TrustTransaction.transaction_date == tx_date))
    if row:
        row.amount = amount
        return
    db.add(TrustTransaction(
        organization_id=org_id,
        trust_account_id=account_id,
        ledger_id=ledger_id,
        client_id=client_id,
        case_id=case_id,
        invoice_id=invoice_id,
        transaction_type=txn_type,
        amount=amount,
        description=description,
        transaction_date=tx_date,
        created_by=created_by,
        created_at=now_utc(),
    ))


async def upsert_conversation(db, org_id: int, created_by: int, title: str, conv_type: str, case_id: int | None, participant_ids: list[int], messages: list[tuple[int, str]]):
    now = now_utc()
    convo = await db.scalar(select(Conversation).where(Conversation.organization_id == org_id, Conversation.title == title))
    if not convo:
        convo = Conversation(
            organization_id=org_id,
            case_id=case_id,
            conversation_type=conv_type,
            title=title,
            created_by=created_by,
            created_at=now,
            updated_at=now,
        )
        db.add(convo)
        await db.flush()

    for uid in participant_ids:
        part = await db.scalar(select(ConversationParticipant).where(ConversationParticipant.organization_id == org_id, ConversationParticipant.conversation_id == convo.id, ConversationParticipant.user_id == uid))
        if not part:
            db.add(ConversationParticipant(
                organization_id=org_id,
                conversation_id=convo.id,
                user_id=uid,
                role="member",
                last_read_at=now if uid != participant_ids[-1] else None,
                created_at=now,
            ))

    for sender_id, body in messages:
        exists = await db.scalar(select(Message).where(Message.organization_id == org_id, Message.conversation_id == convo.id, Message.body == body))
        if not exists:
            db.add(Message(
                organization_id=org_id,
                conversation_id=convo.id,
                sender_id=sender_id,
                parent_message_id=None,
                body=body,
                created_at=now,
                updated_at=now,
                deleted_at=None,
            ))


async def upsert_notification(db, org_id: int, user_id: int, ntype: str, title: str, body: str, is_read: bool):
    row = await db.scalar(select(Notification).where(Notification.organization_id == org_id, Notification.user_id == user_id, Notification.title == title))
    if row:
        row.body = body
        row.is_read = is_read
        return
    db.add(Notification(
        organization_id=org_id,
        user_id=user_id,
        type=ntype,
        title=title,
        body=body,
        is_read=is_read,
        metadata_json={"demo": True},
        created_at=now_utc(),
    ))


async def upsert_audit(db, org_id: int, user_id: int, action: str, entity_type: str, entity_id: str, description: str):
    row = await db.scalar(select(AuditLog).where(AuditLog.organization_id == org_id, AuditLog.action == action, AuditLog.entity_id == entity_id))
    if row:
        row.description = description
        return
    db.add(AuditLog(
        organization_id=org_id,
        user_id=user_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        description=description,
        metadata_json={"demo": True},
        ip_address="127.0.0.1",
        user_agent="seed_demo_data",
        created_at=now_utc(),
    ))


async def seed_demo_data(reset_demo_data_flag: bool, skip_files: bool):
    async with SessionLocal() as db:
        if reset_demo_data_flag:
            await reset_demo_data(db)
            await db.commit()

        org = await get_or_create_org(db)

        users = {
            "partner": await upsert_user(db, org.id, "Olivia Grant", "partner@vilo.demo", UserRole.partner),
            "admin": await upsert_user(db, org.id, "Marcus Reid", "admin@vilo.demo", UserRole.admin),
            "lawyer": await upsert_user(db, org.id, "Sarah Johnson", "lawyer@vilo.demo", UserRole.lawyer),
            "paralegal": await upsert_user(db, org.id, "Daniel Brooks", "paralegal@vilo.demo", UserRole.paralegal),
            "client_user": await upsert_user(db, org.id, "Kevin Brown", "client@vilo.demo", UserRole.client),
        }

        today = date.today()
        clients_seed = [
            {"name": "Kevin Brown", "email": "client@vilo.demo", "phone": "+1 555 100 0001", "address": "12 King Street, Kingston", "client_type": "individual", "trn_no": "TRN-1001", "preferred_contact_method": "email", "date_of_birth": date(1986, 3, 12), "billing_currency": "USD", "notes": "Primary contact for portal demos", "user_id": users["client_user"].id},
            {"name": "John Smith", "email": "john.smith@demo.example", "phone": "+1 555 100 0002", "address": "77 Ridge Road, Miami", "client_type": "individual", "trn_no": "TRN-1002", "preferred_contact_method": "phone", "date_of_birth": date(1982, 7, 21), "billing_currency": "USD", "notes": "Employment matter"},
            {"name": "Apex Group Ltd.", "email": "legal@apexgroup.demo", "phone": "+1 555 100 0003", "address": "Apex Tower, Nassau", "client_type": "corporate", "trn_no": "TRN-2001", "preferred_contact_method": "email", "date_of_birth": None, "billing_currency": "USD", "notes": "Corporate merger work"},
            {"name": "Sarah Lopez", "email": "s.lopez@demo.example", "phone": "+1 555 100 0004", "address": "Bayview Avenue, Tampa", "client_type": "individual", "trn_no": "TRN-1004", "preferred_contact_method": "sms", "date_of_birth": date(1990, 1, 8), "billing_currency": "USD", "notes": "Family law"},
            {"name": "James Wilson", "email": "j.wilson@demo.example", "phone": "+1 555 100 0005", "address": "Rose Hall, Montego Bay", "client_type": "individual", "trn_no": "TRN-1005", "preferred_contact_method": "email", "date_of_birth": date(1978, 11, 2), "billing_currency": "USD", "notes": "Civil litigation"},
            {"name": "Anna Williams", "email": "anna.williams@demo.example", "phone": "+1 555 100 0006", "address": "Harbor Point, Kingston", "client_type": "individual", "trn_no": "TRN-1006", "preferred_contact_method": "phone", "date_of_birth": date(1992, 9, 17), "billing_currency": "USD", "notes": "Contract dispute"},
            {"name": "Kingston Holdings", "email": "ops@kingstonholdings.demo", "phone": "+1 555 100 0007", "address": "Kingston Financial Centre", "client_type": "corporate", "trn_no": "TRN-2007", "preferred_contact_method": "email", "date_of_birth": None, "billing_currency": "USD", "notes": "Real estate portfolio", "archived_at": datetime.now(timezone.utc) - timedelta(days=21)},
            {"name": "Blue Harbor Consulting", "email": "board@blueharbor.demo", "phone": "+1 555 100 0008", "address": "Blue Harbor Marina Blvd", "client_type": "corporate", "trn_no": "TRN-2008", "preferred_contact_method": "email", "date_of_birth": None, "billing_currency": "USD", "notes": "Tax advisory", "archived_at": datetime.now(timezone.utc) - timedelta(days=10)},
        ]

        clients = {}
        for payload in clients_seed:
            row = await upsert_client(db, org.id, payload)
            clients[payload["name"]] = row

        await db.flush()

        case_templates = [
            ("Employment Law File #1", "Employment law dispute with wrongful termination claims", "Kevin Brown", CaseStatus.active, CasePriority.high, -20),
            ("Tax Law Advisory #1", "Quarterly tax compliance and representation", "Blue Harbor Consulting", CaseStatus.active, CasePriority.medium, -35),
            ("Corporate Merger - Apex", "Cross-border merger counsel", "Apex Group Ltd.", CaseStatus.active, CasePriority.high, -50),
            ("Civil Litigation - Wilson", "Vendor negligence claim", "James Wilson", CaseStatus.active, CasePriority.medium, -12),
            ("Family Law - Lopez", "Custody and settlement planning", "Sarah Lopez", CaseStatus.draft, CasePriority.medium, -7),
            ("Real Estate - Kingston Holdings", "Property acquisition review", "Kingston Holdings", CaseStatus.archived, CasePriority.low, -70),
            ("Contract Dispute - Williams", "MSA breach and damages", "Anna Williams", CaseStatus.active, CasePriority.high, -15),
            ("Employment Advisory - Smith", "HR policy and incident response", "John Smith", CaseStatus.closed, CasePriority.low, -90),
            ("Tax Appeal - Brown", "Tax appeal before authority", "Kevin Brown", CaseStatus.active, CasePriority.medium, -18),
            ("Civil Mediation - Apex", "Mediation with external partner", "Apex Group Ltd.", CaseStatus.draft, CasePriority.low, -4),
            ("Real Estate Lease Review", "Lease negotiation and drafting", "Blue Harbor Consulting", CaseStatus.active, CasePriority.medium, -10),
            ("Family Trust Update", "Estate and trust structuring", "Sarah Lopez", CaseStatus.closed, CasePriority.low, -120),
        ]

        cases = {}
        for idx, (title, desc, cname, status, priority, offset) in enumerate(case_templates, start=1):
            created = datetime.now(timezone.utc) + timedelta(days=offset)
            row = await upsert_case(
                db, org.id, users["partner"].id, f"{title} ({DEMO_MARKER}-{idx:02d})", desc, clients[cname].id, status, priority, created
            )
            cases[title] = row
            await ensure_assignment(db, row.id, users["lawyer"].id)
            await ensure_assignment(db, row.id, users["paralegal"].id)

        for title, case_row in list(cases.items())[:8]:
            await upsert_timeline_event(db, org.id, case_row.id, users["lawyer"].id, f"{title} - Case Filed", "filing", -30, True, "active", False)
            await upsert_timeline_event(db, org.id, case_row.id, users["lawyer"].id, f"{title} - First Hearing", "hearing", -10, False, "active", False)
            await upsert_timeline_event(db, org.id, case_row.id, users["paralegal"].id, f"{title} - Client Consultation", "consultation", -6, True, "active", False)
            await upsert_timeline_event(db, org.id, case_row.id, users["lawyer"].id, f"{title} - Document Submitted", "document", -3, True, "active", False)
            await upsert_timeline_event(db, org.id, case_row.id, users["partner"].id, f"{title} - Court Date Scheduled", "court", 3, False, "active", True)
            await upsert_timeline_event(db, org.id, case_row.id, users["partner"].id, f"{title} - Settlement Discussion", "meeting", 6, False, "inactive", False)

        calendar_types = ["court", "client", "consultation", "travel", "staff", "note", "meeting", "hearing", "deadline", "todo"]
        month_start = date.today().replace(day=1)
        for i in range(22):
            d = month_start + timedelta(days=(i % 26))
            start = datetime(d.year, d.month, d.day, 9 + (i % 6), 0, tzinfo=timezone.utc)
            c = list(cases.values())[i % len(cases)]
            et = calendar_types[i % len(calendar_types)]
            await upsert_calendar_event(db, org.id, users["paralegal"].id, f"{DEMO_MARKER} Calendar Event {i+1}", et, start, c.id)

        task_specs = [
            ("Prepare witness list", -1, "pending", "high"),
            ("Draft filing motion", 0, "pending", "medium"),
            ("Send client update", 2, "pending", "low"),
            ("Review settlement terms", -3, "completed", "high"),
            ("Compile expense docs", 5, "pending", "medium"),
            ("Court bundle check", 1, "pending", "high"),
            ("Travel prep", 4, "pending", "low"),
            ("Deadline verification", -2, "completed", "medium"),
        ]
        for i, (title, d_off, status, prio) in enumerate(task_specs):
            c = list(cases.values())[i % len(cases)]
            due = datetime.now(timezone.utc) + timedelta(days=d_off)
            assignee = users["lawyer"].id if i % 2 == 0 else users["paralegal"].id
            await upsert_task(db, org.id, users["admin"].id, assignee, c.id, f"{DEMO_MARKER} {title}", due, status, prio)

        doc_specs = [
            ("Court Filing", "court_filing.pdf", "court", list(cases.values())[0].id, None),
            ("Engagement Letter", "engagement_letter.pdf", "engagement", list(cases.values())[1].id, None),
            ("Client ID Proof", "client_id_proof.pdf", "client_id", None, clients["Kevin Brown"].id),
            ("Invoice Attachment", "invoice_attachment.pdf", "billing", list(cases.values())[2].id, clients["Apex Group Ltd."].id),
            ("Contract Draft", "contract_draft.pdf", "contract", list(cases.values())[6].id, clients["Anna Williams"].id),
        ]
        documents = []
        for title, fname, cat, case_id, client_id in doc_specs:
            documents.append(await upsert_document(db, org.id, users["paralegal"].id, f"{DEMO_MARKER} {title}", fname, cat, case_id, client_id, make_file=not skip_files))

        for i, c in enumerate(list(cases.values())[:6]):
            await upsert_case_note(db, org.id, c.id, users["lawyer"].id, f"{DEMO_MARKER} Internal note for case {c.id}", "internal")
            await upsert_case_note(db, org.id, c.id, users["lawyer"].id, f"{DEMO_MARKER} Client-visible update for case {c.id}", "client_visible")

        time_entries = []
        for i, c in enumerate(list(cases.values())[:6]):
            te = await upsert_time_entry(db, org.id, c.id, users["lawyer"].id, f"{DEMO_MARKER} Billable research {i+1}", Decimal("2.50"), Decimal("250.00"), today - timedelta(days=i + 1))
            time_entries.append(te)

        expenses = []
        for i, c in enumerate(list(cases.values())[:6]):
            ex = await upsert_expense(db, org.id, c.id, c.client_id, users["paralegal"].id, f"{DEMO_MARKER} Filing fee {i+1}", Decimal("120.00") + Decimal(i * 20), today - timedelta(days=i + 2))
            expenses.append(ex)

        invoice_statuses = ["paid", "unpaid", "overdue", "draft", "sent", "paid", "unpaid", "overdue", "draft", "paid"]
        invoices = []
        for i in range(10):
            c = list(cases.values())[i % len(cases)]
            subtotal = Decimal("1200.00") + Decimal(i * 150)
            tax = (subtotal * Decimal("0.10")).quantize(Decimal("0.01"))
            paid = Decimal("0.00")
            if invoice_statuses[i] == "paid":
                paid = subtotal + tax
            elif invoice_statuses[i] == "sent":
                paid = Decimal("200.00")
            inv = await upsert_invoice(
                db,
                org.id,
                users["admin"].id,
                c.client_id,
                c.id,
                f"DEMO-INV-{1001+i}",
                invoice_statuses[i],
                today - timedelta(days=18 - i),
                today + timedelta(days=10 - i),
                subtotal,
                tax,
                paid,
            )
            invoices.append(inv)
            await replace_invoice_lines(db, org.id, inv.id, [
                {
                    "line_type": "service",
                    "description": f"{DEMO_MARKER} Legal Services {i+1}",
                    "quantity": "1",
                    "unit_price": str(subtotal),
                    "amount": str(subtotal),
                    "time_entry_id": time_entries[i % len(time_entries)].id,
                    "expense_id": expenses[i % len(expenses)].id,
                }
            ])

        trust_account = await upsert_trust_account(db, org.id)
        ledger = await upsert_ledger(db, org.id, trust_account.id, clients["Kevin Brown"].id, list(cases.values())[0].id, Decimal("5000.00"))
        await upsert_trust_txn(db, org.id, trust_account.id, ledger.id, clients["Kevin Brown"].id, list(cases.values())[0].id, None, users["partner"].id, "deposit", Decimal("7000.00"), today - timedelta(days=15), f"{DEMO_MARKER} Trust deposit")
        await upsert_trust_txn(db, org.id, trust_account.id, ledger.id, clients["Kevin Brown"].id, list(cases.values())[0].id, invoices[0].id, users["partner"].id, "apply_to_invoice", Decimal("2000.00"), today - timedelta(days=7), f"{DEMO_MARKER} Trust apply to invoice")

        await upsert_conversation(
            db,
            org.id,
            users["partner"].id,
            f"{DEMO_MARKER} Internal Litigation Team",
            "group",
            list(cases.values())[0].id,
            [users["partner"].id, users["lawyer"].id, users["paralegal"].id],
            [
                (users["partner"].id, f"{DEMO_MARKER} Please prepare the court bundle by tomorrow."),
                (users["lawyer"].id, f"{DEMO_MARKER} Draft is ready for review."),
            ],
        )
        await upsert_conversation(
            db,
            org.id,
            users["lawyer"].id,
            f"{DEMO_MARKER} Client Updates - Kevin Brown",
            "direct",
            list(cases.values())[0].id,
            [users["lawyer"].id, users["client_user"].id],
            [
                (users["lawyer"].id, f"{DEMO_MARKER} Hearing is scheduled for next week."),
                (users["client_user"].id, f"{DEMO_MARKER} Thank you, please share required docs."),
            ],
        )

        notifications = [
            (users["lawyer"].id, "new_message", "New message from Kevin Brown", "Client sent a follow-up", False),
            (users["paralegal"].id, "task_assigned", "Task assigned", "Prepare witness list", False),
            (users["admin"].id, "invoice_sent", "Invoice sent", "DEMO-INV-1005 sent to client", True),
            (users["client_user"].id, "document_shared", "Document shared", "A new document is available", False),
            (users["partner"].id, "case_update", "Case update", "Settlement discussion added", False),
            (users["client_user"].id, "trust_receipt", "Trust receipt posted", "Trust deposit has been logged", True),
            (users["lawyer"].id, "calendar_event", "Calendar reminder", "Court hearing in 2 days", False),
        ]
        for uid, ntype, title, body, is_read in notifications:
            await upsert_notification(db, org.id, uid, ntype, title, body, is_read)

        audits = [
            (users["partner"].id, "login", "auth", "partner@vilo.demo", "Demo login event"),
            (users["lawyer"].id, "case_created", "case", str(list(cases.values())[0].id), "Demo case created"),
            (users["admin"].id, "client_created", "client", str(clients["Kevin Brown"].id), "Demo client created"),
            (users["admin"].id, "invoice_sent", "invoice", str(invoices[0].id), "Demo invoice sent"),
            (users["paralegal"].id, "document_uploaded", "document", str(documents[0].id), "Demo document uploaded"),
            (users["partner"].id, "trust_transaction", "trust", str(ledger.id), "Demo trust transaction"),
            (users["lawyer"].id, "timeline_event_updated", "timeline", "1", "Demo timeline event updated"),
        ]
        for audit in audits:
            await upsert_audit(db, org.id, *audit)

        await db.commit()

        print("\nDemo data seeded successfully.")
        print("Organization: VILO Demo Law Firm (slug: vilo-demo)")
        print("Credentials:")
        print("- partner@vilo.demo / DemoPass123!")
        print("- admin@vilo.demo / DemoPass123!")
        print("- lawyer@vilo.demo / DemoPass123!")
        print("- paralegal@vilo.demo / DemoPass123!")
        print("- client@vilo.demo / DemoPass123!")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed VILO demo data for local development")
    parser.add_argument("--reset-demo-data", action="store_true", help="Delete existing VILO demo organization and reseed")
    parser.add_argument("--skip-files", action="store_true", help="Do not create demo files in storage")
    return parser.parse_args()


def main():
    args = parse_args()
    asyncio.run(seed_demo_data(args.reset_demo_data, args.skip_files))


if __name__ == "__main__":
    main()
