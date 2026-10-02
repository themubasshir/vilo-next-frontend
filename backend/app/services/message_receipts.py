from datetime import datetime
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.conversation import Message
from app.models.message_receipt import MessageReceipt


async def receipt_summary(db: AsyncSession, message: Message) -> dict:
    receipts = (await db.scalars(select(MessageReceipt).join(Message, Message.id == MessageReceipt.message_id).where(
        Message.id == message.id, Message.organization_id == message.organization_id,
    ))).all()
    recipient_count = len(receipts)
    read_count = sum(receipt.read_at is not None for receipt in receipts)
    all_read = recipient_count > 0 and read_count == recipient_count
    delivered = recipient_count > 0 and all(receipt.delivered_at is not None for receipt in receipts)
    return {
        "delivery_status": "read" if all_read else "delivered" if delivered else "sent",
        "read_at": max(receipt.read_at for receipt in receipts) if all_read else None,
        "recipient_count": recipient_count,
        "read_count": read_count,
    }


async def record_first_read(db: AsyncSession, *, organization_id: int, conversation_id: int, user_id: int, cutoff: datetime, now: datetime) -> None:
    # Write-once first read, restricted to the authenticated recipient and fetched boundary.
    await db.execute(update(MessageReceipt).where(
        MessageReceipt.user_id == user_id,
        MessageReceipt.read_at.is_(None),
        MessageReceipt.message_id.in_(select(Message.id).where(
            Message.organization_id == organization_id,
            Message.conversation_id == conversation_id,
            Message.sender_id != user_id,
            Message.deleted_at.is_(None),
            Message.created_at <= cutoff,
        )),
    ).values(read_at=now).execution_options(synchronize_session=False))
