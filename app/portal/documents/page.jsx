"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "../../../lib/api";
import { formatViloDate } from "../../../lib/dateFormat";

export default function PortalDocumentsPage() {
  const [rows, setRows] = useState({ items: [], total: 0, page: 1, page_size: 10 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    setLoading(true);
    setError("");
    apiRequest(`/api/v1/portal/documents?page=${page}&page_size=10`)
      .then(setRows)
      .catch((err) => setError(err.message || "Failed to load documents"))
      .finally(() => setLoading(false));
  }, [page]);

  const hasPrev = rows.page > 1;
  const hasNext = rows.page * rows.page_size < rows.total;

  return (
    <section className="dashboard-page-stack">
      <div className="dashboard-page-heading"><h1>Documents</h1></div>
      {loading ? <p className="vilo-state">Loading documents...</p> : null}
      {error ? <p className="vilo-state vilo-state--error">{error}</p> : null}
      {!loading && !error && !rows.items.length ? <p className="vilo-state">No shared documents available.</p> : null}
      {!loading && !error && rows.items.length ? (
        <article className="dashboard-card vilo-table-card">
          <div className="vilo-table-wrap">
            <table className="team-table">
              <thead><tr><th>Title</th><th>Category</th><th>Date</th><th>Download</th></tr></thead>
              <tbody>
                {rows.items.map((d) => (
                  <tr key={d.id}>
                    <td>{d.title}</td>
                    <td>{d.category || "-"}</td>
                    <td>{formatViloDate(d.created_at)}</td>
                    <td><a href={`${process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000"}/api/v1/portal/documents/${d.id}/download`} target="_blank">Download</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="vilo-pagination">
            <button onClick={() => setPage((p) => p - 1)} disabled={!hasPrev}>Previous</button>
            <span>Page {rows.page}</span>
            <button onClick={() => setPage((p) => p + 1)} disabled={!hasNext}>Next</button>
          </div>
        </article>
      ) : null}
    </section>
  );
}
