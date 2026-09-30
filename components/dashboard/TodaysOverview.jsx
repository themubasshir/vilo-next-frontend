"use client";

import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createCardVariants, createHoverLift, createItemVariants } from "../motion";

const fallbackStatItems = [
  { label: "Due Today", value: 12 },
  { label: "Overdue", value: 4 },
  { label: "Messages", value: 9 }
];

const fallbackTimelineRows = [
  { label: "JMMB Bank - 103XXX", priority: "High", tone: "is-high" },
  { label: "JMMB Bank - 103XXX", priority: "Low", tone: "is-low" },
  { label: "JMMB Bank - 103XXX", priority: "Normal", tone: "is-normal" }
];

export function TodaysOverview({ stats = fallbackStatItems, timelineRows = fallbackTimelineRows }) {
  const shouldReduceMotion = useReducedMotion();
  const cardVariants = createCardVariants(shouldReduceMotion);
  const itemVariants = createItemVariants(shouldReduceMotion, "y", 10);
  const hoverLift = createHoverLift(shouldReduceMotion);
  const [openMenu, setOpenMenu] = useState(null);
  const actionAreaRef = useRef(null);
  const showActions = timelineRows.some((row) => row.href || row.actions?.length);

  useEffect(() => {
    function closeOnOutsideClick(event) {
      if (!actionAreaRef.current?.contains(event.target)) setOpenMenu(null);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  function toggleMenu(event, rowKey) {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 190;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
    const spaceBelow = window.innerHeight - rect.bottom;
    setOpenMenu((current) => current?.id === rowKey ? null : {
      id: rowKey,
      left,
      top: spaceBelow >= 110 ? rect.bottom + 6 : rect.top - 6,
      upward: spaceBelow < 110,
    });
  }

  return (
    <motion.section
      className="dashboard-card dashboard-card--overview"
      aria-labelledby="todays-overview-title"
      variants={cardVariants}
      whileHover={hoverLift}
    >
      <div className="dashboard-card__header">
        <h2 id="todays-overview-title">Today&apos;s Overview</h2>
      </div>

      <div className="overview-stats">
        {stats.map((item) => (
          <motion.article key={item.label} className="overview-stats__item" variants={itemVariants}>
            {item.href ? (
              <Link href={item.href} className="overview-stat overview-stat--link">
                <p>{item.label}</p>
                <strong>{item.value}</strong>
              </Link>
            ) : (
              <div className="overview-stat">
                <p>{item.label}</p>
                <strong>{item.value}</strong>
              </div>
            )}
          </motion.article>
        ))}
      </div>

      <div className="overview-table-block" ref={actionAreaRef}>
        <h3>Priority Timeline</h3>

        <div className="overview-table-wrap">
          <table className="overview-table">
            <thead>
              <tr>
                <th>Timeline</th>
                <th>Priority</th>
                {showActions ? <th>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {timelineRows.map((row, index) => {
                const rowKey = row.id || `${row.priority}-${index}`;
                const actions = row.actions?.length ? row.actions : (row.href ? [{ label: "View Task", href: row.href }] : []);
                return (
                <motion.tr key={rowKey} variants={itemVariants}>
                  <td>
                    {row.href ? (
                      <Link className="overview-table__link" href={row.href}>{row.label}</Link>
                    ) : (
                      row.label
                    )}
                  </td>
                  <td>
                    <motion.span
                      className={`priority-badge ${row.tone}`}
                      initial={shouldReduceMotion ? false : { scale: 0.9, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ duration: 0.28, delay: shouldReduceMotion ? 0 : index * 0.08 }}
                    >
                      {row.priority}
                    </motion.span>
                  </td>
                  {showActions ? (
                    <td className="overview-table__actions">
                      {actions.length === 1 ? (
                        <Link
                          href={actions[0].href}
                          className="vilo-btn vilo-btn--secondary vilo-btn--xs"
                          aria-label={`View task ${row.label}`}
                        >
                          View
                        </Link>
                      ) : actions.length > 1 ? (
                        <>
                          <button
                            type="button"
                            className="overview-table__action-link"
                            aria-label={`Actions for task ${row.label}`}
                            aria-haspopup="menu"
                            aria-expanded={openMenu?.id === rowKey}
                            onClick={(event) => toggleMenu(event, rowKey)}
                          >
                            <span aria-hidden="true">•••</span>
                          </button>
                          {openMenu?.id === rowKey ? (
                            <div
                              className={`case-actions-menu task-overlay-menu priority-timeline-action-menu${openMenu.upward ? " task-overlay-menu--upward" : ""}`}
                              role="menu"
                              style={{ left: `${openMenu.left}px`, top: `${openMenu.top}px` }}
                            >
                              {actions.map((action) => (
                                <Link key={action.href} href={action.href} role="menuitem" onClick={() => setOpenMenu(null)}>{action.label}</Link>
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span aria-hidden="true">-</span>
                      )}
                    </td>
                  ) : null}
                </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </motion.section>
  );
}
