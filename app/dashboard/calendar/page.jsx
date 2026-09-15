"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiRequest } from "../../../lib/api";
import { DiscardChangesDialog, useModalCloseGuard } from "../../../components/useModalCloseGuard";
import { formatViloDate } from "../../../lib/dateFormat";
import ViloDateInput from "../../../components/ViloDateInput";

const VIEW_OPTIONS = ["month", "week", "day"];
const FILTER_OPTIONS = [
  { key: "all", label: "All" },
  { key: "court", label: "Court" },
  { key: "meeting", label: "Meeting" },
  { key: "deadline", label: "Deadline" },
  { key: "consultation", label: "Consultation" },
  { key: "reminder", label: "Task / Reminder" },
  { key: "other", label: "Other" },
];
const EVENT_TYPE_OPTIONS = [
  { value: "court", label: "Court" },
  { value: "client", label: "Meeting" },
  { value: "consultation", label: "Consultation" },
  { value: "travel", label: "Deadline" },
  { value: "staff", label: "Task / Reminder" },
  { value: "note", label: "Other" },
];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const CATEGORY_TO_TONE = {
  court: "is-court",
  meeting: "is-client",
  deadline: "is-travel",
  consultation: "is-consultation",
  reminder: "is-staff",
  other: "is-note",
};

