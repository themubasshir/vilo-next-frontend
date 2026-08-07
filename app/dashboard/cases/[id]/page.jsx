"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { apiDownload, apiRequest, apiUpload } from "../../../../lib/api";
import { getToken } from "../../../../lib/auth";

const TABS = ["timeline", "notes", "tasks", "documents", "team"];
const EVENT_TYPES = ["milestone", "hearing", "filing", "call", "meeting", "note"];
const STATUS_TYPES = ["active", "inactive", "pending"];
const PER_PAGE_OPTIONS = [5, 10, 20];

const EMPTY_EVENT = {
  title: "",
  event_type: "milestone",
  event_date: "",
  completed: false,
  status: "active",
  description: "",
};

function fmtDate(v) {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-US");
}

function fmtDateTime(v) {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function labelize(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatMoney(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value || 0));
}

function EmptyState({ text }) {
  return <div className="vilo-state-block"><p className="vilo-state">{text}</p></div>;
}

function Modal({ title, children, onClose }) {
  return (
    <div className="vilo-modal-overlay" onClick={onClose}>
      <div className="vilo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="vilo-modal__header">
          <h3>{title}</h3>
          <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={onClose}>Close</button>
        </div>
        <div className="vilo-modal__body">{children}</div>
      </div>
    </div>
  );
}

