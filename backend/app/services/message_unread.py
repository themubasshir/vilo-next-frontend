from sqlalchemy import and_, func, or_, select
from app.models.conversation import Conversation, ConversationParticipant, Message


async def unread_messages_count(db, *, organization_id: int, user_id: int) -> int:
    participant = select(ConversationParticipant.id).where(
        ConversationParticipant.organization_id == organization_id,
        ConversationParticipant.conversation_id == Message.conversation_id,
        ConversationParticipant.user_id == user_id,
        or_(ConversationParticipant.last_read_at.is_(None),
            Message.created_at > ConversationParticipant.last_read_at),
    ).exists()
    return int((await db.scalar(select(func.count(Message.id)).join(
        Conversation, and_(Conversation.id == Message.conversation_id,
                           Conversation.organization_id == organization_id),
    ).where(Message.organization_id == organization_id, Message.sender_id != user_id,
            Message.deleted_at.is_(None), participant))) or 0)
