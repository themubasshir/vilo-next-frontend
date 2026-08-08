"use client";

import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createCardVariants, createHoverLift, createItemVariants } from "../motion";

const fallbackRows = [
  {
    caseId: "C-101",
    client: "Apex Group",
    matter: "Corporate Merger",
    lead: "Sarah J.",
    status: "Active",
    due: "Oct 30"
  },
  {
    caseId: "C-102",
    client: "Rahman Holdings",
    matter: "Land Dispute",
    lead: "David K.",
    status: "Active",
    due: "Nov 04"
  },
  {
    caseId: "C-103",
    client: "Blue Ocean Ltd",
    matter: "Contract Review",
    lead: "Maria A.",
    status: "Active",
    due: "Nov 12"
  },
  {
    caseId: "C-104",
    client: "Northline Corp",
    matter: "Employment Matter",
    lead: "Sarah J.",
    status: "Active",
    due: "Nov 20"
  }
];

const tableColumns = ["Case ID", "Client", "Matter", "Lead", "Status", "Due Date"];

export function ActiveFilesTable({ rows = fallbackRows }) {
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();
  const cardVariants = createCardVariants(shouldReduceMotion);
  const rowVariants = createItemVariants(shouldReduceMotion, "y", 12);
  const hoverLift = createHoverLift(shouldReduceMotion);

  return (
    <motion.section
      className="dashboard-card dashboard-card--files"
      aria-labelledby="active-files-title"
      variants={cardVariants}
      whileHover={hoverLift}
    >
      <div className="dashboard-card__header">
        <h2 id="active-files-title">Active Cases</h2>
      </div>

      <div className="files-table-wrap">
        <div className="files-table__scroll">
          <table className="files-table">
            <thead>
              <tr>
                {tableColumns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <motion.tr
                  key={row.caseId}
                  className={row.href ? "files-table__row-link" : ""}
                  variants={rowVariants}
                  initial={shouldReduceMotion ? false : "hidden"}
                  animate="show"
                  transition={{ delay: shouldReduceMotion ? 0 : 0.07 * index }}
                  role={row.href ? "link" : undefined}
                  tabIndex={row.href ? 0 : undefined}
                  onClick={row.href ? () => router.push(row.href) : undefined}
                  onKeyDown={row.href ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      router.push(row.href);
                    }
                  } : undefined}
                >
                  <td>{row.href ? <Link href={row.href} className="files-table__link">{row.caseId}</Link> : row.caseId}</td>
                  <td>{row.clientHref ? <Link href={row.clientHref} className="files-table__link" onClick={(event) => event.stopPropagation()}>{row.client}</Link> : row.client}</td>
                  <td>{row.matter}</td>
                  <td>{row.lead}</td>
                  <td>
                    <motion.span
                      className="files-status-badge"
                      initial={shouldReduceMotion ? false : { scale: 0.92, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ duration: 0.25, delay: shouldReduceMotion ? 0 : 0.1 + index * 0.06 }}
                    >
                      {row.status}
                    </motion.span>
                  </td>
                  <td>{row.due}</td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="files-table__footer">
          <p>Showing {rows.length ? 1 : 0} to {rows.length} of {rows.length} active cases</p>

          <div className="files-pagination" aria-label="Pagination">
            <button type="button" className="files-pagination__button is-arrow" aria-label="Previous page" disabled>
              <ChevronLeftIcon />
            </button>
            <button type="button" className="files-pagination__button is-active" aria-current="page">
              1
            </button>
            <button type="button" className="files-pagination__button is-text" disabled>Next</button>
          </div>
        </div>
      </div>
    </motion.section>
  );
}

function ChevronLeftIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}
