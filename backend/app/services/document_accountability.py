from datetime import datetime, timezone
from app.models.document import Document
from app.models.user import User


def record_document_edit(document: Document, actor: User, at: datetime | None = None) -> None:
    document.last_edited_by_user_id = actor.id
    document.last_edited_by_name = actor.name or actor.email or f"User {actor.id}"
    document.last_edited_at = at or datetime.now(timezone.utc)
