"use client";

import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../../lib/api";
import { formatViloDateTime } from "../../../lib/dateFormat";
import ViloDateInput from "../../../components/ViloDateInput";

function fmtDate(value) {
  return formatViloDateTime(value);
}

export default function AuditLogsPage() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [userId, setUserId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const path = useMemo(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    if (action) params.set("action", action);
    if (entityType) params.set("entity_type", entityType);
    if (userId) params.set("user_id", userId);
    if (dateFrom) params.set("date_from", new Date(dateFrom).toISOString());
    if (dateTo) params.set("date_to", new Date(dateTo).toISOString());
    return `/api/v1/audit-logs?${params.toString()}`;
  }, [page, pageSize, action, entityType, userId, dateFrom, dateTo]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const data = await apiRequest(path);
        if (!active) return;
        setRows(data.items || []);
        setTotal(data.total || 0);
      } catch (err) {
        if (!active) return;
        setRows([]);
        setTotal(0);
        setError(err.message || "Failed to load audit logs");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => { active = false; };
  }, [path]);

  return (
    <section className="dashboard-page-stack">
      <div className="dashboard-page-heading"><h1>Audit Logs</h1></div>
      <article className="dashboard-card vilo-form-card">
        <div className="dashboard-card__header"><h2>Filters</h2></div>
        <div className="vilo-form-row-two">
          <input placeholder="Action (e.g. invoice_sent)" value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }} />
          <input placeholder="Entity type (e.g. case)" value={entityType} onChange={(e) => { setPage(1); setEntityType(e.target.value); }} />
          <input placeholder="User ID" value={userId} onChange={(e) => { setPage(1); setUserId(e.target.value); }} />
          <ViloDateInput includeTime value={dateFrom} onChange={(value) => { setPage(1); setDateFrom(value); }} />
          <ViloDateInput includeTime value={dateTo} onChange={(value) => { setPage(1); setDateTo(value); }} />
          <select value={pageSize} onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)); }}>
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={50}>50</option>
          </select>
        </div>
      </article>

      <article className="dashboard-card vilo-table-card">
        <div className="dashboard-card__header"><h2>Events</h2></div>
        {loading ? <p className="vilo-state">Loading audit logs...</p> : null}
        {error ? <p className="vilo-state vilo-state--error">{error}</p> : null}
        {!loading && !error ? (
          <>
            <p className="vilo-state">Total: {total}</p>
            <div className="vilo-table-wrap">
              <table className="team-table">
                <thead>
                  <tr><th>User</th><th>Action</th><th>Entity</th><th>Description</th><th>Timestamp</th></tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.user_id ?? "-"}</td>
                      <td>{row.action}</td>
                      <td>{row.entity_type}{row.entity_id ? ` #${row.entity_id}` : ""}</td>
                      <td>{row.description || "-"}</td>
                      <td>{fmtDate(row.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="vilo-pagination">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <span>Page {page}</span>
              <button disabled={page * pageSize >= total} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </>
        ) : null}
      </article>
    </section>
  );
}
