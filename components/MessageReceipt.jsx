export default function MessageReceipt({ status, readAt, formatTime }) {
  const read = status === "read" && Boolean(readAt);
  if (!read) return null;
  const time = formatTime(readAt);
  return (
    <div className="message-receipt is-read" role="img" aria-label={`Read at ${time}`}>
      <span className="message-receipt__label">Read</span>{" "}
      <span className="message-receipt__time">{time}</span>
    </div>
  );
}
