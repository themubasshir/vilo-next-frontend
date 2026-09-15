const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const VILO_DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function isCalendarDate(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function formatViloDate(value, fallback = "-") {
  if (!value) return fallback;
  const raw = String(value).trim();
  const dateOnly = raw.match(ISO_DATE_PATTERN);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    if (!isCalendarDate(Number(year), Number(month), Number(day))) return fallback;
    return `${day}/${month}/${year}`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

export function formatViloDateTime(value, fallback = "-") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  const hours = date.getHours();
  const displayHours = hours % 12 || 12;
  const period = hours >= 12 ? "PM" : "AM";
  return `${formatViloDate(date, fallback)}, ${displayHours}:${pad(date.getMinutes())} ${period}`;
}

export function toIsoDateFromViloInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(VILO_DATE_PATTERN);
  if (!match) return null;
  const [, day, month, year] = match;
  if (!isCalendarDate(Number(year), Number(month), Number(day))) return null;
  return `${year}-${month}-${day}`;
}

export function formatViloDateInput(value) {
  if (!value) return "";
  const raw = String(value).trim();
  if (toIsoDateFromViloInput(raw)) return raw;
  return formatViloDate(raw, "");
}

export function formatViloDateTimeInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatViloDateTime(date, "");
}

export function toLocalDateTimeFromViloInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  const [, day, month, year, hourValue, minute, periodValue] = match;
  const hour = Number(hourValue);
  if (!isCalendarDate(Number(year), Number(month), Number(day)) || hour < 1 || hour > 12 || Number(minute) > 59) return null;
  const period = periodValue.toUpperCase();
  const hour24 = hour % 12 + (period === "PM" ? 12 : 0);
  return `${year}-${month}-${day}T${pad(hour24)}:${minute}`;
}