const initialForm = {
  title: "",
  event_type: "court",
  date: "",
  start_time: "",
  end_time: "",
  reminder_choice: "",
  custom_reminder_at: "",
  case_id: "",
  location: "",
  description: "",
};
const REMINDER_OPTIONS = [
  { value: "", label: "No reminder" },
  { value: "0", label: "At start time" },
  { value: "5", label: "5 minutes before" },
  { value: "15", label: "15 minutes before" },
  { value: "30", label: "30 minutes before" },
  { value: "60", label: "1 hour before" },
  { value: "1440", label: "1 day before" },
  { value: "custom", label: "Custom date and time" },
];

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function startOfWeek(date) {
  const copy = new Date(date);
  const day = copy.getDay();
  copy.setDate(copy.getDate() - day);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatEventDate(date) {
  return formatViloDate(date);
}

function formatLongDate(date) {
  return formatViloDate(date);
}

function parseDateValue(value) {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function computeReminderAt(form) {
  if (!form.reminder_choice || !form.date || !form.start_time) return null;
  if (form.reminder_choice === "custom") {
    return form.custom_reminder_at ? new Date(form.custom_reminder_at) : null;
  }
  const start = new Date(`${form.date}T${form.start_time}`);
  if (Number.isNaN(start.getTime())) return null;
  start.setMinutes(start.getMinutes() - Number(form.reminder_choice));
  return start;
}

function normalizeValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
}

function titleCase(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getEventCategory(item) {
  if (item.source_type === "task") {
    if (String(item.task_type || "").toLowerCase() === "deadline") return "deadline";
    return "reminder";
  }

  const candidates = [
    item.event_type,
    item.type,
    item.category,
    item.eventType,
    item.status,
    item.title,
  ];

  for (const candidate of candidates) {
    const value = normalizeValue(candidate);
    if (!value) continue;
    if (value.includes("court") || value.includes("hearing") || value.includes("trial") || value.includes("appearance")) return "court";
    if (value.includes("consult")) return "consultation";
    if (value.includes("deadline") || value.includes("due") || value.includes("filing")) return "deadline";
    if (value.includes("meeting") || value.includes("client")) return "meeting";
    if (value.includes("task") || value.includes("reminder") || value.includes("todo") || value.includes("staff") || value.includes("note")) return "reminder";
  }

  return "other";
}

function getCategoryLabel(category) {
  return FILTER_OPTIONS.find((option) => option.key === category)?.label || "Other";
}

function getEventTypeLabel(type) {
  return EVENT_TYPE_OPTIONS.find((option) => option.value === type)?.label || "Other";
}

function getToneClass(category) {
  return CATEGORY_TO_TONE[category] || CATEGORY_TO_TONE.other;
}

function getTaskPillLabel(item) {
  if (item.is_overdue) return "Overdue";
  if (item.completed) return "Completed";
  return titleCase(item.priority || item.status || "Task");
}

function matchesFilter(item, activeFilter) {
  if (activeFilter === "all") return true;
  if (activeFilter === "reminder" && item.source_type === "task") return true;
  if (activeFilter === "deadline" && item.source_type === "task") {
    return item.category === "deadline" || Boolean(item.due_date || item.start_at);
  }
  return item.category === activeFilter;
}

export default function CalendarPage() {
  return (
    <Suspense fallback={<section className="dashboard-page-stack"><div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading calendar...</p></div></section>}>
      <CalendarPageContent />
    </Suspense>
  );
}

function CalendarPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [items, setItems] = useState([]);
  const [cases, setCases] = useState([]);
  const [view, setView] = useState("month");
  const [selectedMonth, setSelectedMonth] = useState(startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [activeFilter, setActiveFilter] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [modalInitialForm, setModalInitialForm] = useState(initialForm);
  const [editingEvent, setEditingEvent] = useState(null);
  const [deleteEventTarget, setDeleteEventTarget] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [calendarData, caseData] = await Promise.all([
        apiRequest("/api/v1/calendar/events?include_tasks=true"),
        apiRequest("/api/v1/cases"),
      ]);
      setItems(calendarData || []);
      setCases(caseData || []);
    } catch {
      setError("Unable to load calendar data right now.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const queryDate = parseDateValue(searchParams.get("date"));
    if (queryDate) {
      setSelectedDate(queryDate);
      setSelectedMonth(startOfMonth(queryDate));
    }
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get("create") !== "1") return;
    const queryDate = parseDateValue(searchParams.get("date"));
    openModalForDate(queryDate || selectedDate, false);
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  function monthLabel(date) {
    return date.toLocaleDateString([], { month: "long", year: "numeric" });
  }

  function parseCalendarItem(item) {
    const start = new Date(item.start_at);
    const category = getEventCategory(item);
    const isTask = item.source_type === "task";
    return {
      ...item,
      start,
      dateKey: ymd(start),
      category,
      isTask,
      toneClass: getToneClass(category),
      displayType: isTask ? titleCase(item.task_type || "task") : getEventTypeLabel(String(item.event_type || "")),
    };
  }

  const normalizedItems = useMemo(
    () => items.map(parseCalendarItem).sort((a, b) => a.start - b.start),
    [items],
  );

  const filteredItems = useMemo(
    () => normalizedItems.filter((item) => matchesFilter(item, activeFilter)),
    [activeFilter, normalizedItems],
  );

  const monthItems = useMemo(
    () => normalizedItems.filter((item) => item.start.getMonth() === selectedMonth.getMonth() && item.start.getFullYear() === selectedMonth.getFullYear()),
    [normalizedItems, selectedMonth],
  );

  const monthCounts = useMemo(() => {
    const counts = { items: monthItems.length, tasks: 0, court: 0, meeting: 0, consultation: 0 };
    monthItems.forEach((item) => {
      if (item.isTask) counts.tasks += 1;
      if (item.category === "court") counts.court += 1;
      if (item.category === "meeting") counts.meeting += 1;
      if (item.category === "consultation") counts.consultation += 1;
    });
    return counts;
  }, [monthItems]);

  const itemsByDay = useMemo(() => {
    const map = new Map();
    normalizedItems.forEach((item) => {
      const list = map.get(item.dateKey) || [];
      list.push(item);
      map.set(item.dateKey, list);
    });
    return map;
  }, [normalizedItems]);

  const filteredItemsByDay = useMemo(() => {
    const map = new Map();
    filteredItems.forEach((item) => {
      const list = map.get(item.dateKey) || [];
      list.push(item);
      map.set(item.dateKey, list);
    });
    return map;
  }, [filteredItems]);

  const upcomingItems = useMemo(() => {
    const now = new Date();
    return filteredItems.filter((item) => item.start >= now).slice(0, 8);
  }, [filteredItems]);

  const monthGrid = useMemo(() => {
    const start = startOfMonth(selectedMonth);
    const end = endOfMonth(selectedMonth);
    const gridStart = new Date(start);
    gridStart.setDate(start.getDate() - start.getDay());
    const gridEnd = new Date(end);
    gridEnd.setDate(end.getDate() + (6 - end.getDay()));

    const days = [];
    for (const date = new Date(gridStart); date <= gridEnd; date.setDate(date.getDate() + 1)) {
      days.push(new Date(date));
    }
    return days;
  }, [selectedMonth]);

  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(selectedDate);
    return Array.from({ length: 7 }, (_, idx) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + idx);
      return date;
    });
  }, [selectedDate]);

  const selectedDateKey = ymd(selectedDate);
  const selectedDateItems = useMemo(() => itemsByDay.get(selectedDateKey) || [], [itemsByDay, selectedDateKey]);
  const selectedDateFilteredItems = useMemo(() => filteredItemsByDay.get(selectedDateKey) || [], [filteredItemsByDay, selectedDateKey]);

  const selectedEventId = Number(searchParams.get("event_id") || 0);
  const selectedTaskId = Number(searchParams.get("task_id") || 0);

  useEffect(() => {
    const matched = normalizedItems.find((item) => (item.isTask ? item.id === selectedTaskId : item.id === selectedEventId));
    if (!matched) return;
    setSelectedDate(new Date(matched.start));
    setSelectedMonth(startOfMonth(matched.start));
  }, [normalizedItems, selectedEventId, selectedTaskId]);

  function moveMonth(delta) {
    setSelectedMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  }

  function focusItem(item) {
    if (item.isTask) {
      router.push(`/dashboard/tasks/${item.task_id || item.id}`);
      return;
    }
    setSelectedDate(new Date(item.start));
    setSelectedMonth(startOfMonth(item.start));
    const start = new Date(item.start_at);
    const end = item.end_at ? new Date(item.end_at) : null;
    const reminder = item.reminder_at ? new Date(item.reminder_at) : null;
    const nextForm = {
      ...initialForm,
      title: item.title || "",
      event_type: item.event_type || "note",
      date: ymd(start),
      start_time: `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`,
      end_time: end ? `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}` : "",
      reminder_choice: reminder ? "custom" : "",
      custom_reminder_at: reminder ? `${ymd(reminder)}T${String(reminder.getHours()).padStart(2, "0")}:${String(reminder.getMinutes()).padStart(2, "0")}` : "",
      case_id: item.case_id ? String(item.case_id) : "",
      location: item.location || "",
      description: item.description || "",
    };
    setEditingEvent(item);
    setForm(nextForm);
    setModalInitialForm(nextForm);
    setModalOpen(true);
  }

  function selectCalendarDate(date) {
    const nextDate = new Date(date);
    setSelectedDate(nextDate);
    setSelectedMonth(startOfMonth(nextDate));
  }

  function openModalForDate(date, syncQuery = true) {
    const d = new Date(date);
    setSelectedDate(d);
    setSelectedMonth(startOfMonth(d));
    const nextForm = {
      ...initialForm,
      date: ymd(d),
      start_time: "09:00",
      end_time: "10:00",
    };
    setForm(nextForm);
    setEditingEvent(null);
    setModalInitialForm(nextForm);
    setModalOpen(true);
    if (syncQuery) {
      const params = new URLSearchParams(searchParams.toString());
      params.set("create", "1");
      params.set("date", ymd(d));
      router.replace(`/dashboard/calendar?${params.toString()}`);
    }
  }

  function closeModal() {
    setModalOpen(false);
    setForm(initialForm);
    setModalInitialForm(initialForm);
    setEditingEvent(null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("create");
    params.delete("date");
    const next = params.toString();
    router.replace(next ? `/dashboard/calendar?${next}` : "/dashboard/calendar");
  }

  async function saveEvent(event) {
    event.preventDefault();
    if (saving) return;
    setError("");
    setSuccess("");

    if (!form.title.trim() || !form.event_type || !form.date || !form.start_time) {
      setError("Title, Event Type, Date and Start Time are required.");
      return;
    }

    setSaving(true);
    try {
      const startAt = new Date(`${form.date}T${form.start_time}`);
      const endAt = form.end_time ? new Date(`${form.date}T${form.end_time}`) : null;
      const reminderAt = computeReminderAt(form);
      await apiRequest(editingEvent ? `/api/v1/calendar/events/${editingEvent.id}` : "/api/v1/calendar/events", {
        method: editingEvent ? "PATCH" : "POST",
        body: JSON.stringify({
          case_id: form.case_id ? Number(form.case_id) : null,
          title: form.title,
          description: form.description || null,
          event_type: form.event_type,
          start_at: startAt.toISOString(),
          end_at: endAt ? endAt.toISOString() : null,
          reminder_at: reminderAt ? reminderAt.toISOString() : null,
          location: form.location || null,
        }),
      });

      setSuccess(editingEvent ? "Event updated successfully." : (reminderAt ? "Event created with reminder." : "Event created successfully."));
      closeModal();
      await load();
    } catch (err) {
      setError(err.message || `Unable to ${editingEvent ? "update" : "create"} event. Please review the form and try again.`);
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelectedEvent() {
    if (!deleteEventTarget || saving) return;
    setSaving(true);
    setError("");
    try {
      await apiRequest(`/api/v1/calendar/events/${deleteEventTarget.id}`, { method: "DELETE" });
      setDeleteEventTarget(null);
      closeModal();
      setSuccess("Event deleted successfully.");
      await load();
    } catch (err) {
      setError(err.message || "Event could not be deleted.");
    } finally {
      setSaving(false);
    }
  }

  const eventFormDirty = modalOpen && JSON.stringify(form) !== JSON.stringify(modalInitialForm);
  const eventCloseGuard = useModalCloseGuard({ open: modalOpen, isDirty: eventFormDirty, isSubmitting: saving, onClose: closeModal });

  const monthSummary = `${monthCounts.items} scheduled items in ${monthLabel(selectedMonth)}.`;
  const filterLabel = getCategoryLabel(activeFilter);
  const selectedDateHeading = formatLongDate(selectedDate);
  const selectedDateEmptyMessage = activeFilter === "all"
    ? "No events or tasks scheduled for this day."
    : `No ${filterLabel.toLowerCase()} items scheduled for this day.`;

  return (
    <section className="dashboard-page-stack calendar-page">
      <div className="calendar-page-topbar">
        <div className="calendar-page-titleblock">
          <div className="dashboard-page-heading">
            <h1>Calendar</h1>
            <p className="calendar-page-subtitle">{monthSummary}</p>
          </div>
        </div>
        <div className="calendar-page-topbar__actions">
          <div className="calendar-month-switcher">
            <button type="button" className="calendar-month-switcher__arrow" onClick={() => moveMonth(-1)} aria-label="Previous month">‹</button>
            <div className="calendar-month-switcher__label">{monthLabel(selectedMonth)}</div>
            <button type="button" className="calendar-month-switcher__arrow" onClick={() => moveMonth(1)} aria-label="Next month">›</button>
          </div>
          <button type="button" className="vilo-btn vilo-btn--primary" onClick={() => openModalForDate(selectedDate)}>+ Add Event</button>
        </div>
      </div>

      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}
      {success ? <div className="vilo-state-block"><p className="vilo-state">{success}</p></div> : null}

      <div className="calendar-layout-grid">
        <article className="dashboard-card calendar-main-card">
          <div className="calendar-main-head">
            <div className="calendar-main-head__meta">
              <p className="calendar-main-head__eyebrow">Scheduling view</p>
              <h2>{monthLabel(selectedMonth)}</h2>
            </div>
            <div className="calendar-view-toggle" role="tablist" aria-label="Calendar views">
              {VIEW_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={view === option ? "calendar-view-toggle__btn is-active" : "calendar-view-toggle__btn"}
                  onClick={() => setView(option)}
                >
                  {option[0].toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {loading ? <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading calendar...</p></div> : null}

          {!loading && view === "month" ? (
            <div className="calendar-month-shell">
              <div className="calendar-weekdays">
                {WEEKDAY_LABELS.map((day) => <span key={day}>{day}</span>)}
              </div>

              <div className="calendar-month-grid">
                {monthGrid.map((date) => {
                  const key = ymd(date);
                  const allDayItems = itemsByDay.get(key) || [];
                  const filteredDayItems = filteredItemsByDay.get(key) || [];
                  const visibleDayItems = activeFilter === "all" ? allDayItems : filteredDayItems;
                  const previewItems = visibleDayItems.slice(0, 3);
                  const hiddenCount = Math.max(0, visibleDayItems.length - previewItems.length);
                  const inMonth = date.getMonth() === selectedMonth.getMonth();
                  const isToday = sameDay(date, new Date()) && inMonth;
                  const isSelectedDate = sameDay(date, selectedDate);
                  const hasFilterMatch = activeFilter !== "all" && filteredDayItems.length > 0;
                  const isFilterMuted = activeFilter !== "all" && allDayItems.length > 0 && filteredDayItems.length === 0;

                  return (
                    <div
                      key={key}
                      className={`calendar-day-cell ${inMonth ? "" : "is-faded"} ${isToday ? "is-today" : ""} ${isSelectedDate ? "is-selected-date" : ""} ${hasFilterMatch ? "has-filter-match" : ""} ${isFilterMuted ? "is-filter-muted" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectCalendarDate(date)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectCalendarDate(date);
                        }
                      }}
                    >
                      <div className="calendar-day-cell__head">
                        <span className="calendar-day-number">{date.getDate()}</span>
                        {hasFilterMatch ? <span className={`calendar-day-match-dot ${getToneClass(activeFilter)}`} aria-hidden="true" /> : null}
                      </div>
                      <div className="calendar-day-events">
                        {previewItems.map((item) => (
                          <button
                            key={`${item.source_type}-${item.id}`}
                            type="button"
                            className={`calendar-event-pill ${item.toneClass}${selectedEventId === item.id || selectedTaskId === item.id ? " is-selected" : ""}${item.isTask ? " is-task" : ""}${item.completed ? " is-completed" : ""}${item.is_overdue ? " is-overdue" : ""}`}
                            title={`${item.title} · ${formatTime(item.start_at)}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              focusItem(item);
                            }}
                          >
                            <span className="calendar-event-pill__time">{formatTime(item.start_at)}</span>
                            <span className="calendar-event-pill__title">{item.title}</span>
                          </button>
                        ))}
                        {hiddenCount ? <span className="calendar-event-more">+{hiddenCount} more</span> : null}
                        {!visibleDayItems.length && activeFilter !== "all" && allDayItems.length ? <span className="calendar-day-empty-hint">No {filterLabel.toLowerCase()}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="calendar-filters" role="toolbar" aria-label="Calendar event filters">
                {FILTER_OPTIONS.map((option) => {
                  const isActive = activeFilter === option.key;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      className={`calendar-filter-chip ${isActive ? "is-active" : ""}`}
                      onClick={() => setActiveFilter((current) => (current === option.key ? "all" : option.key))}
                      aria-pressed={isActive}
                    >
                      <i className={`calendar-event-dot ${getToneClass(option.key === "all" ? "other" : option.key)}`} />
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {!loading && view === "week" ? (
            <div className="calendar-list-view">
              {weekDays.map((day) => {
                const key = ymd(day);
                const list = activeFilter === "all" ? (itemsByDay.get(key) || []) : (filteredItemsByDay.get(key) || []);
                return (
                  <div key={key} className="calendar-list-day">
                    <h3>{formatViloDate(day)}</h3>
                    {list.length ? list.map((item) => (
                      <button
                        key={`${item.source_type}-${item.id}`}
                        type="button"
                        className={`calendar-list-item ${item.toneClass}${selectedEventId === item.id || selectedTaskId === item.id ? " is-selected" : ""}${item.isTask ? " is-task" : ""}${item.completed ? " is-completed" : ""}${item.is_overdue ? " is-overdue" : ""}`}
                        onClick={() => focusItem(item)}
                      >
                        <strong>{item.title}</strong>
                        <span>{formatTime(item.start_at)}{item.case_id ? ` · Case #${item.case_id}` : ""}</span>
                      </button>
                    )) : <p className="vilo-state">{activeFilter === "all" ? "No events or tasks" : `No ${filterLabel.toLowerCase()} items`}</p>}
                  </div>
                );
              })}
            </div>
          ) : null}

          {!loading && view === "day" ? (
            <div className="calendar-list-view">
              <div className="calendar-list-day">
                <h3>{selectedDateHeading}</h3>
                {selectedDateFilteredItems.length ? selectedDateFilteredItems.map((item) => (
                  <button
                    key={`${item.source_type}-${item.id}`}
                    type="button"
                    className={`calendar-list-item ${item.toneClass}${selectedEventId === item.id || selectedTaskId === item.id ? " is-selected" : ""}${item.isTask ? " is-task" : ""}${item.completed ? " is-completed" : ""}${item.is_overdue ? " is-overdue" : ""}`}
                    onClick={() => focusItem(item)}
                  >
                    <strong>{item.title}</strong>
                    <span>{formatTime(item.start_at)}{item.case_id ? ` · Case #${item.case_id}` : ""}</span>
                  </button>
                )) : <div className="vilo-state-block"><p className="vilo-state">{selectedDateEmptyMessage}</p></div>}
              </div>
            </div>
          ) : null}
        </article>

        <aside className="calendar-side-stack">
          <article className="dashboard-card calendar-side-card calendar-selected-card">
            <div className="dashboard-card__header calendar-selected-card__header">
              <div>
                <p className="calendar-main-head__eyebrow">Selected date</p>
                <h2>{selectedDateHeading}</h2>
              </div>
              <div className="calendar-selected-card__actions">
                <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={() => router.push(`/dashboard/tasks?create=1&due_date=${selectedDateKey}`)}>
                  Add Task
                </button>
                <button type="button" className="vilo-btn vilo-btn--primary vilo-btn--xs" onClick={() => openModalForDate(selectedDate)}>
                  Add Event
                </button>
              </div>
            </div>

            {loading ? (
              <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading events...</p></div>
            ) : (
              <div className="calendar-selected-list">
                {selectedDateFilteredItems.length ? selectedDateFilteredItems.map((item) => (
                  <button
                    key={`${item.source_type}-${item.id}`}
                    type="button"
                    className={`calendar-upcoming-item ${item.toneClass}${selectedEventId === item.id || selectedTaskId === item.id ? " is-selected" : ""}${item.isTask ? " is-task" : ""}${item.completed ? " is-completed" : ""}${item.is_overdue ? " is-overdue" : ""}`}
                    onClick={() => focusItem(item)}
                  >
                    <div className="calendar-upcoming-item__topline">
                      <span>{item.isTask ? "Task" : getCategoryLabel(item.category)}</span>
                      <small>{formatTime(item.start_at)}</small>
                    </div>
                    <strong>{item.title}</strong>
                    <div className="calendar-upcoming-item__meta">
                      <span>{item.case_id ? `Case #${item.case_id}` : "No case linked"}</span>
                      <span>{item.isTask ? getTaskPillLabel(item) : (item.location || item.displayType)}</span>
                    </div>
                  </button>
                )) : (
                  <div className="calendar-selected-empty">
                    <p>{selectedDateEmptyMessage}</p>
                    {activeFilter !== "all" && selectedDateItems.length ? <span>{selectedDateItems.length} other item(s) exist on this date.</span> : null}
                  </div>
                )}
              </div>
            )}
          </article>

          <article className="dashboard-card calendar-side-card">
            <div className="dashboard-card__header"><h2>Upcoming</h2></div>
            {loading ? (
              <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading upcoming items...</p></div>
            ) : upcomingItems.length ? (
              <div className="calendar-upcoming-list">
                {upcomingItems.map((item) => (
                  <button
                    key={`${item.source_type}-${item.id}`}
                    type="button"
                    className={`calendar-upcoming-item ${item.toneClass}${selectedEventId === item.id || selectedTaskId === item.id ? " is-selected" : ""}${item.isTask ? " is-task" : ""}${item.completed ? " is-completed" : ""}${item.is_overdue ? " is-overdue" : ""}`}
                    onClick={() => focusItem(item)}
                  >
                    <div className="calendar-upcoming-item__topline">
                      <span>{formatEventDate(item.start)}</span>
                      <small>{formatTime(item.start_at)}</small>
                    </div>
                    <strong>{item.title}</strong>
                    <div className="calendar-upcoming-item__meta">
                      <span>{item.isTask ? titleCase(item.task_type || "task") : getCategoryLabel(item.category)}</span>
                      <span>{item.case_id ? `Case #${item.case_id}` : "No case linked"}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : <div className="vilo-state-block"><p className="vilo-state">{activeFilter === "all" ? "No upcoming events or tasks." : `No upcoming ${filterLabel.toLowerCase()} items.`}</p></div>}
          </article>

          <article className="dashboard-card calendar-side-card">
            <div className="dashboard-card__header"><h2>Monthly Overview</h2></div>
            <div className="calendar-overview-list">
              <OverviewRow label="Items" count={monthCounts.items} pct={100} tone="is-court" />
              <OverviewRow label="Tasks" count={monthCounts.tasks} pct={monthCounts.items ? Math.round((monthCounts.tasks / monthCounts.items) * 100) : 0} tone="is-staff" />
              <OverviewRow label="Court" count={monthCounts.court} pct={monthCounts.items ? Math.round((monthCounts.court / monthCounts.items) * 100) : 0} tone="is-court" />
              <OverviewRow label="Meeting" count={monthCounts.meeting} pct={monthCounts.items ? Math.round((monthCounts.meeting / monthCounts.items) * 100) : 0} tone="is-client" />
              <OverviewRow label="Consults" count={monthCounts.consultation} pct={monthCounts.items ? Math.round((monthCounts.consultation / monthCounts.items) * 100) : 0} tone="is-consultation" />
            </div>
          </article>
        </aside>
      </div>

      {modalOpen ? (
        <div className="vilo-modal-overlay calendar-event-overlay" onClick={eventCloseGuard.requestClose}>
          <div className="vilo-modal calendar-event-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header calendar-event-modal__header">
              <div>
                <h3>{editingEvent ? "Edit Event" : "Add Event"}</h3>
                <p className="calendar-event-modal__copy">{editingEvent ? "Update this calendar event." : `Create an event for ${formatViloDate(form.date || selectedDateKey)}.`}</p>
              </div>
              <button className="calendar-event-modal__close" type="button" onClick={eventCloseGuard.requestClose} aria-label="Close add event form">×</button>
            </div>

            <form onSubmit={saveEvent}>
              <div className="vilo-modal__body calendar-event-modal__body">
                <div className="calendar-event-modal__section">
                  <div className="calendar-event-modal__field">
                    <label htmlFor="calendar-event-title">Event title *</label>
                    <input id="calendar-event-title" placeholder="Enter event title" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required />
                  </div>
                </div>

                <div className="calendar-event-modal__grid">
                  <div className="calendar-event-modal__field">
                    <label htmlFor="calendar-event-date">Date *</label>
                    <ViloDateInput id="calendar-event-date" value={form.date} onChange={(value) => setForm({ ...form, date: value })} required />
                  </div>
                  <div className="calendar-event-modal__field">
                    <label htmlFor="calendar-event-type">Type / Category *</label>
                    <select id="calendar-event-type" value={form.event_type} onChange={(event) => setForm({ ...form, event_type: event.target.value })} required>
                      {EVENT_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                </div>

                <div className="calendar-event-modal__grid">
                  <div className="calendar-event-modal__field">
                    <label htmlFor="calendar-event-reminder">Reminder</label>
                    <select id="calendar-event-reminder" value={form.reminder_choice} onChange={(event) => setForm({ ...form, reminder_choice: event.target.value, custom_reminder_at: "" })}>
                      {REMINDER_OPTIONS.map((option) => <option key={option.value || "none"} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                  {form.reminder_choice === "custom" ? (
                    <div className="calendar-event-modal__field">
                      <label htmlFor="calendar-event-custom-reminder">Custom reminder</label>
                      <ViloDateInput id="calendar-event-custom-reminder" includeTime value={form.custom_reminder_at} onChange={(value) => setForm({ ...form, custom_reminder_at: value })} />
                    </div>
                  ) : <div className="calendar-event-modal__field" />}
                </div>

                <div className="calendar-event-modal__grid">
                  <div className="calendar-event-modal__field">
                    <label htmlFor="calendar-event-start">Start time *</label>
                    <input id="calendar-event-start" type="time" value={form.start_time} onChange={(event) => setForm({ ...form, start_time: event.target.value })} required />
                  </div>
                  <div className="calendar-event-modal__field">
                    <label htmlFor="calendar-event-end">End time</label>
                    <input id="calendar-event-end" type="time" value={form.end_time} onChange={(event) => setForm({ ...form, end_time: event.target.value })} />
                  </div>
                </div>

                <div className="calendar-event-modal__grid">
                  <div className="calendar-event-modal__field">
                    <label htmlFor="calendar-event-case">Related case</label>
                    <select id="calendar-event-case" value={form.case_id} onChange={(event) => setForm({ ...form, case_id: event.target.value })}>
                      <option value="">No related case</option>
                      {cases.map((caseRow) => <option key={caseRow.id} value={caseRow.id}>{caseRow.title}</option>)}
                    </select>
                  </div>
                  <div className="calendar-event-modal__field">
                    <label htmlFor="calendar-event-location">Location</label>
                    <input id="calendar-event-location" placeholder="Enter location" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} />
                  </div>
                </div>

                <div className="calendar-event-modal__field">
                  <label htmlFor="calendar-event-description">Description / Notes</label>
                  <textarea id="calendar-event-description" placeholder="Add notes or context" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
                </div>
              </div>

              <div className="calendar-event-modal__footer">
                {editingEvent ? <button type="button" className="vilo-btn vilo-btn--danger" onClick={() => setDeleteEventTarget(editingEvent)} disabled={saving}>Delete</button> : null}
                <button type="button" className="vilo-btn vilo-btn--secondary" onClick={eventCloseGuard.requestClose} disabled={saving}>Cancel</button>
                <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving}>{saving ? "Saving..." : editingEvent ? "Save Event" : "Create Event"}</button>
              </div>
            </form>
          </div>
          <DiscardChangesDialog open={eventCloseGuard.confirmDiscard} onKeepEditing={eventCloseGuard.keepEditing} onDiscard={eventCloseGuard.discard} />
        </div>
      ) : null}
      {deleteEventTarget ? (
        <div className="vilo-modal-overlay vilo-modal-overlay--nested" onClick={() => setDeleteEventTarget(null)}>
          <div className="vilo-modal vilo-confirm-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header"><h3>Delete Event</h3></div>
            <div className="vilo-modal__body">
              <p>Delete <strong>{deleteEventTarget.title}</strong>? This action cannot be undone.</p>
              <div className="vilo-table-actions">
                <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setDeleteEventTarget(null)}>Cancel</button>
                <button type="button" className="vilo-btn vilo-btn--danger" onClick={deleteSelectedEvent} disabled={saving}>{saving ? "Deleting..." : "Delete Event"}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function OverviewRow({ label, count, pct, tone }) {
  return (
    <div className="calendar-overview-row">
      <div className="calendar-overview-row__header">
        <strong>{label}</strong>
        <span>{count}</span>
      </div>
      <div className="calendar-overview-bar"><i className={tone} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>
    </div>
  );
}
