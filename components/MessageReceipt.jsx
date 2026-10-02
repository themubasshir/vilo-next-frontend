export default function MessageReceipt({ status, readAt, formatTime }) {
  const read = status === "read" && Boolean(readAt);
  const delivered = status === "delivered" || status === "read";
  const time = read ? formatTime(readAt) : null;
  const label = read ? `Read at ${time}` : delivered ? "Delivered" : "Sent";
  return (
    <div className={`message-receipt${read ? " is-read" : ""}`} role="img" aria-label={label}>
      <span className="message-receipt__ticks" aria-hidden="true">{delivered ? "✓✓" : "✓"}</span>
      <span>{read ? `Read ${time}` : delivered ? "Delivered" : "Sent"}</span>
    </div>
  );
}
