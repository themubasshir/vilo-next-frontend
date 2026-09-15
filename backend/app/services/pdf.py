from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.case import Case
from app.models.client import Client
from app.models.invoice import Invoice
from app.models.organization import Organization
from app.models.time_entry import TimeEntry
from app.models.expense import Expense
from app.models.trust_ledger import TrustLedger
from app.models.trust_receipt import TrustReceipt
from app.models.trust_transaction import TrustTransaction
from app.models.user import User


STORAGE_DIR = Path(__file__).resolve().parents[2] / "storage" / "generated"


@dataclass
class GeneratedPdf:
    file_path: Path
    filename: str


def _money(value: Decimal | int | float | None) -> str:
    amount = Decimal(str(value or 0)).quantize(Decimal("0.01"))
    return f"${amount:,.2f}"


def _money_with_currency(value: Decimal | int | float | None, currency: str | None) -> str:
    amount = Decimal(str(value or 0)).quantize(Decimal("0.01"))
    return f"{(currency or 'JMD').upper()} {amount:,.2f}"


def _safe_text(value: str | None) -> str:
    return (value or "-").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _display_date(value: date | datetime | None) -> str:
    if value is None:
        return "-"
    return value.strftime("%d/%m/%Y")


def _display_datetime(value: datetime | None) -> str:
    if value is None:
        return "-"
    return f"{value.strftime('%d/%m/%Y')}, {value.strftime('%I:%M %p').lstrip('0')}"


def _display_filter(value):
    if isinstance(value, datetime):
        return _display_datetime(value)
    if isinstance(value, date):
        return _display_date(value)
    return value


def _time_entry_date_expr():
    return func.date(func.coalesce(TimeEntry.start_time, TimeEntry.created_at))


def build_firm_details(org: Organization | None) -> list[str]:
    details = [getattr(org, "name", None) or "VILO"]
    for attr in ("address", "email", "phone"):
        value = getattr(org, attr, None)
        if value:
            details.append(str(value))
    tax_number = getattr(org, "tax_number", None) or getattr(org, "trn_no", None) or getattr(org, "vat_number", None)
    if tax_number:
        details.append(f"Tax/VAT: {tax_number}")
    return details


def resolve_invoice_recipient_name(invoice: Invoice, client: Client | None) -> str:
    if client and client.name:
        return client.name
    return (getattr(invoice, "manual_client_name", None) or "Invoice recipient").strip()


def _new_pdf_path(prefix: str) -> tuple[Path, str]:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    filename = f"{prefix}_{stamp}_{uuid4().hex[:8]}.pdf"
    return STORAGE_DIR / filename, filename


def _build_doc(path: Path):
    doc = SimpleDocTemplate(
        str(path),
        pagesize=LETTER,
        leftMargin=0.65 * inch,
        rightMargin=0.65 * inch,
        topMargin=0.65 * inch,
        bottomMargin=0.65 * inch,
    )
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="ViloH1", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=22, leading=26, textColor=colors.HexColor("#1f2a44")))
    styles.add(ParagraphStyle(name="ViloH2", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=12, leading=16, textColor=colors.HexColor("#1f2a44")))
    styles.add(ParagraphStyle(name="ViloBody", parent=styles["BodyText"], fontName="Helvetica", fontSize=10, leading=14, textColor=colors.HexColor("#222222")))
    return doc, styles


