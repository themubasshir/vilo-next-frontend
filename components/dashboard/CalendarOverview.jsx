"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { createCardVariants, createHoverLift, createItemVariants } from "../motion";
import { formatViloDate } from "../../lib/dateFormat";

const dayLabels = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function colorByType(type) {
  if (type === "court") return "is-purple";
  if (type === "meeting") return "is-green";
  if (type === "deadline") return "is-red";
  if (type === "hearing") return "is-orange";
  return "is-gray";
}

function formatMonthLabel(date) {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function formatSelectedDate(date) {
  return formatViloDate(date);
}

function formatDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildCalendarDates(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - firstDay.getDay());
  const gridEnd = new Date(lastDay);
  gridEnd.setDate(lastDay.getDate() + (6 - lastDay.getDay()));
  const days = [];

  for (const date = new Date(gridStart); date <= gridEnd; date.setDate(date.getDate() + 1)) {
    days.push(new Date(date));
  }

  return days;
}

export function CalendarOverview({ events = [], month, year }) {
  const shouldReduceMotion = useReducedMotion();
  const cardVariants = createCardVariants(shouldReduceMotion);
  const eventVariants = createItemVariants(shouldReduceMotion, "x", 16);
  const hoverLift = createHoverLift(shouldReduceMotion);
  const initialMonthDate = month && year ? new Date(year, month - 1, 1) : new Date();
  const normalizedEvents = events.slice(0, 6).map((item, index) => {
    const startDate = parseDate(item.starts_at);
    return {
      id: item.id || `fallback-${index}`,
      color: colorByType(item.type),
      title: item.title || "Untitled event",
      time: item.time || "Time TBD",
      href: item.href || "/dashboard/calendar",
      startDate,
      dateKey: startDate ? formatDateKey(startDate) : "",
      openHref: item.id ? `/dashboard/calendar?event_id=${item.id}` : "/dashboard/calendar",
    };
  });
  const fallbackSelectedDate = normalizedEvents[0]?.startDate || initialMonthDate;
  const [selectedDate, setSelectedDate] = useState(fallbackSelectedDate);
  const [selectedEventId, setSelectedEventId] = useState(normalizedEvents[0]?.id || null);
  const calendarDates = buildCalendarDates(initialMonthDate);

  useEffect(() => {
    setSelectedDate(normalizedEvents[0]?.startDate || initialMonthDate);
    setSelectedEventId(normalizedEvents[0]?.id || null);
  }, [month, year, events]);

  const selectedDateKey = formatDateKey(selectedDate);
  const selectedDateHasEvent = normalizedEvents.some((event) => event.dateKey === selectedDateKey);
  const selectedEvent = normalizedEvents.find((event) => event.id === selectedEventId) || null;

  function handleDateSelect(date) {
    setSelectedDate(date);
    const matchingEvent = normalizedEvents.find((event) => event.dateKey === formatDateKey(date));
    setSelectedEventId(matchingEvent?.id || null);
  }

  function handleEventSelect(event) {
    if (event.startDate) {
      setSelectedDate(event.startDate);
    }
    setSelectedEventId(event.id);
  }

  return (
    <motion.section
      className="dashboard-card dashboard-card--calendar"
      aria-labelledby="calendar-overview-title"
      variants={cardVariants}
      whileHover={hoverLift}
    >
      <div className="dashboard-card__header">
        <div>
          <h2 id="calendar-overview-title">Calendar Overview</h2>
          <p className="calendar-overview__month">{formatMonthLabel(initialMonthDate)}</p>
        </div>
      </div>

      <div className="calendar-overview">
        <div className="calendar-panel">
          <div className="calendar-panel__days">
            {dayLabels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>

          <div className="calendar-panel__grid">
            {calendarDates.map((date, index) => {
              const dateKey = formatDateKey(date);
              const inCurrentMonth = date.getMonth() === initialMonthDate.getMonth();
              const isSelected = dateKey === selectedDateKey;
              const hasEvents = normalizedEvents.some((event) => event.dateKey === dateKey);

              return (
                <div key={`${dateKey}-${index}`} className="calendar-panel__cell">
                  <button
                    type="button"
                    className={[
                      "calendar-panel__date",
                      !inCurrentMonth ? "is-muted" : "",
                      isSelected ? "is-active" : "",
                      hasEvents ? "has-event" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => handleDateSelect(date)}
                    aria-pressed={isSelected}
                    aria-label={`${formatSelectedDate(date)}${hasEvents ? ", has events" : ""}`}
                  >
                    <span>{date.getDate()}</span>
                    {hasEvents ? <i className="calendar-panel__date-marker" aria-hidden="true" /> : null}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="calendar-panel__footer">
            <div className="calendar-panel__selection">
              <strong>{formatSelectedDate(selectedDate)}</strong>
              <span>{selectedDateHasEvent ? "Event scheduled on this day" : "No events scheduled yet"}</span>
            </div>
            <Link href={`/dashboard/calendar?create=1&date=${selectedDateKey}`} className="calendar-panel__add-link">
              Add Event
            </Link>
          </div>
        </div>

        <div className="calendar-events">
          {normalizedEvents.length ? (
            normalizedEvents.map((item, index) => (
              <motion.article
                key={item.id}
                className={`calendar-event ${item.color}${item.id === selectedEventId ? " is-selected" : ""}`}
                variants={eventVariants}
                initial={shouldReduceMotion ? false : "hidden"}
                animate="show"
                transition={{ delay: shouldReduceMotion ? 0 : 0.08 * index }}
              >
                <button
                  type="button"
                  className="calendar-event__select"
                  onClick={() => handleEventSelect(item)}
                  aria-pressed={item.id === selectedEventId}
                >
                  <span className="calendar-event__title">{item.title}</span>
                  <span className="calendar-event__time">{item.time}</span>
                </button>

                <div className="calendar-event__actions">
                  {item.startDate ? (
                    <span className="calendar-event__date">{formatSelectedDate(item.startDate)}</span>
                  ) : (
                    <span className="calendar-event__date">Date unavailable</span>
                  )}
                  <Link href={item.openHref} className="calendar-event__action-link">
                    Open Event
                  </Link>
                </div>
              </motion.article>
            ))
          ) : (
            <div className="calendar-events__empty">
              <p>No upcoming events yet.</p>
              <Link href={`/dashboard/calendar?create=1&date=${selectedDateKey}`} className="calendar-panel__add-link">
                Add Event
              </Link>
            </div>
          )}

          {selectedEvent?.id ? (
            <div className="calendar-events__selected">
              <p>Selected event date synced to the mini calendar.</p>
              <Link href={selectedEvent.openHref} className="calendar-event__action-link">
                Open Event
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </motion.section>
  );
}
