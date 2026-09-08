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
  return `${formatViloDate(date, fallback)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