def _footer(canvas, _doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#d9deea"))
    canvas.line(45, 42, 567, 42)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#677085"))
    canvas.drawString(45, 30, "VILO Confidential")
    canvas.drawRightString(567, 30, f"Generated {_display_datetime(datetime.now(timezone.utc))}")
    canvas.restoreState()


async def generate_invoice_pdf(invoice_id: int, *, db: AsyncSession, organization_id: int) -> GeneratedPdf:
    inv = await db.scalar(
        select(Invoice)
        .where(Invoice.id == invoice_id, Invoice.organization_id == organization_id)
        .options(selectinload(Invoice.line_items), selectinload(Invoice.payment_account))
    )
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    org = await db.scalar(select(Organization).where(Organization.id == organization_id))
    client = None
    if inv.client_id is not None:
        client = await db.scalar(select(Client).where(Client.id == inv.client_id, Client.organization_id == organization_id))
    recipient_name = resolve_invoice_recipient_name(inv, client)
    trust_applied = Decimal(str((await db.scalar(
        select(func.coalesce(func.sum(TrustTransaction.amount), 0)).where(
            TrustTransaction.organization_id == organization_id,
            TrustTransaction.linked_invoice_id == inv.id,
            TrustTransaction.transaction_type.in_(["applied_to_invoice", "transfer_to_operating"]),
        )
    )) or 0))

    path, filename = _new_pdf_path(f"invoice_{inv.invoice_number.replace('/', '-')}")
    doc, styles = _build_doc(path)
    story = [Paragraph("VILO", styles["ViloH1"]), Paragraph("Professional Invoice", styles["ViloBody"]), Spacer(1, 14)]

    info = Table(
        [
            [Paragraph("Bill From", styles["ViloH2"]), Paragraph("Bill To", styles["ViloH2"]), Paragraph("Invoice", styles["ViloH2"])],
            [
                Paragraph("<br/>".join(_safe_text(line) for line in build_firm_details(org)), styles["ViloBody"]),
                Paragraph(f"{_safe_text(recipient_name)}<br/>{_safe_text(getattr(client, 'email', None))}<br/>{_safe_text(getattr(client, 'phone', None))}", styles["ViloBody"]),
                Paragraph(
                    f"Invoice #: {_safe_text(inv.invoice_number)}<br/>Issue Date: {_display_date(inv.issue_date)}<br/>Due Date: {_display_date(inv.due_date)}<br/>Status: {_safe_text(inv.status)}",
                    styles["ViloBody"],
                ),
            ],
        ],
        colWidths=[2.5 * inch, 2.3 * inch, 2.2 * inch],
    )
    info.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef2f8")),
        ("BOX", (0, 0), (-1, -1), 1, colors.HexColor("#d9deea")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d9deea")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([info, Spacer(1, 14)])

    line_rows = [["Type", "Description", "Qty", "Unit", "Amount"]]
    for li in inv.line_items:
        line_rows.append([
            li.line_type,
            li.description,
            f"{Decimal(str(li.quantity)):,.2f}",
            _money(li.unit_price),
            _money(li.amount),
        ])
    if len(line_rows) == 1:
        line_rows.append(["-", "No line items", "-", "-", _money(0)])

    line_table = Table(line_rows, colWidths=[1.0 * inch, 3.2 * inch, 0.8 * inch, 1.0 * inch, 1.2 * inch])
    line_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2a44")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d9deea")),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f9fbff")]),
    ]))
    story.extend([line_table, Spacer(1, 12)])

    totals = Table(
        [
            ["Subtotal", _money(inv.subtotal)],
            ["Tax", _money(inv.tax_amount)],
            ["Total", _money(inv.total)],
            ["Paid Amount", _money(inv.paid_amount)],
            ["Trust Applied", _money(trust_applied)],
            ["Balance Due", _money(inv.balance_due)],
        ],
        colWidths=[1.8 * inch, 1.4 * inch],
    )
    totals.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d9deea")),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#eef2f8")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
    ]))
    story.append(totals)
    if getattr(inv, "payment_account", None):
        account = inv.payment_account
        details = [
            f"Bank: {_safe_text(account.bank_name)}",
            f"Account Name: {_safe_text(account.account_name)}",
            f"Account Number: {_safe_text(account.account_number)}",
        ]
        if getattr(account, "swift_routing", None):
            details.append(f"SWIFT/Routing: {_safe_text(account.swift_routing)}")
        if getattr(account, "payment_instructions", None):
            details.append(f"Instructions: {_safe_text(account.payment_instructions)}")
        if getattr(account, "notes", None):
            details.append(f"Notes: {_safe_text(account.notes)}")
        story.extend([Spacer(1, 12), Paragraph("Payment Account", styles["ViloH2"]), Paragraph("<br/>".join(details), styles["ViloBody"])])
    if inv.notes:
        story.extend([Spacer(1, 12), Paragraph("Notes", styles["ViloH2"]), Paragraph(_safe_text(inv.notes), styles["ViloBody"])])

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return GeneratedPdf(file_path=path, filename=filename)


