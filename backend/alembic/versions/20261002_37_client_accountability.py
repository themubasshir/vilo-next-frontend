"""Message first-read receipts, document editors, and Case practice area.

Revision ID: 20261002_37
Revises: 20260909_36
"""
from alembic import op
import sqlalchemy as sa

revision = "20261002_37"
down_revision = "20260909_36"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("cases", sa.Column("practice_area", sa.String(100), nullable=True))
    op.add_column("documents", sa.Column("last_edited_by_user_id", sa.Integer(), nullable=True))
    op.add_column("documents", sa.Column("last_edited_by_name", sa.String(255), nullable=True))
    op.add_column("documents", sa.Column("last_edited_at", sa.DateTime(timezone=True), nullable=True))
    op.create_foreign_key("fk_documents_last_editor", "documents", "users", ["last_edited_by_user_id"], ["id"], ondelete="SET NULL")
    op.create_table(
        "message_receipts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("message_id", sa.Integer(), sa.ForeignKey("messages.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("message_id", "user_id", name="uq_message_receipts_message_user"),
    )
    op.create_index("ix_message_receipts_message_id", "message_receipts", ["message_id"])
    op.create_index("ix_message_receipts_user_id", "message_receipts", ["user_id"])
    # Historical membership cannot be fully reconstructed. Only participants who
    # joined by message creation are eligible; never invent historical read times.
    op.execute("""
        INSERT INTO message_receipts (message_id, user_id, delivered_at, created_at)
        SELECT DISTINCT m.id, p.user_id, m.created_at, CURRENT_TIMESTAMP
        FROM messages m
        JOIN conversation_participants p ON p.conversation_id = m.conversation_id
          AND p.organization_id = m.organization_id AND p.created_at <= m.created_at
        JOIN users u ON u.id = p.user_id AND u.organization_id = m.organization_id
        WHERE p.user_id != m.sender_id
    """)


def downgrade():
    op.drop_table("message_receipts")
    op.drop_constraint("fk_documents_last_editor", "documents", type_="foreignkey")
    op.drop_column("documents", "last_edited_at")
    op.drop_column("documents", "last_edited_by_name")
    op.drop_column("documents", "last_edited_by_user_id")
    op.drop_column("cases", "practice_area")
