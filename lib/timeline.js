const EVENT_LABELS = {
  document_onlyoffice_edited: "Document Edited",
  document_edited: "Document Edited",
  document_replaced: "Document Replaced",
  document_uploaded: "Document Uploaded",
  task_created: "Task Created",
  task_completed: "Task Completed",
  case_updated: "Case Updated",
};

export function formatTimelineEventType(type) {
  const normalized = String(type || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (Object.hasOwn(EVENT_LABELS, normalized)) return EVENT_LABELS[normalized];
  return normalized.split("_").filter((word) => word && word !== "onlyoffice")
    .map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") || "Event";
}

export function formatTimelineTime(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  const hours = date.getHours();
  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"}`;
}
