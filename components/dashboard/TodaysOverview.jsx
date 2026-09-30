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
  const [openTaskMenuId, setOpenTaskMenuId] = useState(null);
  const [menuPlacement, setMenuPlacement] = useState({ openUpward: false, alignLeft: false });
  const actionWrapRefs = useRef(new Map());
  const showActions = timelineRows.some((row) => row.href || row.actions?.length);

  useEffect(() => {
    if (openTaskMenuId === null) return undefined;

    function closeOnOutsideClick(event) {
      const activeWrap = actionWrapRefs.current.get(openTaskMenuId);
      if (!activeWrap?.contains(event.target)) setOpenTaskMenuId(null);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") setOpenTaskMenuId(null);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openTaskMenuId]);

  function setActionWrapRef(rowKey, node) {
    if (node) actionWrapRefs.current.set(rowKey, node);
    else actionWrapRefs.current.delete(rowKey);
  }

  function toggleMenu(event, rowKey, actionCount) {
    event.stopPropagation();
    if (openTaskMenuId === rowKey) {
      setOpenTaskMenuId(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = Math.min(190, window.innerWidth - 16);
    const menuHeight = actionCount * 43 + 12;
    const spaceBelow = window.innerHeight - rect.bottom;
    setMenuPlacement({
      openUpward: spaceBelow < menuHeight + 8 && rect.top > spaceBelow,
      alignLeft: rect.right - menuWidth < 8,
    });
    setOpenTaskMenuId(rowKey);
  }

  async function runAction(event, action) {
    event.stopPropagation();
    if (!action.onSelect || action.disabled) return;
    const succeeded = await action.onSelect();
    if (succeeded !== false) setOpenTaskMenuId(null);
  }

  return (
    <motion.section
      className={`dashboard-card dashboard-card--overview${openTaskMenuId !== null ? " is-action-menu-open" : ""}`}
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

      <div className="overview-table-block">
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
                          onClick={(event) => event.stopPropagation()}
                        >
                          View
                        </Link>
                      ) : actions.length > 1 ? (
                        <div className="priority-action-wrap" ref={(node) => setActionWrapRef(rowKey, node)}>
                          <button
                            type="button"
                            className="overview-table__action-link"
                            aria-label="Task actions"
                            aria-haspopup="menu"
                            aria-expanded={openTaskMenuId === rowKey}
                            onClick={(event) => toggleMenu(event, rowKey, actions.length)}
                          >
                            <span aria-hidden="true">•••</span>
                          </button>
                          {openTaskMenuId === rowKey ? (
                            <div
                              className={`case-actions-menu priority-timeline-action-menu${menuPlacement.openUpward ? " priority-timeline-action-menu--upward" : ""}${menuPlacement.alignLeft ? " priority-timeline-action-menu--align-left" : ""}`}
                              role="menu"
                              aria-label={`Actions for ${row.label}`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {actions.map((action) => (
                                action.href ? (
                                  <Link
                                    key={action.id || action.href}
                                    href={action.href}
                                    role="menuitem"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setOpenTaskMenuId(null);
                                    }}
                                  >
                                    {action.label}
                                  </Link>
                                ) : (
                                  <button
                                    key={action.id || action.label}
                                    type="button"
                                    role="menuitem"
                                    disabled={action.disabled}
                                    onClick={(event) => runAction(event, action)}
                                  >
                                    {action.label}
                                  </button>
                                )
                              ))}
                            </div>
                          ) : null}
                        </div>
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
