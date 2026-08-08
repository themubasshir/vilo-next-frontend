"use client";

import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { createCardVariants, createHoverLift, createItemVariants } from "../motion";

const fallbackBillingBars = [
  { label: "Paid", value: 210, tone: "is-paid", href: "/dashboard/invoices" },
  { label: "Unpaid", value: 130, tone: "is-unpaid", href: "/dashboard/invoices" },
  { label: "Draft", value: 360, tone: "is-draft", href: "/dashboard/invoices" },
  { label: "Overdue", value: 280, tone: "is-overdue", href: "/dashboard/invoices" }
];

function toneByLabel(label) {
  const key = (label || "").toLowerCase();
  if (key === "paid") return "is-paid";
  if (key === "unpaid") return "is-unpaid";
  if (key === "draft") return "is-draft";
  if (key === "overdue") return "is-overdue";
  return "is-paid";
}

function hrefByLabel(label) {
  const key = String(label || "").toLowerCase();
  if (key === "paid" || key === "unpaid" || key === "draft" || key === "overdue") return "/dashboard/invoices";
  return "/dashboard/billing";
}

export function BillingOverview({ series = [] }) {
  const shouldReduceMotion = useReducedMotion();
  const cardVariants = createCardVariants(shouldReduceMotion);
  const itemVariants = createItemVariants(shouldReduceMotion, "y", 10);
  const hoverLift = createHoverLift(shouldReduceMotion);
  const billingBars = series.length
    ? series.map((item) => ({ label: item.label, value: Number(item.value || 0), tone: toneByLabel(item.label), href: hrefByLabel(item.label) }))
    : fallbackBillingBars;
  const maxValue = Math.max(0, ...billingBars.map((bar) => bar.value));
  const safeMax = maxValue === 0 ? 1 : roundChartMax(maxValue);
  const billingAxisLabels = [safeMax, safeMax * 0.75, safeMax * 0.5, safeMax * 0.25, 0].map((value) =>
    Number.isInteger(value) ? value : Math.round(value)
  );

  return (
    <motion.section
      className="dashboard-card dashboard-card--billing"
      aria-labelledby="billing-overview-title"
      variants={cardVariants}
      whileHover={hoverLift}
    >
      <div className="dashboard-card__header">
        <h2 id="billing-overview-title">Billing Overview</h2>
      </div>

      <div className="billing-card__body">
        <div className="billing-chart" style={{ "--billing-axis-width": `${Math.max(3.5, Math.min(7, String(safeMax).length * 0.62 + 1.25))}rem` }}>
          <div className="billing-chart__axis">
            {billingAxisLabels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>

          <div className="billing-chart__plot">
            <div className="billing-chart__grid">
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>

            <div className="billing-chart__bars" style={{ gridTemplateColumns: `repeat(${billingBars.length || 1}, 1fr)` }}>
              {billingBars.map((bar, index) => (
                <motion.div key={bar.label} className="billing-bar" variants={itemVariants}>
                  {bar.href ? (
                    <Link href={bar.href} className="billing-bar__link" aria-label={`${bar.label} invoices`}>
                      <motion.span
                        className={`billing-bar__fill ${bar.tone}`}
                        initial={shouldReduceMotion ? false : { height: 0 }}
                        animate={{ height: `${maxValue === 0 ? 0 : (bar.value / safeMax) * 100}%` }}
                        transition={{ duration: 0.6, delay: shouldReduceMotion ? 0 : 0.08 * index, ease: "easeOut" }}
                      />
                    </Link>
                  ) : (
                    <motion.span
                      className={`billing-bar__fill ${bar.tone}`}
                      initial={shouldReduceMotion ? false : { height: 0 }}
                      animate={{ height: `${maxValue === 0 ? 0 : (bar.value / safeMax) * 100}%` }}
                      transition={{ duration: 0.6, delay: shouldReduceMotion ? 0 : 0.08 * index, ease: "easeOut" }}
                    />
                  )}
                </motion.div>
              ))}
            </div>
          </div>
        </div>
        {maxValue === 0 ? <p className="billing-empty">No invoice totals available for this period.</p> : null}

        <div className="billing-summary">
          {billingBars.map((bar) => (
            <motion.article key={bar.label} className="billing-summary__card" variants={itemVariants}>
              {bar.href ? (
                <Link href={bar.href} className="billing-summary__link">
                  <p>
                    <span className={`billing-summary__dot ${bar.tone}`} />
                    {bar.label}:
                  </p>
                  <strong>{bar.value}</strong>
                </Link>
              ) : (
                <>
                  <p>
                    <span className={`billing-summary__dot ${bar.tone}`} />
                    {bar.label}:
                  </p>
                  <strong>{bar.value}</strong>
                </>
              )}
            </motion.article>
          ))}
        </div>
      </div>
    </motion.section>
  );
}

function roundChartMax(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}
