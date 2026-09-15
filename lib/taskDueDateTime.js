export const TASK_DATE_ONLY_TIME = "09:00";

function pad(value) {
  return String(value).padStart(2, "0");
}

function parseDateParts(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return null;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

export function combineTaskDueDateTime(dueDate, dueTime = "") {
  if (!dueDate) return null;
  const dateParts = parseDateParts(dueDate);
  const timeValue = dueTime || TASK_DATE_ONLY_TIME;
  const timeMatch = String(timeValue).match(/^(\d{2}):(\d{2})$/);
  if (!dateParts || !timeMatch) return null;
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  if (hours > 23 || minutes > 59) return null;
  return new Date(dateParts.year, dateParts.month - 1, dateParts.day, hours, minutes, 0, 0).toISOString();
}

export function splitTaskDueDateTime(timestamp) {
  if (!timestamp) return { due_date: "", due_time: "" };
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return { due_date: "", due_time: "" };
  const dueDate = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const localTime = `${pad(value.getHours())}:${pad(value.getMinutes())}`;
  const isDateOnlySentinel = localTime === TASK_DATE_ONLY_TIME && value.getSeconds() === 0 && value.getMilliseconds() === 0;
  return { due_date: dueDate, due_time: isDateOnlySentinel ? "" : localTime };
}

export function formatTaskDueTime(timestamp) {
  const { due_time: dueTime } = splitTaskDueDateTime(timestamp);
  if (!dueTime) return "—";
  const [hoursValue, minutes] = dueTime.split(":");
  const hours = Number(hoursValue);
  return `${hours % 12 || 12}:${minutes} ${hours >= 12 ? "PM" : "AM"}`;
}
