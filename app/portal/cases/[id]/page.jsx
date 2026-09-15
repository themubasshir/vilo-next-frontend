"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { apiRequest } from "../../../../lib/api";
import { formatViloDateTime } from "../../../../lib/dateFormat";

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value || 0));
}

export default function PortalCaseDetailPage() {
  const params = useParams();
  const id = params?.id;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [caseInfo, timeline, notes, documents, invoices] = await Promise.all([
          apiRequest(`/api/v1/portal/cases/${id}`),
          apiRequest(`/api/v1/portal/cases/${id}/timeline`),
          apiRequest(`/api/v1/portal/notes?case_id=${id}&page=1&page_size=10`),
          apiRequest(`/api/v1/portal/documents?case_id=${id}&page=1&page_size=10`),
          apiRequest(`/api/v1/portal/invoices?case_id=${id}&page=1&page_size=10`),
        ]);
        setData({ caseInfo, timeline, notes: notes.items || [], documents: documents.items || [], invoices: invoices.items || [] });
      } catch (err) {
        setError(err.message || "Failed to load case");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  return (
    <section className="dashboard-page-stack">
      <div className="dashboard-page-heading"><h1>Case Detail</h1></div>
      <Link href="/portal/cases">Back to cases</Link>
      {loading ? <p className="vilo-state">Loading case...</p> : null}
      {error ? <p className="vilo-state vilo-state--error">{error}</p> : null}
      {!loading && !error && data ? (
        <>
          <article className="dashboard-card vilo-table-card">
            <div className="dashboard-card__header"><h2>{data.caseInfo.title}</h2></div>
            <p className="vilo-state">Status: {data.caseInfo.status} | Priority: {data.caseInfo.priority}</p>
            <p className="vilo-state">{data.caseInfo.description || "No description provided."}</p>
          </article>

          <article className="dashboard-card vilo-table-card">
            <div className="dashboard-card__header"><h2>Timeline</h2></div>
            {!data.timeline.length ? <p className="vilo-state">No timeline entries.</p> : (
              <div className="vilo-table-wrap"><table className="team-table"><thead><tr><th>Event</th><th>Date</th></tr></thead><tbody>{data.timeline.map((t) => <tr key={t.id}><td>{t.title}</td><td>{formatViloDateTime(t.created_at)}</td></tr>)}</tbody></table></div>
            )}
          </article>

          <article className="dashboard-card vilo-table-card">
            <div className="dashboard-card__header"><h2>Client-Visible Notes</h2></div>
            {!data.notes.length ? <p className="vilo-state">No notes shared yet.</p> : data.notes.map((n) => <p key={n.id} className="vilo-state">{n.note}</p>)}
          </article>

          <article className="dashboard-card vilo-table-card">
            <div className="dashboard-card__header"><h2>Shared Documents</h2></div>
            {!data.documents.length ? <p className="vilo-state">No documents shared yet.</p> : (
              <div className="vilo-table-wrap"><table className="team-table"><thead><tr><th>Title</th><th>Action</th></tr></thead><tbody>{data.documents.map((d) => <tr key={d.id}><td>{d.title}</td><td><a href={`${process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000"}/api/v1/portal/documents/${d.id}/download`} target="_blank">Download</a></td></tr>)}</tbody></table></div>
            )}
          </article>

          <article className="dashboard-card vilo-table-card">
            <div className="dashboard-card__header"><h2>Invoices</h2></div>
            {!data.invoices.length ? <p className="vilo-state">No invoices linked.</p> : (
              <div className="vilo-table-wrap"><table className="team-table"><thead><tr><th>Invoice</th><th>Status</th><th>Total</th><th>Balance Due</th><th>Action</th></tr></thead><tbody>{data.invoices.map((inv) => <tr key={inv.id}><td>{inv.invoice_number}</td><td>{inv.status}</td><td>{money(inv.total)}</td><td>{money(inv.balance_due)}</td><td><Link href={`/portal/invoices/${inv.id}`}>View</Link></td></tr>)}</tbody></table></div>
            )}
          </article>
        </>
      ) : null}
    </section>
  );
}
