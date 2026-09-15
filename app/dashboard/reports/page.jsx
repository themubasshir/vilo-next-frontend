"use client";

import { useEffect, useMemo, useState } from "react";
import { apiDownload, apiRequest } from "../../../lib/api";
import { formatViloDate } from "../../../lib/dateFormat";
import ViloDateInput from "../../../components/ViloDateInput";

const TABS = ["cases", "financial", "trust", "tasks", "activity"];

function fmtCurrency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value || 0));
}

function fmtDate(value) {
  return formatViloDate(value);
}

export default function ReportsPage() {
  const [tab, setTab] = useState("cases");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [caseStatus, setCaseStatus] = useState("");
  const [taskStatus, setTaskStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const path = useMemo(() => {
    const qs = new URLSearchParams();
    if (tab === "cases" && caseStatus) qs.set("status", caseStatus);
    if (tab === "tasks" && taskStatus) qs.set("status", taskStatus);
    if (tab === "financial") {
      if (dateFrom) qs.set("date_from", dateFrom);
      if (dateTo) qs.set("date_to", dateTo);
    }
    const suffix = qs.toString();
    return `/api/v1/reports/${tab}${suffix ? `?${suffix}` : ""}`;
  }, [tab, caseStatus, taskStatus, dateFrom, dateTo]);

  const pdfPath = useMemo(() => {
    if (tab === "financial") {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("date_from", dateFrom);
      if (dateTo) qs.set("date_to", dateTo);
      return `/api/v1/reports/financial/pdf${qs.toString() ? `?${qs}` : ""}`;
    }
    if (tab === "trust") return "/api/v1/reports/trust/pdf";
    if (tab === "cases") {
      const qs = new URLSearchParams();
      if (caseStatus) qs.set("status", caseStatus);
      return `/api/v1/reports/cases/pdf${qs.toString() ? `?${qs}` : ""}`;
    }
    return "";
  }, [tab, caseStatus, dateFrom, dateTo]);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const res = await apiRequest(path);
        if (mounted) setData(res);
      } catch (err) {
        if (mounted) setError(err.message || "Failed to load report");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, [path]);

  return (
    <section className="dashboard-page-stack">
      <div className="dashboard-page-heading"><h1>Reports</h1></div>

      <article className="dashboard-card vilo-form-card" style={{ padding: "1rem" }}>
        <div className="vilo-form-row-two">
          <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
            {TABS.map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} className={tab === t ? "vilo-badge vilo-badge--active" : "vilo-badge"}>{t}</button>
            ))}
          </div>

          {tab === "cases" ? (
            <select value={caseStatus} onChange={(e) => setCaseStatus(e.target.value)}>
              <option value="">All case statuses</option>
              <option value="draft">draft</option>
              <option value="active">active</option>
              <option value="closed">closed</option>
              <option value="archived">archived</option>
            </select>
          ) : null}

          {tab === "tasks" ? (
            <select value={taskStatus} onChange={(e) => setTaskStatus(e.target.value)}>
              <option value="">All task statuses</option>
              <option value="pending">pending</option>
              <option value="in_progress">in_progress</option>
              <option value="completed">completed</option>
              <option value="cancelled">cancelled</option>
            </select>
          ) : null}

          {tab === "financial" ? (
            <div className="vilo-form-row-two">
              <ViloDateInput value={dateFrom} onChange={setDateFrom} aria-label="Date from" />
              <ViloDateInput value={dateTo} onChange={setDateTo} aria-label="Date to" />
            </div>
          ) : null}
          {pdfPath ? <button className="vilo-btn vilo-btn--primary" type="button" onClick={() => apiDownload(pdfPath)}>Export Report PDF</button> : null}
        </div>
      </article>

      <article className="dashboard-card vilo-table-card">
        <div className="dashboard-card__header"><h2>{tab[0].toUpperCase() + tab.slice(1)} Report</h2></div>
        {loading ? <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading report...</p></div> : null}
        {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}

        {!loading && !error && tab === "cases" && data ? (
          <>
            <p className="vilo-state">Total cases: {data.total_count || 0}</p>
            <div className="vilo-table-wrap">
              <table className="team-table">
                <thead><tr><th>Title</th><th>Status</th><th>Priority</th><th>Client</th><th>Created</th></tr></thead>
                <tbody>
                  {(data.cases || []).map((c) => (
                    <tr key={c.id}><td>{c.title}</td><td>{c.status}</td><td>{c.priority}</td><td>#{c.client_id}</td><td>{fmtDate(c.created_at)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {!loading && !error && tab === "financial" && data ? (
          <div style={{ padding: "0 1.25rem 1.25rem" }}>
            <p><strong>Invoice totals:</strong> {fmtCurrency(data.invoice_totals)}</p>
            <p><strong>Paid totals:</strong> {fmtCurrency(data.paid_totals)}</p>
            <p><strong>Outstanding totals:</strong> {fmtCurrency(data.outstanding_totals)}</p>
            <p><strong>Expense totals:</strong> {fmtCurrency(data.expense_totals)}</p>
            <p><strong>Billable time total:</strong> {fmtCurrency(data.billable_time_total)}</p>
            <p><strong>Billable hours total:</strong> {Number(data.billable_hours_total || 0).toFixed(2)}</p>
          </div>
        ) : null}

        {!loading && !error && tab === "trust" && data ? (
          <>
            <p className="vilo-state">Total trust balance: {fmtCurrency(data.total_trust_balance)}</p>
            <p className="vilo-state">Reconciled: {data.reconciliation_status ? "Yes" : "No"}</p>
            <div className="vilo-table-wrap">
              <table className="team-table">
                <thead><tr><th>Type</th><th>Client</th><th>Case</th><th>Amount</th><th>Date</th></tr></thead>
                <tbody>
                  {(data.recent_trust_transactions || []).map((tx) => (
                    <tr key={tx.id}><td>{tx.transaction_type}</td><td>{tx.client_id ? `#${tx.client_id}` : "-"}</td><td>{tx.case_id ? `#${tx.case_id}` : "-"}</td><td>{fmtCurrency(tx.amount)}</td><td>{fmtDate(tx.transaction_date)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {!loading && !error && tab === "tasks" && data ? (
          <>
            <p className="vilo-state">Total tasks: {data.total_tasks || 0} | Overdue: {data.overdue_count || 0}</p>
            <div className="vilo-table-wrap">
              <table className="team-table">
                <thead><tr><th>Title</th><th>Status</th><th>Priority</th><th>Assigned</th><th>Due</th></tr></thead>
                <tbody>
                  {(data.tasks || []).map((t) => (
                    <tr key={t.id}><td>{t.title}</td><td>{t.status}</td><td>{t.priority}</td><td>{t.assigned_to ? `#${t.assigned_to}` : "-"}</td><td>{fmtDate(t.due_date)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {!loading && !error && tab === "activity" && data ? (
          <div className="vilo-table-wrap">
            <table className="team-table">
              <thead><tr><th>Title</th><th>Type</th><th>Case</th><th>When</th></tr></thead>
              <tbody>
                {(data.activity || []).map((a) => (
                  <tr key={a.id}><td>{a.title || "-"}</td><td>{a.event_type}</td><td>{a.case_id ? `#${a.case_id}` : "-"}</td><td>{fmtDate(a.created_at)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {!loading && !error && data && (
          ((tab === "cases" && !(data.cases || []).length) ||
           (tab === "tasks" && !(data.tasks || []).length) ||
           (tab === "activity" && !(data.activity || []).length) ||
           (tab === "trust" && !(data.recent_trust_transactions || []).length)) ? <p className="vilo-state">No report rows found.</p> : null
        )}
      </article>
    </section>
  );
}
