"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../../lib/api";
import { formatViloDate } from "../../lib/dateFormat";

const POLL_INTERVAL_MS = 25_000;

function formatSchedule(metadata) {
  const raw = metadata?.due_date || metadata?.starts_at;
  if (!raw) return null;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) return null;
  return {
    date: formatViloDate(value),
    time: value.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

function reminderLink(notification) {
  const metadata = notification.metadata || {};
  if (notification.type === "message_received" && metadata.conversation_id) return `/dashboard/messages?conversation=${encodeURIComponent(metadata.conversation_id)}`;
  if (metadata.link) return metadata.link;
  if (metadata.task_id) return `/dashboard/tasks/${metadata.task_id}`;
  if (metadata.calendar_event_id) return `/dashboard/calendar?event_id=${metadata.calendar_event_id}`;
  return "/dashboard";
}

export function ReminderPopups() {
  const router = useRouter();
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestInFlight = useRef(false);
  const refreshGeneration = useRef(0);
  const actionButtonRef = useRef(null);
  const actionInFlight = useRef(false);
  const removedIds = useRef(new Set());
  const previousFocus = useRef(null);
  const current = items[0];

  const loadReminders = useCallback(async () => {
    if (actionInFlight.current || requestInFlight.current || document.visibilityState === "hidden") return;
    requestInFlight.current = true;
    const generation = refreshGeneration.current;
    try {
      const response = await apiRequest("/api/v1/notifications/popup-alerts?limit=10");
      if (generation !== refreshGeneration.current) return;
      setItems((response.items || []).filter((item) => !removedIds.current.has(item.id)));
      setError("");
    } catch (requestError) {
      if (requestError?.message !== "Unauthorized") setError("Reminders could not be refreshed.");
    } finally {
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    loadReminders();
    const interval = window.setInterval(loadReminders, POLL_INTERVAL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") loadReminders();
    };
    const onRead = (event) => {
      refreshGeneration.current += 1;
      const ids = event.detail?.ids;
      setItems((queued) => queued.filter((item) => item.type !== "message_received" || (ids && !ids.includes(item.id))));
      loadReminders();
    };
    window.addEventListener("vilo:notifications-read", onRead);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("vilo:notifications-read", onRead);
    };
  }, [loadReminders]);

  useEffect(() => {
    if (!current) return;
    const focused = document.activeElement;
    if (!focused?.closest(".reminder-popup")) previousFocus.current = focused;
    // An incoming message must not interrupt someone typing their draft.
    if (current.type !== "message_received" || !focused?.matches("input, textarea, [contenteditable='true']")) actionButtonRef.current?.focus();
    return () => {
      if (document.activeElement?.closest(".reminder-popup")) previousFocus.current?.focus();
    };
  }, [current?.id]);

  const dismiss = useCallback(async (notification) => {
    if (!notification || actionInFlight.current) return false;
    actionInFlight.current = true;
    setBusy(true);
    try {
      await apiRequest(`/api/v1/notifications/${notification.id}/dismiss-popup`, { method: "POST" });
      if (document.activeElement?.closest(".reminder-popup")) previousFocus.current?.focus();
      removedIds.current.add(notification.id);
      setItems((queued) => queued.filter((item) => item.id !== notification.id));
      setError("");
      return true;
    } catch {
      setError("This alert could not be dismissed. Please try again.");
      return false;
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }, [busy]);

  const viewReminder = useCallback(async () => {
    if (!current || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    try {
      await apiRequest("/api/v1/notifications/mark-read", {
        method: "POST",
        body: JSON.stringify({ notification_ids: [current.id] }),
      });
      await apiRequest(`/api/v1/notifications/${current.id}/dismiss-popup`, { method: "POST" });
      removedIds.current.add(current.id);
      setItems((queued) => queued.filter((item) => item.id !== current.id));
      window.dispatchEvent(new CustomEvent("vilo:notifications-read", { detail: { ids: [current.id] } }));
      router.push(reminderLink(current));
    } catch {
      setError("This alert could not be opened. Please try again.");
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }, [busy, current, router]);

  useEffect(() => {
    if (!current) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss(current);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [current, dismiss]);

  if (!current) return null;

  const metadata = current.metadata || {};
  const schedule = formatSchedule(metadata);
  const isMessage = current.type === "message_received";
  const isTask = Boolean(metadata.task_id) || current.type.startsWith("task_");

  return (
    <section
      className="reminder-popup"
      role="dialog"
      aria-modal="false"
      aria-labelledby="reminder-popup-category"
      aria-describedby="reminder-popup-message"
      aria-live="assertive"
    >
      <div className="reminder-popup__header">
        <span className="reminder-popup__eyebrow" id="reminder-popup-category">
          {isMessage ? "New Message" : metadata.display_category || current.title}
        </span>
        {items.length > 1 ? <span className="reminder-popup__queue">1 of {items.length}</span> : null}
      </div>
      <h2>{metadata.conversation_title || metadata.record_title || current.title}</h2>
      <p id="reminder-popup-message">{current.body}</p>
      <dl className="reminder-popup__details">
        {schedule ? (
          <div><dt>Date</dt><dd>{schedule.date} at {schedule.time}</dd></div>
        ) : null}
        {metadata.case_title ? (
          <div><dt>Case</dt><dd>{metadata.case_title}</dd></div>
        ) : null}
        {metadata.client_name ? (
          <div><dt>Client</dt><dd>{metadata.client_name}</dd></div>
        ) : null}
      </dl>
      {error ? <p className="reminder-popup__error" role="alert">{error}</p> : null}
      <div className="reminder-popup__actions">
        <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => dismiss(current)} disabled={busy}>
          Dismiss
        </button>
        <button ref={actionButtonRef} type="button" className="vilo-btn vilo-btn--primary" onClick={viewReminder} disabled={busy}>
          {isMessage ? "Open Message" : isTask ? "View Task" : "View Event"}
        </button>
      </div>
    </section>
  );
}
