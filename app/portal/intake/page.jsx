"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "../../../lib/api";
import { formatViloDateTime } from "../../../lib/dateFormat";

const initialForm = {
  full_name: "",
  email: "",
  phone: "",
  address: "",
  matter_type: "",
  description: "",
};

export default function PortalIntakePage() {
  const [form, setForm] = useState(initialForm);
  const [intakes, setIntakes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const rows = await apiRequest("/api/v1/portal/intake");
      setIntakes(rows);
    } catch (err) {
      setError(err.message || "Failed to load intake records");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createDraft(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await apiRequest("/api/v1/portal/intake", { method: "POST", body: JSON.stringify(form) });
      setForm(initialForm);
      await load();
    } catch (err) {
      setError(err.message || "Failed to save intake");
    } finally {
      setSaving(false);
    }
  }

  async function submitIntake(id) {
    setError("");
    try {
      await apiRequest(`/api/v1/portal/intake/${id}/submit`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err.message || "Failed to submit intake");
    }
  }

  return (
    <section className="dashboard-page-stack">
      <div className="dashboard-page-heading"><h1>Intake Form</h1></div>
      <article className="dashboard-card vilo-form-card">
        <div className="dashboard-card__header"><h2>New Intake</h2></div>
        <form className="vilo-form-grid" onSubmit={createDraft}>
          <input placeholder="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
          <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required />
          <input placeholder="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <input placeholder="Matter type" value={form.matter_type} onChange={(e) => setForm({ ...form, matter_type: e.target.value })} />
          <textarea placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save Draft"}</button>
        </form>
      </article>

      <article className="dashboard-card vilo-table-card">
        <div className="dashboard-card__header"><h2>My Intake Records</h2></div>
        {loading ? <p className="vilo-state">Loading intake records...</p> : null}
        {error ? <p className="vilo-state vilo-state--error">{error}</p> : null}
        {!loading && !error && !intakes.length ? <p className="vilo-state">No intake records yet.</p> : null}
        {!loading && !error && intakes.length ? (
          <div className="vilo-table-wrap">
            <table className="team-table">
              <thead><tr><th>Full Name</th><th>Status</th><th>Submitted At</th><th>Action</th></tr></thead>
              <tbody>
                {intakes.map((item) => (
                  <tr key={item.id}>
                    <td>{item.full_name}</td>
                    <td>{item.status}</td>
                    <td>{formatViloDateTime(item.submitted_at)}</td>
                    <td>{item.status === "draft" ? <button onClick={() => submitIntake(item.id)}>Submit</button> : "Read-only"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </article>
    </section>
  );
}