async def generate_trust_receipt_pdf(receipt_id: int, *, db: AsyncSession, organization_id: int) -> GeneratedPdf:
    receipt = await db.scalar(
        select(TrustReceipt)
        .where(TrustReceipt.id == receipt_id, TrustReceipt.organization_id == organization_id)
        .options(selectinload(TrustReceipt.trust_transaction))
    )
    if not receipt:
        raise HTTPException(status_code=404, detail="Trust receipt not found")

    transaction = receipt.trust_transaction
    client = await db.scalar(select(Client).where(Client.id == receipt.client_id, Client.organization_id == organization_id))
    case = await db.scalar(select(Case).where(Case.id == receipt.case_id, Case.organization_id == organization_id))
    issued_by = await db.scalar(select(User).where(User.id == receipt.issued_by_id))
    org = await db.scalar(select(Organization).where(Organization.id == organization_id))

    path, filename = _new_pdf_path(f"trust_receipt_{receipt.receipt_number}")
    doc, styles = _build_doc(path)
    story = [
        Paragraph("VILO", styles["ViloH1"]),
        Paragraph("Trust Deposit Receipt", styles["ViloBody"]),
        Spacer(1, 14),
    ]

    info = Table(
        [
            [Paragraph("Firm", styles["ViloH2"]), Paragraph("Receipt", styles["ViloH2"])],
            [
                Paragraph("<br/>".join(_safe_text(line) for line in build_firm_details(org)), styles["ViloBody"]),
                Paragraph(
                    "<br/>".join(
                        [
                            f"Receipt ID: {_safe_text(receipt.receipt_number)}",
                            f"System Ref: {_safe_text(getattr(transaction, 'reference_number', None))}",
                            f"Date Received: {_display_date(transaction.transaction_date if transaction else None)}",
                            f"Created: {_display_datetime(receipt.issued_at)}",
                        ]
                    ),
                    styles["ViloBody"],
                ),
            ],
        ],
        colWidths=[3.25 * inch, 3.25 * inch],
    )
    info.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef2f8")),
        ("BOX", (0, 0), (-1, -1), 1, colors.HexColor("#d9deea")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d9deea")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([info, Spacer(1, 14)])

    detail_rows = [
        ["Client", client.name if client else f"Client #{receipt.client_id}"],
        ["Matter / Case", case.title if case else f"Matter #{receipt.case_id}"],
        ["Amount", _money_with_currency(receipt.amount, receipt.currency)],
        ["Payment Method", receipt.payment_method or "-"],
        ["External Reference", getattr(transaction, "external_reference_number", None) or "-"],
        ["Description", receipt.description or "-"],
        ["Recorded By", getattr(issued_by, "name", None) or f"User #{receipt.issued_by_id}"],
    ]
    detail_table = Table(detail_rows, colWidths=[1.8 * inch, 4.7 * inch])
    detail_table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d9deea")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f9fbff")),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(detail_table)

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return GeneratedPdf(file_path=path, filename=filename)


