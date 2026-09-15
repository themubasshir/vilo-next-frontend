"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api";
import { formatViloDateTime } from "../../lib/dateFormat";

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value || 0));
}

export default function PortalHomePage() {
  const [cases, setCases] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [caseRows, invoiceRows] = await Promise.all([
          apiRequest("/api/v1/portal/cases?page=1&page_size=50"),
          apiRequest("/api/v1/portal/invoices?page=1&page_size=50"),
        ]);
        const casesItems = caseRows.items || [];
        const invoiceItems = invoiceRows.items || [];
        setCases(casesItems);
        setInvoices(invoiceItems);
        if (casesItems.length) {
          const events = await apiRequest(`/api/v1/portal/cases/${casesItems[0].id}/timeline`);
          setActivity(events);
        } else {
          setActivity([]);
        }
      } catch (err) {
        setError(err.message || "Failed to load portal");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const openCases = cases.filter((c) => c.status !== "closed" && c.status !== "archived").length;
  const outstanding = invoices.reduce((sum, inv) => sum + Number(inv.balance_due || 0), 0);

  return (
    <section className="dashboard-page-stack">
      <div className="dashboard-page-heading"><h1>Client Overview</h1></div>
      {loading ? <p className="vilo-state">Loading...</p> : null}
      {error ? <p className="vilo-state vilo-state--error">{error}</p> : null}

      {!loading && !error ? (
        <>
          <div className="dashboard-row-grid">
            <article className="dashboard-card vilo-table-card"><div className="dashboard-card__header"><h2>Case Count</h2></div><p className="vilo-state">{cases.length}</p></article>
            <article className="dashboard-card vilo-table-card"><div className="dashboard-card__header"><h2>Open Cases</h2></div><p className="vilo-state">{openCases}</p></article>
            <article className="dashboard-card vilo-table-card"><div className="dashboard-card__header"><h2>Outstanding Invoices</h2></div><p className="vilo-state">{invoices.filter((i) => Number(i.balance_due) > 0).length}</p></article>
            <article className="dashboard-card vilo-table-card"><div className="dashboard-card__header"><h2>Balance Due</h2></div><p className="vilo-state">{money(outstanding)}</p></article>
          </div>

          <article className="dashboard-card vilo-table-card" style={{ marginTop: "1rem" }}>
            <div className="dashboard-card__header"><h2>Recent Updates</h2></div>
            {!activity.length ? <p className="vilo-state">No recent updates.</p> : (
              <div className="vilo-table-wrap">
                <table className="team-table">
                  <thead><tr><th>Event</th><th>Date</th></tr></thead>
                  <tbody>
                    {activity.slice(0, 10).map((item) => (
                      <tr key={item.id}><td>{item.title}</td><td>{formatViloDateTime(item.created_at)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        </>
      ) : null}
    </section>
  );
}
