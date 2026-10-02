from datetime import datetime
from sqlalchemy import DateTime, Enum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.enums import RecordStatus, UserRole


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    profile_image_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    profile_image_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), nullable=False)
    status: Mapped[RecordStatus] = mapped_column(Enum(RecordStatus), default=RecordStatus.active, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    organization = relationship("Organization", back_populates="users")
    created_cases = relationship("Case", back_populates="creator")
    case_assignments = relationship("CaseAssignment", back_populates="user", cascade="all, delete-orphan")
    client_assignments = relationship("ClientAssignment", back_populates="user", cascade="all, delete-orphan")
    assigned_tasks = relationship("Task", foreign_keys="Task.assigned_to", back_populates="assignee")
    created_tasks = relationship("Task", foreign_keys="Task.created_by", back_populates="creator")
    created_calendar_events = relationship("CalendarEvent", back_populates="creator")
    timeline_events = relationship("CaseTimelineEvent", back_populates="actor")
    uploaded_documents = relationship("Document", back_populates="uploader", foreign_keys="Document.uploaded_by")
    case_notes = relationship("CaseNote", back_populates="author")
    client_profile = relationship("Client", back_populates="user", uselist=False)
    submitted_intakes = relationship("ClientIntake", back_populates="submitter")
    time_entries = relationship("TimeEntry", back_populates="user")
    created_expenses = relationship("Expense", back_populates="creator")
    created_invoices = relationship("Invoice", foreign_keys="Invoice.created_by", back_populates="creator")
    voided_invoices = relationship("Invoice", foreign_keys="Invoice.voided_by_id", back_populates="voided_by")
    invoice_line_items = relationship("InvoiceLineItem", foreign_keys="InvoiceLineItem.staff_user_id", back_populates="staff_user")
    created_firm_payment_accounts = relationship("FirmPaymentAccount", back_populates="creator")
    billing_rates = relationship("BillingRate", foreign_keys="BillingRate.user_id", back_populates="user")
    created_billing_rates = relationship("BillingRate", foreign_keys="BillingRate.created_by_id", back_populates="creator")
    created_invoice_payments = relationship("InvoicePayment", foreign_keys="InvoicePayment.created_by_id", back_populates="created_by")
    voided_invoice_payments = relationship("InvoicePayment", foreign_keys="InvoicePayment.voided_by_id", back_populates="voided_by")
    trust_transactions = relationship("TrustTransaction", foreign_keys="TrustTransaction.created_by_id", back_populates="creator")
    voided_trust_transactions = relationship("TrustTransaction", foreign_keys="TrustTransaction.voided_by_id", back_populates="voided_by")
    issued_trust_receipts = relationship("TrustReceipt", foreign_keys="TrustReceipt.issued_by_id", back_populates="issued_by")
    voided_trust_receipts = relationship("TrustReceipt", foreign_keys="TrustReceipt.voided_by_id", back_populates="voided_by")
    prepared_trust_reconciliations = relationship("TrustReconciliation", back_populates="prepared_by")
    created_operating_transactions = relationship("OperatingTransaction", foreign_keys="OperatingTransaction.created_by_id", back_populates="creator")
    voided_operating_transactions = relationship("OperatingTransaction", foreign_keys="OperatingTransaction.voided_by_id", back_populates="voided_by")

    created_conversations = relationship("Conversation", back_populates="creator")
    conversation_participations = relationship("ConversationParticipant", back_populates="user", cascade="all, delete-orphan")
    sent_messages = relationship("Message", back_populates="sender")
    notifications = relationship("Notification", back_populates="user", cascade="all, delete-orphan")

    sent_invites = relationship("UserInvite", back_populates="inviter")
    audit_logs = relationship("AuditLog", back_populates="user")
