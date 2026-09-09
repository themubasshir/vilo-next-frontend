"""Protected message attachments.

Revision ID: 20260909_36
Revises: 20260724_35
"""
from alembic import op
import sqlalchemy as sa

revision = "20260909_36"
down_revision = "20260724_35"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "message_attachments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("message_id", sa.Integer(), sa.ForeignKey("messages.id", ondelete="CASCADE"), nullable=False),
        sa.Column("uploaded_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("file_name", sa.String(255), nullable=False),
        sa.Column("file_path", sa.String(500), nullable=False),
        sa.Column("file_type", sa.String(100), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("file_size > 0", name="ck_message_attachments_positive_size"),
    )
    op.create_index("ix_message_attachments_organization_id", "message_attachments", ["organization_id"])
    op.create_index("ix_message_attachments_message_id", "message_attachments", ["message_id"])


def downgrade():
    op.drop_index("ix_message_attachments_message_id", table_name="message_attachments")
    op.drop_index("ix_message_attachments_organization_id", table_name="message_attachments")
    op.drop_table("message_attachments")
