from datetime import datetime
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False)
    case_id: Mapped[int | None] = mapped_column(ForeignKey("cases.id", ondelete="SET NULL"), index=True, nullable=True)
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id", ondelete="SET NULL"), index=True, nullable=True)
    source_precedent_id: Mapped[int | None] = mapped_column(ForeignKey("precedents.id", ondelete="SET NULL"), index=True, nullable=True)
    uploaded_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True, nullable=False)
    last_edited_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_edited_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    file_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    file_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    visibility: Mapped[str] = mapped_column(String(30), nullable=False, default="internal")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    version_source: Mapped[str] = mapped_column(String(30), nullable=False, default="upload")
    version_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    organization = relationship("Organization", back_populates="documents")
    case = relationship("Case", back_populates="documents")
    client = relationship("Client", back_populates="documents")
    source_precedent = relationship("Precedent")
    uploader = relationship("User", back_populates="uploaded_documents", foreign_keys=[uploaded_by])
    versions = relationship("DocumentVersion", back_populates="document", cascade="all, delete-orphan")