async def generate_report_pdf(report_type: str, filters: dict | None = None, *, db: AsyncSession, organization_id: int) -> GeneratedPdf:
    filters = filters or {}
    report_type = report_type.lower().strip()
    if report_type not in {"financial", "trust", "cases"}:
        raise HTTPException(status_code=400, detail="Unsupported report type")

    org = await db.scalar(select(Organization).where(Organization.id == organization_id))
    path, filename = _new_pdf_path(f"{report_type}_report")
    doc, styles = _build_doc(path)
    story = [Paragraph("VILO", styles["ViloH1"]), Paragraph(f"{report_type.title()} Report", styles["ViloBody"]), Spacer(1, 12)]
    story.append(Paragraph(f"Organization: {_safe_text(org.name if org else str(organization_id))}", styles["ViloBody"]))
    story.append(Paragraph(f"Generated On: {_display_datetime(datetime.now(timezone.utc))}", styles["ViloBody"]))
    if filters:
        story.append(Paragraph(f"Filters: {_safe_text(', '.join(f'{k}={_display_filter(v)}' for k, v in filters.items() if v not in (None, '')))}", styles["ViloBody"]))
    story.append(Spacer(1, 12))

    if report_type == "financial":
        inv_filters = [Invoice.organization_id == organization_id]
        exp_filters = [Expense.organization_id == organization_id]
        te_filters = [TimeEntry.organization_id == organization_id]
        te_date = _time_entry_date_expr()
        date_from = filters.get("date_from")
        date_to = filters.get("date_to")
        if isinstance(date_from, date):
            inv_filters.append(Invoice.issue_date >= date_from)
            exp_filters.append(Expense.expense_date >= date_from)
            te_filters.append(te_date >= date_from)
        if isinstance(date_to, date):
            inv_filters.append(Invoice.issue_date <= date_to)
            exp_filters.append(Expense.expense_date <= date_to)
            te_filters.append(te_date <= date_to)

        invoice_totals = Decimal(str((await db.scalar(select(func.coalesce(func.sum(Invoice.total), 0)).where(and_(*inv_filters)))) or 0))
        paid_totals = Decimal(str((await db.scalar(select(func.coalesce(func.sum(Invoice.paid_amount), 0)).where(and_(*inv_filters)))) or 0))
        outstanding_totals = Decimal(str((await db.scalar(select(func.coalesce(func.sum(Invoice.balance_due), 0)).where(and_(*inv_filters)))) or 0))
        expense_totals = Decimal(str((await db.scalar(select(func.coalesce(func.sum(Expense.amount), 0)).where(and_(*exp_filters)))) or 0))
        billable_minutes_total = Decimal(str((await db.scalar(select(func.coalesce(func.sum(TimeEntry.duration_minutes), 0)).where(and_(*te_filters), TimeEntry.status.in_(["billable", "invoiced"])))) or 0))
        billable_hours_total = (billable_minutes_total / Decimal("60")).quantize(Decimal("0.01")) if billable_minutes_total else Decimal("0.00")

        metrics = Table([
            ["Metric", "Value"],
            ["Invoice Totals", _money(invoice_totals)],
            ["Paid Totals", _money(paid_totals)],
            ["Outstanding Totals", _money(outstanding_totals)],
            ["Expense Totals", _money(expense_totals)],
            ["Billable Hours", f"{billable_hours_total:,.2f}"],
        ], colWidths=[3.6 * inch, 2.8 * inch])
        metrics.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2a44")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d9deea"))]))
        story.append(metrics)

    elif report_type == "trust":
        total_trust_balance = Decimal(str((await db.scalar(select(func.coalesce(func.sum(TrustLedger.current_balance), 0)).where(TrustLedger.organization_id == organization_id))) or 0))
        by_client = (await db.execute(select(TrustLedger.client_id, func.coalesce(func.sum(TrustLedger.current_balance), 0).label("bal")).where(TrustLedger.organization_id == organization_id).group_by(TrustLedger.client_id))).all()
        recent = (await db.execute(select(TrustTransaction.id, TrustTransaction.transaction_type, TrustTransaction.amount, TrustTransaction.client_id, TrustTransaction.case_id, TrustTransaction.transaction_date).where(TrustTransaction.organization_id == organization_id).order_by(TrustTransaction.created_at.desc()).limit(20))).all()

        story.append(Paragraph(f"Total Trust Balance: {_money(total_trust_balance)}", styles["ViloH2"]))
        story.append(Spacer(1, 8))
        by_client_rows = [[str(r.client_id), _money(Decimal(str(r.bal or 0)))] for r in by_client]
        by_client_tbl = Table([["Client ID", "Balance"]] + (by_client_rows if by_client_rows else [["-", _money(0)]]), colWidths=[3.0 * inch, 3.4 * inch])
        by_client_tbl.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2a44")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d9deea"))]))
        story.extend([Paragraph("Balances by Client", styles["ViloH2"]), by_client_tbl, Spacer(1, 10)])

        recent_rows = [[str(r.id), r.transaction_type, str(r.client_id or "-"), str(r.case_id or "-"), _money(Decimal(str(r.amount or 0))), _display_date(r.transaction_date)] for r in recent]
        recent_tbl = Table([["ID", "Type", "Client", "Case", "Amount", "Date"]] + (recent_rows if recent_rows else [["-", "-", "-", "-", _money(0), "-"]]), colWidths=[0.6 * inch, 1.2 * inch, 0.8 * inch, 0.8 * inch, 1.1 * inch, 1.9 * inch])
        recent_tbl.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2a44")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d9deea"))]))
        story.extend([Paragraph("Recent Transactions", styles["ViloH2"]), recent_tbl])

    else:
        filters_clause = [Case.organization_id == organization_id]
        if filters.get("status"):
            filters_clause.append(Case.status == filters["status"])
        if filters.get("priority"):
            filters_clause.append(Case.priority == filters["priority"])
        if filters.get("client_id"):
            filters_clause.append(Case.client_id == int(filters["client_id"]))
        if isinstance(filters.get("date_from"), date):
            filters_clause.append(func.date(Case.created_at) >= filters["date_from"])
        if isinstance(filters.get("date_to"), date):
            filters_clause.append(func.date(Case.created_at) <= filters["date_to"])

        rows = (await db.execute(select(Case.id, Case.title, Case.status, Case.priority, Case.client_id, Case.created_at).where(and_(*filters_clause)).order_by(Case.created_at.desc()))).all()
        case_rows = [[str(r.id), r.title, str(r.status), str(r.priority), str(r.client_id), _display_date(r.created_at)] for r in rows]
        case_tbl = Table([["ID", "Title", "Status", "Priority", "Client", "Created"]] + (case_rows if case_rows else [["-", "No cases", "-", "-", "-", "-"]]), colWidths=[0.5 * inch, 2.5 * inch, 1.0 * inch, 1.0 * inch, 0.7 * inch, 1.1 * inch])
        case_tbl.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2a44")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d9deea"))]))
        story.append(case_tbl)

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return GeneratedPdf(file_path=path, filename=filename)
