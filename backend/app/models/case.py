from datetime import date, datetime
import enum
from sqlalchemy import CheckConstraint, Date, DateTime, Enum, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class CaseStatus(str, enum.Enum):
    draft = "draft"
    active = "active"
    closed = "closed"
    archived = "archived"


class CasePriority(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"


class Case(Base):
    __tablename__ = "cases"
    __table_args__ = (
        CheckConstraint(
            "status = 'draft' OR (title IS NOT NULL AND client_id IS NOT NULL)",
            name="ck_cases_non_draft_required_fields",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    practice_area: Mapped[str | None] = mapped_column(String(100), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id", ondelete="RESTRICT"), index=True, nullable=True)
    expected_completion_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[CaseStatus] = mapped_column(Enum(CaseStatus, name="casestatus"), default=CaseStatus.draft, nullable=False)
    priority: Mapped[CasePriority] = mapped_column(Enum(CasePriority, name="casepriority"), default=CasePriority.medium, nullable=False)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    organization = relationship("Organization", back_populates="cases")
    client = relationship("Client", back_populates="cases")
    creator = relationship("User", back_populates="created_cases")
    assignments = relationship("CaseAssignment", back_populates="case", cascade="all, delete-orphan")
    tasks = relationship("Task", back_populates="case")
    calendar_events = relationship("CalendarEvent", back_populates="case")
    timeline_events = relationship("CaseTimelineEvent", back_populates="case", cascade="all, delete-orphan")
    documents = relationship("Document", back_populates="case")
    notes = relationship("CaseNote", back_populates="case", cascade="all, delete-orphan")
    time_entries = relationship("TimeEntry", back_populates="case")
    expenses = relationship("Expense", back_populates="case")
    invoices = relationship("Invoice", back_populates="case")
    trust_ledgers = relationship("TrustLedger", back_populates="case")
    trust_transactions = relationship("TrustTransaction", back_populates="case")
    trust_receipts = relationship("TrustReceipt", back_populates="case")
    conversations = relationship("Conversation", back_populates="case")


class CaseAssignment(Base):
    __tablename__ = "case_assignments"
    __table_args__ = (UniqueConstraint("case_id", "user_id", name="uq_case_assignments_case_user"),)

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    case_id: Mapped[int] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True, nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)

    case = relationship("Case", back_populates="assignments")
    user = relationship("User", back_populates="case_assignments")
