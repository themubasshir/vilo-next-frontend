"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getCachedUser, setCachedUser } from "../../../lib/auth";
import { apiRequest } from "../../../lib/api";
import ViloDateInput from "../../../components/ViloDateInput";

const REPORT_TABS = [
  { id: "revenue", label: "Revenue by Staff Member" },
  { id: "time", label: "Time Entries by Staff Member" },
];

const reportInitialFilters = {
  date_from: "",
  date_to: "",
  staff_user_id: "",
  currency: "",
};

function roleCanView(role) {
  return role === "partner" || role === "admin" || role === "lawyer";
}

function formatMoney(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value || 0));
}

function buildQuery(filters) {
  const params = new URLSearchParams();
  if (filters.date_from) params.set("date_from", filters.date_from);
  if (filters.date_to) params.set("date_to", filters.date_to);
  if (filters.staff_user_id) params.set("staff_user_id", filters.staff_user_id);
  if (filters.currency) params.set("currency", filters.currency);
  return params.toString();
}

function EmptyTableState({ message }) {
  return (
    <div className="vilo-state-block">
      <p className="vilo-state">{message}</p>
    </div>
  );
}

export default function BillingPage() {
  const [currentUser, setCurrentUser] = useState(getCachedUser());
  const [summary, setSummary] = useState([]);
  const [invoiceReports, setInvoiceReports] = useState(null);
  const [staff, setStaff] = useState([]);
  const [activeReport, setActiveReport] = useState("revenue");
  const [revenueFilters, setRevenueFilters] = useState(reportInitialFilters);
  const [timeFilters, setTimeFilters] = useState(reportInitialFilters);
  const [revenueRows, setRevenueRows] = useState([]);
  const [timeRows, setTimeRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState("");
  const [reportError, setReportError] = useState("");

  useEffect(() => {
    if (currentUser) return;
    let cancelled = false;
    apiRequest("/api/v1/auth/me")
      .then((me) => {
        if (cancelled) return;
        setCurrentUser(me);
        setCachedUser(me);
      })
      .catch(() => {
        if (cancelled) return;
        setCurrentUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [summaryResponse, invoiceReportResponse, teamResponse] = await Promise.all([
          apiRequest("/api/v1/accounting/summary"),
          apiRequest("/api/v1/reports/invoices"),
          apiRequest("/api/v1/team").catch(() => []),
        ]);
        if (cancelled) return;
        setSummary(summaryResponse.currencies || []);
        setInvoiceReports(invoiceReportResponse);
        setStaff((teamResponse || []).filter((user) => user.role !== "client"));
      } catch (err) {
        if (cancelled) return;
        setError(err.message || "Failed to load billing summary.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadReport() {
      setReportLoading(true);
      setReportError("");
      try {
        const query = buildQuery(activeReport === "revenue" ? revenueFilters : timeFilters);
        const path = activeReport === "revenue"
          ? `/api/v1/reports/billing/revenue-by-staff${query ? `?${query}` : ""}`
          : `/api/v1/reports/billing/time-by-staff${query ? `?${query}` : ""}`;
        const rows = await apiRequest(path);
        if (cancelled) return;
        if (activeReport === "revenue") setRevenueRows(rows || []);
        else setTimeRows(rows || []);
      } catch (err) {
        if (cancelled) return;
        setReportError(err.message || "Failed to load staff billing report.");
      } finally {
        if (!cancelled) setReportLoading(false);
      }
    }
    loadReport();
    return () => {
      cancelled = true;
    };
  }, [activeReport, revenueFilters, timeFilters]);

  const totals = useMemo(() => summary.map((row) => ({ ...row, trustNote: "Trust funds excluded from firm revenue" })), [summary]);

  if (currentUser && !roleCanView(currentUser.role)) {
    return (
      <section className="dashboard-page-stack">
        <div className="vilo-state-block">
          <p className="vilo-state vilo-state--error">You are not authorized to view billing and financial reports.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="dashboard-page-stack billing-finance-page">
      <div className="dashboard-page-heading">
        <h1>Billing & Financial Reports</h1>
        <p className="invoice-page-intro">Collected revenue and time worked are reported separately. Trust deposits remain excluded from revenue.</p>
      </div>

      <div className="invoice-summary-grid billing-finance-links">
        <article className="dashboard-card invoice-summary-card invoice-summary-card--link">
          <span>Invoices</span>
          <strong>Review earned-fee invoices, payment instructions, direct payments, trust applications, and payment void history.</strong>
          <Link href="/dashboard/invoices">Go to Invoices</Link>
        </article>
        <article className="dashboard-card invoice-summary-card invoice-summary-card--link">
          <span>Trust Accounting</span>
          <strong>Trust balances and trust deposits remain separate from the revenue and time reports shown below.</strong>
          <Link href="/dashboard/trust">Go to Trust Accounting</Link>
        </article>
      </div>

      <article className="dashboard-card trust-compliance-banner">
        <strong>Separation of concerns</strong>
        <span>Revenue by staff uses collected invoice payments only. Time by staff uses billable time entries only.</span>
      </article>

      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}
      {loading ? <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading billing summary...</p></div> : null}

      {!loading && !!totals.length ? (
        <div className="billing-currency-stack">
          {totals.map((row) => (
            <article key={row.currency} className="dashboard-card billing-currency-card">
              <div className="dashboard-card__header billing-currency-card__header">
                <div>
                  <h2>{row.currency} Operating Summary</h2>
                  <p>{row.trustNote}</p>
                </div>
                <span className="trust-summary-strip__chip">Trust excluded</span>
              </div>

              <div className="invoice-summary-grid billing-summary-grid">
                <article className="invoice-summary-card invoice-summary-card--financial">
                  <span>Revenue</span>
                  <strong>{formatMoney(row.revenue, row.currency)}</strong>
                </article>
                <article className="invoice-summary-card invoice-summary-card--financial">
                  <span>Direct Payment Total</span>
                  <strong>{formatMoney(row.direct_payment_total, row.currency)}</strong>
                </article>
                <article className="invoice-summary-card invoice-summary-card--financial">
                  <span>Trust Transfer Total</span>
                  <strong>{formatMoney(row.trust_transfer_total, row.currency)}</strong>
                </article>
                <article className="invoice-summary-card invoice-summary-card--financial">
                  <span>Expenses</span>
                  <strong>{formatMoney(row.expenses, row.currency)}</strong>
                </article>
                <article className="invoice-summary-card invoice-summary-card--financial">
                  <span>Profit</span>
                  <strong>{formatMoney(row.profit, row.currency)}</strong>
                </article>
                <article className="invoice-summary-card invoice-summary-card--financial">
                  <span>GCT / Tax Payable</span>
                  <strong>{formatMoney(row.tax_payable, row.currency)}</strong>
                </article>
              </div>
            </article>
          ))}

          {invoiceReports ? (
            <article className="dashboard-card billing-currency-card">
              <div className="dashboard-card__header billing-currency-card__header">
                <div>
                  <h2>Invoice Payment Snapshot</h2>
                  <p>Payment methods below are based on non-voided invoice payment activity only.</p>
                </div>
              </div>
              <div className="invoice-summary-grid billing-summary-grid">
                <article className="invoice-summary-card invoice-summary-card--financial">
                  <span>Paid Invoices</span>
                  <strong>{invoiceReports.totals?.paid_count || 0}</strong>
                </article>
                <article className="invoice-summary-card invoice-summary-card--financial">
                  <span>Unpaid Invoices</span>
                  <strong>{invoiceReports.totals?.unpaid_count || 0}</strong>
                </article>
                <article className="invoice-summary-card invoice-summary-card--financial">
                  <span>Overdue Invoices</span>
                  <strong>{invoiceReports.totals?.overdue_count || 0}</strong>
                </article>
                <article className="invoice-summary-card invoice-summary-card--financial">
                  <span>Outstanding Balance</span>
                  <strong>{formatMoney(invoiceReports.totals?.outstanding_balance || 0, "USD")}</strong>
                </article>
              </div>
              <div className="vilo-table-wrap">
                <table className="team-table">
                  <thead>
                    <tr>
                      <th>Payment Method</th>
                      <th>Invoice Count</th>
                      <th>Paid Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(invoiceReports.payment_method_report?.counts || {}).map(([label, count]) => (
                      <tr key={label}>
                        <td>{label}</td>
                        <td>{count}</td>
                        <td>{formatMoney(invoiceReports.payment_method_report?.totals?.[label] || 0, "USD")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ) : null}
        </div>
      ) : null}

      <article className="dashboard-card billing-report-shell">
        <div className="dashboard-card__header billing-report-shell__header">
          <div>
            <h2>Staff Billing Reports</h2>
            <p className="settings-copy">Keep collected revenue and work performed visibly separate.</p>
          </div>
        </div>

        <div className="settings-tabs billing-report-tabs" role="tablist" aria-label="Billing report tabs">
          {REPORT_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeReport === tab.id}
              className={activeReport === tab.id ? "settings-tab is-active" : "settings-tab"}
              onClick={() => setActiveReport(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeReport === "revenue" ? (
          <>
            <article className="settings-info-banner">
              <strong>Revenue by Staff Member</strong>
              <span>Shows actual revenue collected from paid invoices. Time logged is not counted as revenue.</span>
            </article>
            <div className="billing-report-filters">
              <ViloDateInput value={revenueFilters.date_from} onChange={(value) => setRevenueFilters((current) => ({ ...current, date_from: value }))} />
              <ViloDateInput value={revenueFilters.date_to} onChange={(value) => setRevenueFilters((current) => ({ ...current, date_to: value }))} />
              <select value={revenueFilters.staff_user_id} onChange={(event) => setRevenueFilters((current) => ({ ...current, staff_user_id: event.target.value }))}>
                <option value="">All staff</option>
                {staff.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.role})</option>)}
              </select>
              <select value={revenueFilters.currency} onChange={(event) => setRevenueFilters((current) => ({ ...current, currency: event.target.value }))}>
                <option value="">All currencies</option>
                <option value="USD">USD</option>
                <option value="JMD">JMD</option>
              </select>
            </div>
          </>
        ) : (
          <>
            <article className="settings-info-banner">
              <strong>Time Entries by Staff Member</strong>
              <span>Shows work performed from billable time entries. This is not revenue until invoices are paid.</span>
            </article>
            <div className="billing-report-filters">
              <ViloDateInput value={timeFilters.date_from} onChange={(value) => setTimeFilters((current) => ({ ...current, date_from: value }))} />
              <ViloDateInput value={timeFilters.date_to} onChange={(value) => setTimeFilters((current) => ({ ...current, date_to: value }))} />
              <select value={timeFilters.staff_user_id} onChange={(event) => setTimeFilters((current) => ({ ...current, staff_user_id: event.target.value }))}>
                <option value="">All staff</option>
                {staff.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.role})</option>)}
              </select>
              <select value={timeFilters.currency} onChange={(event) => setTimeFilters((current) => ({ ...current, currency: event.target.value }))}>
                <option value="">All currencies</option>
                <option value="USD">USD</option>
                <option value="JMD">JMD</option>
              </select>
            </div>
          </>
        )}

        {reportError ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{reportError}</p></div> : null}
        {reportLoading ? <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading staff billing report...</p></div> : null}

        {!reportLoading && !reportError && activeReport === "revenue" ? (
          revenueRows.length ? (
            <div className="vilo-table-wrap">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>Staff Name</th>
                    <th>Currency</th>
                    <th>Total Billed</th>
                    <th>Total Collected</th>
                    <th>Number of Invoices</th>
                    <th>Direct Collected</th>
                    <th>Trust Collected</th>
                  </tr>
                </thead>
                <tbody>
                  {revenueRows.map((row) => (
                    <tr key={`${row.staff_user_id}-${row.currency}`}>
                      <td>{row.staff_name}</td>
                      <td>{row.currency}</td>
                      <td>{formatMoney(row.total_billed, row.currency)}</td>
                      <td>{formatMoney(row.total_collected, row.currency)}</td>
                      <td>{row.invoice_count}</td>
                      <td>{formatMoney(row.direct_collected, row.currency)}</td>
                      <td>{formatMoney(row.trust_collected, row.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyTableState message="No collected staff revenue found for the selected filters." />
        ) : null}

        {!reportLoading && !reportError && activeReport === "time" ? (
          timeRows.length ? (
            <div className="vilo-table-wrap">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>Staff Name</th>
                    <th>Currency</th>
                    <th>Total Hours</th>
                    <th>Billable Hours</th>
                    <th>Estimated Value</th>
                  </tr>
                </thead>
                <tbody>
                  {timeRows.map((row) => (
                    <tr key={`${row.staff_user_id}-${row.currency}`}>
                      <td>{row.staff_name}</td>
                      <td>{row.currency}</td>
                      <td>{Number(row.total_hours || 0).toFixed(2)}</td>
                      <td>{Number(row.billable_hours || 0).toFixed(2)}</td>
                      <td>{formatMoney(row.estimated_value, row.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyTableState message="No billable time entry data found for the selected filters." />
        ) : null}
      </article>
    </section>
  );
}