export default function CaseDetailPage() {
  const { id } = useParams();
  const [activeTab, setActiveTab] = useState("timeline");
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [search, setSearch] = useState("");
  const [item, setItem] = useState(null);
  const [clients, setClients] = useState([]);
  const [team, setTeam] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [notes, setNotes] = useState([]);
  const [timeline, setTimeline] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [filters, setFilters] = useState({ event_type: "", status: "", completed: "", date_from: "", date_to: "" });
  const [pendingFilters, setPendingFilters] = useState({ event_type: "", status: "", completed: "", date_from: "", date_to: "" });
  const [perPage, setPerPage] = useState(10);
  const [page, setPage] = useState(1);

  const [modalType, setModalType] = useState("");
  const [selectedRow, setSelectedRow] = useState(null);
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [eventForm, setEventForm] = useState(EMPTY_EVENT);
  const [submitting, setSubmitting] = useState(false);
  const [replaceFile, setReplaceFile] = useState(null);
  const [replaceNotes, setReplaceNotes] = useState("");
  const [versionRows, setVersionRows] = useState([]);
  const [noteForm, setNoteForm] = useState({ note: "", visibility: "internal" });
  const [taskForm, setTaskForm] = useState({ title: "", description: "", status: "pending", priority: "medium", due_date: "", assigned_to: "" });
  const [docForm, setDocForm] = useState({ title: "", description: "", category: "", visibility: "internal", file: null });
  const [selectedAssigneeId, setSelectedAssigneeId] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [caseData, clientData, taskData, docData, noteData, teamData] = await Promise.all([
        apiRequest(`/api/v1/cases/${id}`),
        apiRequest(`/api/v1/clients`),
        apiRequest(`/api/v1/tasks?case_id=${id}`),
        apiRequest(`/api/v1/documents?case_id=${id}`),
        apiRequest(`/api/v1/cases/${id}/notes`),
        apiRequest("/api/v1/team"),
      ]);
      setItem(caseData);
      setClients(clientData || []);
      setTasks(taskData || []);
      setDocuments(docData || []);
      setNotes(noteData || []);
      setTeam((teamData || []).filter((u) => u.role !== "client"));
      const invoiceData = await apiRequest(`/api/v1/invoices?case_id=${id}`).catch(() => []);
      setInvoices(invoiceData || []);
      await loadTimeline(search, filters);
    } catch (err) {
      setError(err.message || "Failed to load case details");
    } finally {
      setLoading(false);
    }
  }

  async function loadTimeline(searchValue = search, activeFilters = filters) {
    const qs = new URLSearchParams();
    if (searchValue) qs.set("search", searchValue);
    if (activeFilters.event_type) qs.set("event_type", activeFilters.event_type);
    if (activeFilters.status) qs.set("status", activeFilters.status);
    if (activeFilters.completed !== "") qs.set("completed", activeFilters.completed);
    if (activeFilters.date_from) qs.set("date_from", activeFilters.date_from);
    if (activeFilters.date_to) qs.set("date_to", activeFilters.date_to);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const data = await apiRequest(`/api/v1/cases/${id}/timeline${suffix}`);
    setTimeline(data || []);
    setPage(1);
  }

  useEffect(() => { load(); }, [id]);

  function openModal(type, row = null) {
    setModalType(type);
    setSelectedRow(row);
    if (type === "add") setEventForm(EMPTY_EVENT);
    if (type === "edit" && row) {
      setEventForm({
        title: row.title || "",
        event_type: row.eventType || "milestone",
        event_date: row.eventDate ? new Date(row.eventDate).toISOString().slice(0, 10) : "",
        completed: row.completed === "Yes",
        status: row.status || "active",
        description: row.description || "",
      });
    }
  }

  async function createEvent(e) {
    e.preventDefault();
    if (!eventForm.title || !eventForm.event_type) {
      setError("Title and event type are required.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await apiRequest(`/api/v1/cases/${id}/timeline`, {
        method: "POST",
        body: JSON.stringify(eventForm),
      });
      setModalType("");
      await loadTimeline();
    } catch (err) {
      setError(err.message || "Failed to create timeline event");
    } finally {
      setSubmitting(false);
    }
  }

  async function updateEvent(e) {
    e.preventDefault();
    if (!selectedRow) return;
    setSubmitting(true);
    setError("");
    try {
      await apiRequest(`/api/v1/cases/${id}/timeline/${selectedRow.id}`, {
        method: "PATCH",
        body: JSON.stringify(eventForm),
      });
      setModalType("");
      await loadTimeline();
    } catch (err) {
      setError(err.message || "Failed to update timeline event");
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteEvent() {
    if (!selectedRow) return;
    setSubmitting(true);
    setError("");
    try {
      await apiRequest(`/api/v1/cases/${id}/timeline/${selectedRow.id}`, { method: "DELETE" });
      setModalType("");
      await loadTimeline();
    } catch (err) {
      setError(err.message || "Failed to delete timeline event");
    } finally {
      setSubmitting(false);
    }
  }

  async function lockEvent() {
    if (!selectedRow) return;
    setSubmitting(true);
    setError("");
    try {
      await apiRequest(`/api/v1/cases/${id}/timeline/${selectedRow.id}`, {
        method: "PATCH",
        body: JSON.stringify({ locked: true }),
      });
      setModalType("");
      await loadTimeline();
    } catch (err) {
      setError(err.message || "Failed to lock timeline event");
    } finally {
      setSubmitting(false);
    }
  }

  async function addCaseNote(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await apiRequest(`/api/v1/cases/${id}/notes`, {
        method: "POST",
        body: JSON.stringify(noteForm),
      });
      setNoteForm({ note: "", visibility: "internal" });
      setModalType("");
      await load();
    } catch (err) {
      setError(err.message || "Failed to create note");
    } finally {
      setSubmitting(false);
    }
  }

  async function addTask(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await apiRequest("/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify({
          ...taskForm,
          case_id: Number(id),
          assigned_to: taskForm.assigned_to ? Number(taskForm.assigned_to) : null,
          due_date: taskForm.due_date || null,
        }),
      });
      setTaskForm({ title: "", description: "", status: "pending", priority: "medium", due_date: "", assigned_to: "" });
      setModalType("");
      await load();
    } catch (err) {
      setError(err.message || "Failed to create task");
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadDocument(e) {
    e.preventDefault();
    if (!docForm.file) {
      setError("Select a file to upload.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const formData = new FormData();
      formData.set("title", docForm.title);
      formData.set("description", docForm.description || "");
      formData.set("category", docForm.category || "");
      formData.set("visibility", docForm.visibility);
      formData.set("case_id", String(id));
      formData.set("file", docForm.file);
      await apiUpload("/api/v1/documents/upload", formData);
      setDocForm({ title: "", description: "", category: "", visibility: "internal", file: null });
      setModalType("");
      await load();
    } catch (err) {
      setError(err.message || "Failed to upload document");
    } finally {
      setSubmitting(false);
    }
  }

  async function replaceDocument(e) {
    e.preventDefault();
    if (!selectedDocument || !replaceFile) {
      setError("Select a replacement file.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const formData = new FormData();
      formData.set("file", replaceFile);
      if (replaceNotes.trim()) formData.set("notes", replaceNotes.trim());
      await apiUpload(`/api/v1/documents/${selectedDocument.id}/replace`, formData);
      setModalType("");
      setSelectedDocument(null);
      setReplaceFile(null);
      setReplaceNotes("");
      await load();
    } catch (err) {
      setError(err.message || "Failed to replace document");
    } finally {
      setSubmitting(false);
    }
  }

  async function openVersionHistory(doc) {
    setSelectedDocument(doc);
    setVersionRows([]);
    setModalType("document-versions");
    try {
      const rows = await apiRequest(`/api/v1/documents/${doc.id}/versions`);
      setVersionRows(rows || []);
    } catch (err) {
      setError(err.message || "Failed to load versions");
    }
  }

  async function assignTeamMember() {
    if (!selectedAssigneeId) return;
    setSubmitting(true);
    setError("");
    try {
      await apiRequest(`/api/v1/cases/${id}/assign`, {
        method: "POST",
        body: JSON.stringify({ user_ids: [Number(selectedAssigneeId)] }),
      });
      setSelectedAssigneeId("");
      await load();
    } catch (err) {
      setError(err.message || "Failed to assign user");
    } finally {
      setSubmitting(false);
    }
  }

  async function unassignTeamMember(userId) {
    if (!item) return;
    setSubmitting(true);
    setError("");
    try {
      const remaining = (item.assigned_users || []).filter((u) => u.id !== userId).map((u) => u.id);
      const updated = await apiRequest(`/api/v1/cases/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ assigned_user_ids: remaining }),
      });
      setItem(updated);
      await load();
    } catch (err) {
      setError(err.message || "Failed to remove user");
    } finally {
      setSubmitting(false);
    }
  }

  function downloadDocument(documentId) {
    const token = getToken();
    const base = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
    fetch(`${base}/api/v1/documents/${documentId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (r) => {
        if (!r.ok) throw new Error("Download failed");
        const blob = await r.blob();
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = "document";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      })
      .catch((err) => setError(err.message));
  }

  const timelineRows = useMemo(() => timeline.map((entry, index) => ({
    id: entry.id,
    n: index + 1,
    title: entry.title || "Timeline event",
    eventType: entry.event_type || "event",
    eventDate: entry.event_date || entry.created_at,
    completed: entry.completed ? "Yes" : "No",
    status: entry.status || "active",
    description: entry.description || "",
    locked: Boolean(entry.locked),
  })), [timeline]);

  const paginatedRows = useMemo(() => {
    const start = (page - 1) * perPage;
    return timelineRows.slice(start, start + perPage);
  }, [timelineRows, page, perPage]);

  const totalPages = Math.max(1, Math.ceil(timelineRows.length / perPage));

  const clientName = useMemo(() => clients.find((c) => c.id === item?.client_id)?.name || `#${item?.client_id || "-"}`, [clients, item]);
  const teamById = useMemo(() => new Map(team.map((member) => [Number(member.id), member])), [team]);
  const caseInvoiceTotals = useMemo(() => ({
    unpaid: invoices.reduce((sum, row) => sum + Number(row.balance_due || 0), 0),
    overdue: invoices.filter((row) => (row.display_status || row.status) === "overdue").reduce((sum, row) => sum + Number(row.balance_due || 0), 0),
  }), [invoices]);

  return (
    <section className="dashboard-page-stack">
      <div className="case-detail-header-row">
        <h1>{item ? `${item.title} (CASE${String(item.id).padStart(6, "0")})` : "Case Detail"}</h1>
        <Link href="/dashboard/cases" className="vilo-btn vilo-btn--secondary">Back To Files</Link>
      </div>

      {loading ? <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading case...</p></div> : null}
      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}

      {!loading && !error && item ? (
        <>
          <article className="dashboard-card case-summary-card">
            <div className="case-summary-grid">
              <div className="case-summary-box"><span>Client:</span><strong>{clientName}</strong></div>
              <div className="case-summary-box"><span>Case Type:</span><strong>{item.title || "-"}</strong></div>
              <div className="case-summary-box"><span>Filling Date:</span><strong>{fmtDate(item.created_at)}</strong></div>
              <div className="case-summary-box"><span>Status:</span><strong><span className={`vilo-badge vilo-badge--${item.status}`}>{item.status}</span></strong></div>
              <div className="case-summary-box"><span>Priority:</span><strong><span className={`vilo-badge vilo-badge--priority-${item.priority}`}>{item.priority}</span></strong></div>
              <div className="case-summary-box"><span>Expected Completion:</span><strong>{item.expected_completion_date ? fmtDate(item.expected_completion_date) : "Not set"}</strong></div>
            </div>
            <div className="case-summary-description">
              <span>Description:</span>
              <p>{item.description || "No description provided for this case yet."}</p>
            </div>
          </article>

          <article className="dashboard-card client-billing-card">
            <div className="dashboard-card__header">
              <h2>Matter Invoices</h2>
              <div className="vilo-table-actions">
                <Link href={`/dashboard/invoices?create=1&case_id=${id}`} className="vilo-btn vilo-btn--primary vilo-btn--xs">Create Invoice</Link>
                <Link href="/dashboard/trust" className="vilo-btn vilo-btn--secondary vilo-btn--xs">Apply Trust Funds</Link>
              </div>
            </div>
            <div className="client-billing-summary">
              <div className="client-billing-metric">
                <span>Invoices</span>
                <strong>{invoices.length}</strong>
              </div>
              <div className="client-billing-metric">
                <span>Unpaid</span>
                <strong>{formatMoney(caseInvoiceTotals.unpaid)}</strong>
              </div>
              <div className="client-billing-metric">
                <span>Overdue</span>
                <strong>{formatMoney(caseInvoiceTotals.overdue)}</strong>
              </div>
            </div>
            {invoices.length ? (
              <div className="vilo-table-wrap case-table-wrap">
                <table className="team-table">
                  <thead><tr><th>Invoice</th><th>Status</th><th>Payment</th><th>Total</th><th>Due</th><th>Action</th></tr></thead>
                  <tbody>
                    {invoices.slice(0, 6).map((row) => (
                      <tr key={row.id}>
                        <td>{row.invoice_number}</td>
                        <td><span className={`vilo-badge vilo-badge--${row.display_status || row.status}`}>{row.display_status || row.status}</span></td>
                        <td>{row.payment_method_summary}</td>
                        <td>{formatMoney(row.total, row.currency || "USD")}</td>
                        <td>{fmtDate(row.due_date)}</td>
                        <td><Link href={`/dashboard/invoices/${row.id}`}>View</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState text="No invoices linked to this matter yet." />}
            <p className="vilo-card-copy">Only trust funds held for this same client and matter can be applied to these invoices.</p>
          </article>

          <article className="dashboard-card case-tabs-card">
            <div className="case-tabs-nav">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={activeTab === t ? "case-tab-btn is-active" : "case-tab-btn"}
                  onClick={() => setActiveTab(t)}
                >
                  {t === "team" ? "Team Members" : t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {activeTab === "timeline" ? (
              <div className="case-tab-panel">
                <div className="case-tab-headline-row">
                  <h2>Timeline</h2>
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => openModal("add")}>+ Add Event</button>
                </div>
                <div className="case-toolbar-row">
                  <input
                    className="case-search-input"
                    placeholder="Search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <button type="button" className="vilo-btn vilo-btn--primary" onClick={() => loadTimeline(search, filters)}>Search</button>
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setModalType("filters")}>Filters</button>
                  <div className="case-per-page">Per Page:
                    <select value={perPage} onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}>
                      {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                </div>

                <div className="vilo-table-wrap case-table-wrap case-table-wrap--menu-visible">
                  <table className="team-table">
                    <thead>
                      <tr><th>#</th><th>Title</th><th>Event Type</th><th>Event Date</th><th>Completed</th><th>Status</th><th>Actions</th></tr>
                    </thead>
                    <tbody>
                      {paginatedRows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.n}</td>
                          <td>{row.title}</td>
                          <td><span className="vilo-badge vilo-badge--completed">{row.eventType}</span></td>
                          <td>{fmtDate(row.eventDate)}</td>
                          <td><span className={`vilo-badge ${row.completed === "Yes" ? "vilo-badge--active" : "vilo-badge--priority-medium"}`}>{row.completed}</span></td>
                          <td><span className={`vilo-badge ${row.status === "active" ? "vilo-badge--active" : "vilo-badge--cancelled"}`}>{row.status}</span></td>
                          <td>
                            <div className="vilo-table-actions case-row-actions" style={{ position: "relative" }}>
                              <button className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setMenuOpenId(menuOpenId === row.id ? null : row.id)}>•••</button>
                              {menuOpenId === row.id ? (
                                <div className="case-actions-menu">
                                  <button type="button" onClick={() => openModal("view", row)}>View</button>
                                  <button type="button" onClick={() => openModal("edit", row)}>Edit</button>
                                  <button type="button" onClick={() => openModal("lock", row)} disabled={row.locked}>{row.locked ? "Locked" : "Lock"}</button>
                                  <button type="button" className="is-danger" onClick={() => openModal("delete", row)}>Delete</button>
                                </div>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!timelineRows.length ? <EmptyState text="No timeline events found." /> : null}
                </div>

                <div className="case-pagination-row">
                  <span>Showing {timelineRows.length ? ((page - 1) * perPage) + 1 : 0} to {Math.min(page * perPage, timelineRows.length)} of {timelineRows.length} timeline events</span>
                  <div className="vilo-table-actions">
                    <button className="vilo-btn vilo-btn--ghost vilo-btn--xs" type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>&lt;</button>
                    <button className="vilo-btn vilo-btn--primary vilo-btn--xs" type="button">{page}</button>
                    <button className="vilo-btn vilo-btn--secondary vilo-btn--xs" type="button" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
                  </div>
                </div>
              </div>
            ) : null}

            {activeTab === "team" ? (
              <div className="case-tab-panel">
                <div className="case-tab-headline-row">
                  <h2>Team Members</h2>
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setModalType("add-team")}>Assign Team Member</button>
                </div>
                {item.assigned_users?.length ? (
                  <div className="vilo-table-wrap case-table-wrap">
                    <table className="team-table">
                      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Action</th></tr></thead>
                      <tbody>
                        {item.assigned_users.map((u) => (
                          <tr key={u.id}>
                            <td>{u.name}</td>
                            <td>{u.email}</td>
                            <td><span className={`vilo-badge vilo-badge--${u.role}`}>{u.role}</span></td>
                            <td><span className={`vilo-badge ${u.status === "active" ? "vilo-badge--active" : "vilo-badge--cancelled"}`}>{u.status}</span></td>
                            <td><button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => unassignTeamMember(u.id)} disabled={submitting}>Remove</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <EmptyState text="No team members assigned to this case." />}
              </div>
            ) : null}

            {activeTab === "documents" ? (
              <div className="case-tab-panel">
                <div className="case-tab-headline-row">
                  <h2>Documents</h2>
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setModalType("add-document")}>Upload Document</button>
                </div>
                {documents.length ? (
                  <div className="vilo-table-wrap case-table-wrap">
                    <table className="team-table">
                      <thead><tr><th>Title</th><th>File</th><th>Category</th><th>Visibility</th><th>Action</th></tr></thead>
                      <tbody>
                        {documents.map((doc) => (
                          <tr key={doc.id}>
                            <td>{doc.title}</td><td>{doc.file_name}</td><td>{doc.category || "-"}</td>
                            <td><span className={`vilo-badge ${doc.visibility === "client_visible" ? "vilo-badge--active" : "vilo-badge--draft"}`}>{doc.visibility}</span></td>
                            <td>
                              <div className="vilo-table-actions">
                                <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={() => downloadDocument(doc.id)}>Download</button>
                                <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => { setSelectedDocument(doc); setModalType("replace-document"); }}>Edit / Replace</button>
                                <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => openVersionHistory(doc)}>Versions</button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <EmptyState text="No documents uploaded for this case yet." />}
              </div>
            ) : null}

            {activeTab === "tasks" ? (
              <div className="case-tab-panel">
                <div className="case-tab-headline-row">
                  <h2>Tasks</h2>
                  <Link href={`/dashboard/tasks?create=1&case_id=${id}`} className="vilo-btn vilo-btn--secondary">Add Task</Link>
                </div>
                {tasks.length ? (
                  <div className="vilo-table-wrap case-table-wrap">
                    <table className="team-table">
                      <thead><tr><th>Title</th><th>Assigned</th><th>Status</th><th>Priority</th><th>Due Date</th><th>Action</th></tr></thead>
                      <tbody>
                        {tasks.map((t) => (
                          <tr key={t.id} className={`tasks-table-row${t.status === "completed" ? " is-completed" : ""}${t.is_overdue ? " is-overdue" : ""}`}>
                            <td>
                              <div className="tasks-table-title">
                                <strong>{t.title}</strong>
                                <span>{labelize(t.task_type || "general")}</span>
                              </div>
                            </td>
                            <td>{teamById.get(Number(t.assigned_user_id || t.assigned_to || 0))?.name || "Unassigned"}</td>
                            <td>
                              <div className="tasks-status-stack">
                                <span className={`vilo-badge vilo-badge--${t.status}`}>{labelize(t.status)}</span>
                                {t.is_overdue ? <span className="vilo-badge vilo-badge--overdue">Overdue</span> : null}
                              </div>
                            </td>
                            <td><span className={`vilo-badge vilo-badge--priority-${t.priority}`}>{labelize(t.priority)}</span></td>
                            <td>{fmtDateTime(t.due_date)}</td>
                            <td><Link href={`/dashboard/tasks/${t.id}`}>Open</Link></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <EmptyState text="No tasks linked to this case." />}
              </div>
            ) : null}

            {activeTab === "notes" ? (
              <div className="case-tab-panel">
                <div className="case-tab-headline-row">
                  <h2>Notes</h2>
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setModalType("add-note")}>Add Note</button>
                </div>
                {notes.length ? (
                  <div className="vilo-table-wrap case-table-wrap">
                    <table className="team-table">
                      <thead><tr><th>Note</th><th>Visibility</th><th>Created</th></tr></thead>
                      <tbody>
                        {notes.map((n) => (
                          <tr key={n.id}><td>{n.note}</td><td><span className={`vilo-badge ${n.visibility === "client_visible" ? "vilo-badge--active" : "vilo-badge--draft"}`}>{n.visibility}</span></td><td>{fmtDate(n.created_at)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <EmptyState text="No notes added for this case." />}
              </div>
            ) : null}
          </article>
        </>
      ) : null}

      {modalType === "filters" ? (
        <Modal title="Filters" onClose={() => setModalType("")}>
          <div className="vilo-form-grid">
            <select value={pendingFilters.event_type} onChange={(e) => setPendingFilters((p) => ({ ...p, event_type: e.target.value }))}>
              <option value="">All event types</option>
              {EVENT_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select value={pendingFilters.status} onChange={(e) => setPendingFilters((p) => ({ ...p, status: e.target.value }))}>
              <option value="">All statuses</option>
              {STATUS_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select value={pendingFilters.completed} onChange={(e) => setPendingFilters((p) => ({ ...p, completed: e.target.value }))}>
              <option value="">Any completion</option>
              <option value="true">Completed</option>
              <option value="false">Not completed</option>
            </select>
            <div className="vilo-form-row-two">
              <input type="date" value={pendingFilters.date_from} onChange={(e) => setPendingFilters((p) => ({ ...p, date_from: e.target.value }))} />
              <input type="date" value={pendingFilters.date_to} onChange={(e) => setPendingFilters((p) => ({ ...p, date_to: e.target.value }))} />
            </div>
            <div className="vilo-table-actions">
              <button className="vilo-btn vilo-btn--primary" type="button" onClick={async () => { setFilters(pendingFilters); setModalType(""); await loadTimeline(search, pendingFilters); }}>Apply</button>
              <button className="vilo-btn vilo-btn--secondary" type="button" onClick={async () => { const reset = { event_type: "", status: "", completed: "", date_from: "", date_to: "" }; setPendingFilters(reset); setFilters(reset); setModalType(""); await loadTimeline(search, reset); }}>Reset</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {modalType === "add" ? (
        <Modal title="Add Timeline Event" onClose={() => setModalType("")}>
          <form className="vilo-form-grid" onSubmit={createEvent}>
            <input placeholder="Title" value={eventForm.title} onChange={(e) => setEventForm((p) => ({ ...p, title: e.target.value }))} required />
            <select value={eventForm.event_type} onChange={(e) => setEventForm((p) => ({ ...p, event_type: e.target.value }))}>
              {EVENT_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <input type="date" value={eventForm.event_date} onChange={(e) => setEventForm((p) => ({ ...p, event_date: e.target.value }))} />
            <select value={eventForm.status} onChange={(e) => setEventForm((p) => ({ ...p, status: e.target.value }))}>
              {STATUS_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <label><input type="checkbox" checked={eventForm.completed} onChange={(e) => setEventForm((p) => ({ ...p, completed: e.target.checked }))} /> Completed</label>
            <textarea placeholder="Description" value={eventForm.description} onChange={(e) => setEventForm((p) => ({ ...p, description: e.target.value }))} />
            <button className="vilo-btn vilo-btn--primary" type="submit" disabled={submitting}>{submitting ? "Saving..." : "Create Event"}</button>
          </form>
        </Modal>
      ) : null}

      {modalType === "view" && selectedRow ? (
        <Modal title="View Timeline Event" onClose={() => setModalType("")}>
          <div className="vilo-form-grid">
            <p><strong>Title:</strong> {selectedRow.title}</p>
            <p><strong>Event Type:</strong> {selectedRow.eventType}</p>
            <p><strong>Event Date:</strong> {fmtDate(selectedRow.eventDate)}</p>
            <p><strong>Completed:</strong> {selectedRow.completed}</p>
            <p><strong>Status:</strong> {selectedRow.status}</p>
            <p><strong>Description:</strong> {selectedRow.description || "-"}</p>
          </div>
        </Modal>
      ) : null}

      {modalType === "edit" && selectedRow ? (
        <Modal title="Edit Timeline Event" onClose={() => setModalType("")}>
          <form className="vilo-form-grid" onSubmit={updateEvent}>
            <input placeholder="Title" value={eventForm.title} onChange={(e) => setEventForm((p) => ({ ...p, title: e.target.value }))} required />
            <select value={eventForm.event_type} onChange={(e) => setEventForm((p) => ({ ...p, event_type: e.target.value }))}>
              {EVENT_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <input type="date" value={eventForm.event_date} onChange={(e) => setEventForm((p) => ({ ...p, event_date: e.target.value }))} />
            <select value={eventForm.status} onChange={(e) => setEventForm((p) => ({ ...p, status: e.target.value }))}>
              {STATUS_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <label><input type="checkbox" checked={eventForm.completed} onChange={(e) => setEventForm((p) => ({ ...p, completed: e.target.checked }))} /> Completed</label>
            <textarea placeholder="Description" value={eventForm.description} onChange={(e) => setEventForm((p) => ({ ...p, description: e.target.value }))} />
            <button className="vilo-btn vilo-btn--primary" type="submit" disabled={submitting}>{submitting ? "Saving..." : "Update Event"}</button>
          </form>
        </Modal>
      ) : null}

      {modalType === "delete" && selectedRow ? (
        <Modal title="Delete Timeline Event" onClose={() => setModalType("")}>
          <p>Are you sure you want to delete <strong>{selectedRow.title}</strong>?</p>
          <div className="vilo-table-actions">
            <button className="vilo-btn vilo-btn--danger" type="button" onClick={deleteEvent} disabled={submitting}>{submitting ? "Deleting..." : "Delete"}</button>
            <button className="vilo-btn vilo-btn--secondary" type="button" onClick={() => setModalType("")}>Cancel</button>
          </div>
        </Modal>
      ) : null}

      {modalType === "lock" && selectedRow ? (
        <Modal title="Lock Timeline Event" onClose={() => setModalType("")}>
          <p>Lock <strong>{selectedRow.title}</strong>? This marks it as read-only in timeline metadata.</p>
          <div className="vilo-table-actions">
            <button className="vilo-btn vilo-btn--primary" type="button" onClick={lockEvent} disabled={submitting}>{submitting ? "Locking..." : "Lock"}</button>
            <button className="vilo-btn vilo-btn--secondary" type="button" onClick={() => setModalType("")}>Cancel</button>
          </div>
        </Modal>
      ) : null}

      {modalType === "add-note" ? (
        <Modal title="Add Note" onClose={() => setModalType("")}>
          <form className="vilo-form-grid" onSubmit={addCaseNote}>
            <textarea placeholder="Note" value={noteForm.note} onChange={(e) => setNoteForm((p) => ({ ...p, note: e.target.value }))} required />
            <select value={noteForm.visibility} onChange={(e) => setNoteForm((p) => ({ ...p, visibility: e.target.value }))}>
              <option value="internal">internal</option>
              <option value="client_visible">client_visible</option>
            </select>
            <button className="vilo-btn vilo-btn--primary" type="submit" disabled={submitting}>{submitting ? "Saving..." : "Create Note"}</button>
          </form>
        </Modal>
      ) : null}

      {modalType === "add-task" ? (
        <Modal title="Add Task" onClose={() => setModalType("")}>
          <form className="vilo-form-grid" onSubmit={addTask}>
            <input placeholder="Task title" value={taskForm.title} onChange={(e) => setTaskForm((p) => ({ ...p, title: e.target.value }))} required />
            <textarea placeholder="Description" value={taskForm.description} onChange={(e) => setTaskForm((p) => ({ ...p, description: e.target.value }))} />
            <div className="vilo-form-row-two">
              <select value={taskForm.status} onChange={(e) => setTaskForm((p) => ({ ...p, status: e.target.value }))}>
                <option value="pending">pending</option>
                <option value="in_progress">in_progress</option>
                <option value="completed">completed</option>
                <option value="cancelled">cancelled</option>
              </select>
              <select value={taskForm.priority} onChange={(e) => setTaskForm((p) => ({ ...p, priority: e.target.value }))}>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="urgent">urgent</option>
              </select>
            </div>
            <div className="vilo-form-row-two">
              <input type="date" value={taskForm.due_date} onChange={(e) => setTaskForm((p) => ({ ...p, due_date: e.target.value }))} />
              <select value={taskForm.assigned_to} onChange={(e) => setTaskForm((p) => ({ ...p, assigned_to: e.target.value }))}>
                <option value="">Unassigned</option>
                {team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <button className="vilo-btn vilo-btn--primary" type="submit" disabled={submitting}>{submitting ? "Saving..." : "Create Task"}</button>
          </form>
        </Modal>
      ) : null}

      {modalType === "add-document" ? (
        <Modal title="Upload Document" onClose={() => setModalType("")}>
          <form className="vilo-form-grid" onSubmit={uploadDocument}>
            <input placeholder="Title" value={docForm.title} onChange={(e) => setDocForm((p) => ({ ...p, title: e.target.value }))} required />
            <input placeholder="Category" value={docForm.category} onChange={(e) => setDocForm((p) => ({ ...p, category: e.target.value }))} />
            <textarea placeholder="Description" value={docForm.description} onChange={(e) => setDocForm((p) => ({ ...p, description: e.target.value }))} />
            <select value={docForm.visibility} onChange={(e) => setDocForm((p) => ({ ...p, visibility: e.target.value }))}>
              <option value="internal">internal</option>
              <option value="client_visible">client_visible</option>
            </select>
            <input type="file" onChange={(e) => setDocForm((p) => ({ ...p, file: e.target.files?.[0] || null }))} required />
            <button className="vilo-btn vilo-btn--primary" type="submit" disabled={submitting}>{submitting ? "Uploading..." : "Upload Document"}</button>
          </form>
        </Modal>
      ) : null}

      {modalType === "add-team" ? (
        <Modal title="Assign Team Member" onClose={() => setModalType("")}>
          <div className="vilo-form-grid">
            <select value={selectedAssigneeId} onChange={(e) => setSelectedAssigneeId(e.target.value)}>
              <option value="">Select team member</option>
              {team.filter((u) => !(item?.assigned_users || []).some((a) => a.id === u.id)).map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
              ))}
            </select>
            <button className="vilo-btn vilo-btn--primary" type="button" onClick={assignTeamMember} disabled={!selectedAssigneeId || submitting}>
              {submitting ? "Assigning..." : "Assign Team Member"}
            </button>
          </div>
        </Modal>
      ) : null}

      {modalType === "replace-document" && selectedDocument ? (
        <Modal title="Replace Document" onClose={() => { setModalType(""); setSelectedDocument(null); setReplaceFile(null); setReplaceNotes(""); }}>
          <form className="vilo-form-grid" onSubmit={replaceDocument}>
            <p><strong>Current file:</strong> {selectedDocument.file_name}</p>
            <input type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" onChange={(e) => setReplaceFile(e.target.files?.[0] || null)} required />
            <textarea placeholder="Version notes (optional)" value={replaceNotes} onChange={(e) => setReplaceNotes(e.target.value)} />
            <button className="vilo-btn vilo-btn--primary" type="submit" disabled={submitting}>{submitting ? "Replacing..." : "Replace Document"}</button>
          </form>
        </Modal>
      ) : null}

      {modalType === "document-versions" && selectedDocument ? (
        <Modal title="Version History" onClose={() => { setModalType(""); setSelectedDocument(null); }}>
          {!versionRows.length ? <p>No previous versions.</p> : null}
          {versionRows.length ? (
            <div className="vilo-table-wrap">
              <table className="team-table">
                <thead><tr><th>Version</th><th>File</th><th>Uploaded</th><th>Notes</th><th>Action</th></tr></thead>
                <tbody>
                  {versionRows.map((row) => (
                    <tr key={row.id}>
                      <td>v{row.version_number}</td>
                      <td>{row.file_name}</td>
                      <td>{new Date(row.created_at).toLocaleString()}</td>
                      <td>{row.notes || "-"}</td>
                      <td><button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => apiDownload(`/api/v1/documents/${selectedDocument.id}/versions/${row.id}/download`)}>Download</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </section>
  );
}
