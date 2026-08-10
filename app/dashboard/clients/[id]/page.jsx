"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { apiDownload, apiRequest, apiUpload } from "../../../../lib/api";
import ClientIntakeModal from "../../../../components/dashboard/ClientIntakeModal";
import ProtectedFilePreviewModal, { useProtectedFilePreview } from "../../../../components/ProtectedFilePreviewModal";
import OnlyOfficeDocumentModal from "../../../../components/OnlyOfficeDocumentModal";
import { getDocumentViewerType } from "../../../../lib/documentViewer";

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatMoney(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value || 0));
}

function paymentMethodLabel(row) {
  return row.payment_method_summary || "Unpaid";
}

function formatContactMethod(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "-";
  if (normalized === "sms") return "SMS";
  if (normalized === "whatsapp") return "WhatsApp";
  return normalized[0].toUpperCase() + normalized.slice(1);
}

function labelize(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function ClientDetailPage() {
  const { id } = useParams();
  const notesSectionRef = useRef(null);

  const [client, setClient] = useState(null);
  const [cases, setCases] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [idDocuments, setIdDocuments] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [team, setTeam] = useState([]);
  const [invoices, setInvoices] = useState([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editOpen, setEditOpen] = useState(false);
  const [selectedTeamIds, setSelectedTeamIds] = useState([]);
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");

  const [timelineTab, setTimelineTab] = useState("all");
  const [timelineDraft, setTimelineDraft] = useState("");
  const [timelineSearch, setTimelineSearch] = useState("");
  const [timelineType, setTimelineType] = useState("all");
  const [timelineOrder, setTimelineOrder] = useState("newest");

  const [documentDraft, setDocumentDraft] = useState("");
  const [documentSearch, setDocumentSearch] = useState("");
  const [documentOrder, setDocumentOrder] = useState("newest");
  const [deleteDocumentId, setDeleteDocumentId] = useState(null);
  const [replaceTarget, setReplaceTarget] = useState(null);
  const [replaceFile, setReplaceFile] = useState(null);
  const [replaceNotes, setReplaceNotes] = useState("");
  const [versionTarget, setVersionTarget] = useState(null);
  const [versionRows, setVersionRows] = useState([]);
  const [idUploadOpen, setIdUploadOpen] = useState(false);
  const [idUploadType, setIdUploadType] = useState("");
  const [idUploadFile, setIdUploadFile] = useState(null);
  const [canManageClientIds, setCanManageClientIds] = useState(false);
  const [onlyOfficeTarget, setOnlyOfficeTarget] = useState(null);
  const { preview, openPreview, closePreview } = useProtectedFilePreview();

  async function load() {
    setLoading(true);
    setError("");
    try {
      const clientData = await apiRequest(`/api/v1/clients/${id}`);
      setClient(clientData);
      setSelectedTeamIds(clientData.assigned_user_ids || []);

      const results = await Promise.allSettled([
        apiRequest("/api/v1/cases"),
        apiRequest(`/api/v1/clients/${id}/id-documents`),
        apiRequest(`/api/v1/tasks?client_id=${id}`),
        apiRequest("/api/v1/team"),
        apiRequest(`/api/v1/invoices?client_id=${id}`),
        apiRequest(`/api/v1/documents?client_id=${id}`),
      ]);

      setCases(results[0].status === "fulfilled" ? (results[0].value || []) : []);
      setIdDocuments(results[1].status === "fulfilled" ? (results[1].value || []) : []);
      setCanManageClientIds(results[1].status === "fulfilled");
      setTasks(results[2].status === "fulfilled" ? (results[2].value || []) : []);
      setTeam(results[3].status === "fulfilled" ? (results[3].value || []).filter((user) => user.role !== "client") : []);
      setInvoices(results[4].status === "fulfilled" ? (results[4].value || []) : []);
      setDocuments(results[5].status === "fulfilled" ? (results[5].value || []).filter((row) => row.category !== "client_id") : []);
    } catch (err) {
      setError(err.message || "Failed to load client details");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (id) load();
  }, [id]);

  async function handleEdit(payload, idFile) {
    if (!client) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await apiRequest(`/api/v1/clients/${client.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      if (idFile) {
        const formData = new FormData();
        formData.append("file", idFile);
        formData.append("id_type", "other");
        await apiUpload(`/api/v1/clients/${client.id}/id-documents`, formData);
      }
      setEditOpen(false);
      setSuccess("Client updated successfully.");
      await load();
    } catch (err) {
      setError(err.message || "Failed to update client");
    } finally {
      setSaving(false);
    }
  }

  async function saveAssignedTeam() {
    if (!client) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const updated = await apiRequest(`/api/v1/clients/${client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ assigned_user_ids: selectedTeamIds }),
      });
      setClient(updated);
      setSuccess("Assigned team updated.");
    } catch (err) {
      setError(err.message || "Failed to update assigned team");
    } finally {
      setSaving(false);
    }
  }

  async function saveNote() {
    if (!client || !noteDraft.trim()) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const nextNotes = [String(client.notes || "").trim(), noteDraft.trim()].filter(Boolean).join("\n");
      const updated = await apiRequest(`/api/v1/clients/${client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ notes: nextNotes }),
      });
      setClient(updated);
      setNoteDraft("");
      setNoteModalOpen(false);
      setSuccess("Client note added.");
    } catch (err) {
      setError(err.message || "Failed to save note");
    } finally {
      setSaving(false);
    }
  }

  const relatedCases = useMemo(
    () => cases.filter((row) => Number(row.client_id) === Number(id)),
    [cases, id],
  );

  const assignedUsers = useMemo(
    () => team.filter((user) => selectedTeamIds.includes(user.id)),
    [selectedTeamIds, team],
  );

  const teamById = useMemo(
    () => new Map(team.map((user) => [Number(user.id), user])),
    [team],
  );

  const casesById = useMemo(
    () => new Map(relatedCases.map((row) => [Number(row.id), row])),
    [relatedCases],
  );

  const relatedTasks = useMemo(
    () => tasks,
    [tasks],
  );

  const availableTeam = useMemo(
    () => team.filter((user) => !selectedTeamIds.includes(user.id)),
    [selectedTeamIds, team],
  );

  const overdueAmount = useMemo(
    () => invoices.filter((row) => (row.display_status || row.status) === "overdue").reduce((sum, row) => sum + Number(row.balance_due || 0), 0),
    [invoices],
  );

  const noteLines = useMemo(
    () => String(client?.notes || "").split("\n").map((line) => line.trim()).filter(Boolean),
    [client?.notes],
  );

  const timelineRows = useMemo(() => {
    const caseRows = relatedCases.map((row) => ({
      id: `case-${row.id}`,
      title: row.title || `Case #${row.id}`,
      priority: row.priority || "medium",
      filing_date: row.created_at,
      status: row.status || "active",
      type: "cases",
      href: `/dashboard/cases/${row.id}`,
    }));

    const taskRows = relatedTasks.map((row) => ({
      id: `task-${row.id}`,
      title: row.title || `Task #${row.id}`,
      priority: row.priority || "medium",
      filing_date: row.due_date || row.created_at,
      status: row.status || "pending",
      type: "tasks",
      href: `/dashboard/tasks/${row.id}`,
    }));

    const documentRows = documents.map((row) => ({
      id: `doc-${row.id}`,
      documentId: row.id,
      documentCategory: row.category,
      title: row.title || row.file_name || `Document #${row.id}`,
      fileName: row.file_name || row.title || `Document #${row.id}`,
      fileType: row.file_type,
      priority: "low",
      filing_date: row.updated_at || row.created_at,
      status: "active",
      type: "documents",
      href: "",
    }));

    const clientIdRows = idDocuments.map((row) => ({
      id: `client-id-${row.id}`,
      documentId: row.id,
      documentCategory: "client_id",
      title: `${labelize(row.client_id_type || "other").replace("Driver Licence", "Driver's License")} · ${row.file_name || row.title || `Document #${row.id}`}`,
      fileName: row.file_name || row.title || `Document #${row.id}`,
      fileType: row.file_type,
      priority: "low",
      filing_date: row.updated_at || row.created_at,
      status: "active",
      type: "client_ids",
      href: "",
    }));

    const notesRows = noteLines.map((line, index) => ({
      id: `note-${index}`,
      title: line,
      priority: "medium",
      filing_date: client?.updated_at || client?.created_at,
      status: "active",
      type: "notes",
      href: "",
    }));

    let rows = [...caseRows, ...taskRows, ...documentRows, ...clientIdRows, ...notesRows];

    if (timelineTab !== "all") rows = rows.filter((row) => row.type === timelineTab);
    if (timelineType !== "all") rows = rows.filter((row) => row.type === timelineType);

    if (timelineSearch.trim()) {
      const query = timelineSearch.toLowerCase();
      rows = rows.filter((row) => `${row.title} ${row.status} ${row.priority}`.toLowerCase().includes(query));
    }

    rows.sort((a, b) => {
      const left = new Date(a.filing_date || 0).getTime();
      const right = new Date(b.filing_date || 0).getTime();
      return timelineOrder === "oldest" ? left - right : right - left;
    });

    return rows.slice(0, 8);
  }, [client?.created_at, client?.updated_at, documents, idDocuments, noteLines, relatedCases, relatedTasks, timelineOrder, timelineSearch, timelineTab, timelineType]);

  const filteredIdDocuments = useMemo(() => {
    let rows = [...idDocuments];

    if (documentSearch.trim()) {
      const query = documentSearch.toLowerCase();
      rows = rows.filter((row) => `${row.title || ""} ${row.file_name || ""}`.toLowerCase().includes(query));
    }

    rows.sort((a, b) => {
      const left = new Date(a.created_at || 0).getTime();
      const right = new Date(b.created_at || 0).getTime();
      return documentOrder === "oldest" ? left - right : right - left;
    });

    return rows;
  }, [documentOrder, documentSearch, idDocuments]);

  async function removeIdDocument(documentId) {
    setSaving(true);
    setError("");
    try {
      await apiRequest(`/api/v1/clients/${id}/id-documents/${documentId}`, { method: "DELETE" });
      setDeleteDocumentId(null);
      await load();
    } catch (err) {
      setError(err.message || "Failed to delete document");
    } finally {
      setSaving(false);
    }
  }

  async function replaceIdDocument(e) {
    e.preventDefault();
    if (!replaceTarget || !replaceFile) {
      setError("Select a replacement file.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const formData = new FormData();
      formData.set("file", replaceFile);
      if (replaceNotes.trim()) formData.set("notes", replaceNotes.trim());
      await apiUpload(`/api/v1/documents/${replaceTarget.id}/replace`, formData);
      setReplaceTarget(null);
      setReplaceFile(null);
      setReplaceNotes("");
      setSuccess("Document replaced.");
      await load();
    } catch (err) {
      setError(err.message || "Failed to replace document");
    } finally {
      setSaving(false);
    }
  }

  async function openVersionHistory(row) {
    setVersionTarget(row);
    setVersionRows([]);
    setError("");
    try {
      const rows = await apiRequest(`/api/v1/documents/${row.id}/versions`);
      setVersionRows(rows || []);
    } catch (err) {
      setError(err.message || "Failed to load versions");
    }
  }

  function openDocumentPreview(row) {
    setError("");
    openClientDocument({
      id: row.id,
      filename: row.file_name || row.title || `Document #${row.id}`,
      mediaType: row.file_type,
      isClientId: true,
      document: row,
    });
  }

  function openTimelineDocument(row) {
    setError("");
    const source = row.documentCategory === "client_id"
      ? idDocuments.find((document) => Number(document.id) === Number(row.documentId))
      : documents.find((document) => Number(document.id) === Number(row.documentId));
    openClientDocument({
      id: row.documentId,
      filename: row.fileName || row.title,
      mediaType: row.fileType,
      isClientId: row.documentCategory === "client_id",
      document: source || { id: row.documentId, file_name: row.fileName, title: row.title, file_type: row.fileType },
    });
  }

  function openClientDocument({ id: documentId, filename, mediaType, isClientId, document }) {
    const downloadPath = isClientId
      ? `/api/v1/clients/${id}/id-documents/${documentId}/download`
      : `/api/v1/documents/${documentId}/download`;
    if (getDocumentViewerType({ filename, mediaType }) === "onlyoffice") {
      setOnlyOfficeTarget({ ...document, id: documentId, file_name: filename, downloadPath });
      return;
    }
    const path = isClientId
      ? `/api/v1/clients/${id}/id-documents/${documentId}/view`
      : `/api/v1/documents/${documentId}/view`;
    void openPreview({ path, downloadPath, filename });
  }

  async function uploadIdDocument(event) {
    event.preventDefault();
    if (!idUploadType || !idUploadFile) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const formData = new FormData();
      formData.append("id_type", idUploadType);
      formData.append("file", idUploadFile);
      await apiUpload(`/api/v1/clients/${id}/id-documents`, formData);
      setIdUploadOpen(false);
      setIdUploadType("");
      setIdUploadFile(null);
      setSuccess("Identification document uploaded.");
      await load();
    } catch (err) {
      setError(err.message || "Failed to upload identification document");
    } finally {
      setSaving(false);
    }
  }

  function toggleTeamMember(userId) {
    setSelectedTeamIds((current) => (
      current.includes(userId) ? current.filter((idValue) => idValue !== userId) : [...current, userId]
    ));
  }

  function openNoteModal() {
    setNoteDraft("");
    setNoteModalOpen(true);
  }

  function focusNotesSection() {
    notesSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    openNoteModal();
  }

  if (loading) {
    return <section className="dashboard-page-stack"><p className="vilo-state vilo-state--loading">Loading client details...</p></section>;
  }

  if (error && !client) {
    return <section className="dashboard-page-stack"><p className="vilo-state vilo-state--error">{error}</p></section>;
  }

  const type = client?.client_type === "corporate" ? "Corporate" : "Individual";
  const statusLabel = client?.archived_at ? "Archived" : "Active";

  return (
    <section className="dashboard-page-stack client-detail-page">
      <div className="client-detail-top-row">
        <div className="client-detail-heading">
          <h1>Client Details</h1>
          <p><Link href="/dashboard/clients">Clients</Link> &gt; Client Info</p>
          <div className="client-identity-header">
            <div className="client-avatar">{(client?.name || "C").slice(0, 1).toUpperCase()}</div>
            <div className="client-identity-main-copy">
              <h2>{client?.name || "Client"}</h2>
              <p>CL-{String(client?.id || "").padStart(4, "0")} · {type} · {statusLabel}</p>
            </div>
          </div>
        </div>
        <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setEditOpen(true)}>
          Edit
        </button>
      </div>

      {error ? <p className="vilo-state vilo-state--error">{error}</p> : null}
      {success ? <p className="vilo-state">{success}</p> : null}

      <div className="client-detail-grid">
        <div className="client-detail-left">
          <article className="dashboard-card clients-list-card">
            <div className="dashboard-card__header"><h2>Client Timeline</h2></div>
            <div className="clients-tabs-row">
              {[
                ["all", "All"],
                ["notes", "Notes"],
                ["messages", "Messages"],
                ["documents", "Documents"],
                ["client_ids", "Client IDs"],
                ["cases", "Cases"],
                ["tasks", "Tasks"],
              ].map(([key, label]) => (
                <button key={key} type="button" className={timelineTab === key ? "case-tab-btn is-active" : "case-tab-btn"} onClick={() => { setTimelineTab(key); setTimelineType("all"); }}>{label}</button>
              ))}
            </div>

            {timelineTab === "client_ids" ? (
              <div className="case-tab-panel client-ids-panel" style={{ paddingTop: "0.75rem" }}>
                <div className="dashboard-card__header dashboard-card__header--action client-ids-header">
                  <div>
                    <h3>Client Identification</h3>
                    <p className="vilo-card-copy">{idDocuments.length} {idDocuments.length === 1 ? "ID" : "IDs"} on file</p>
                  </div>
                  {canManageClientIds ? (
                    <button className="vilo-btn vilo-btn--primary vilo-btn--xs" type="button" onClick={() => setIdUploadOpen(true)}>Add ID</button>
                  ) : null}
                </div>

                {canManageClientIds ? (
                  <>
                    <div className="clients-toolbar-row client-detail-toolbar-row client-ids-toolbar">
                      <input className="case-search-input" placeholder="Search IDs" value={documentDraft} onChange={(e) => setDocumentDraft(e.target.value)} />
                      <button className="vilo-btn vilo-btn--primary" type="button" onClick={() => setDocumentSearch(documentDraft)}>Search</button>
                      <div className="clients-select-wrap clients-select-wrap--full">
                        <select value={documentOrder} onChange={(e) => setDocumentOrder(e.target.value)}>
                          <option value="newest">Last Modified</option>
                          <option value="oldest">Oldest First</option>
                        </select>
                      </div>
                    </div>

                    {filteredIdDocuments.length ? (
                      <div className="vilo-table-wrap case-table-wrap client-id-table-wrap">
                        <table className="team-table client-id-table">
                          <thead><tr><th>ID Type</th><th>Filename</th><th>Size</th><th>Last Modified</th><th>Actions</th></tr></thead>
                          <tbody>
                            {filteredIdDocuments.map((row) => (
                              <tr key={row.id}>
                                <td>{labelize(row.client_id_type || "other").replace("Driver Licence", "Driver's License")}</td>
                                <td>{row.file_name || row.title || `Document #${row.id}`}</td>
                                <td>{row.file_size ? `${Math.ceil(row.file_size / 1024)} KB` : "-"}</td>
                                <td>{formatDate(row.updated_at || row.created_at)}</td>
                                <td className="client-id-actions-cell">
                                  <div className="vilo-table-actions client-id-actions">
                                    <button className="vilo-btn vilo-btn--secondary vilo-btn--xs" type="button" onClick={() => openDocumentPreview(row)}>View</button>
                                    <button className="vilo-btn vilo-btn--ghost vilo-btn--xs" type="button" onClick={() => apiDownload(`/api/v1/clients/${id}/id-documents/${row.id}/download`).catch((err) => setError(err.message || "Download failed"))}>Download</button>
                                    <button className="vilo-btn vilo-btn--ghost vilo-btn--xs" type="button" onClick={() => setReplaceTarget(row)}>Edit / Replace</button>
                                    <button className="vilo-btn vilo-btn--ghost vilo-btn--xs" type="button" onClick={() => openVersionHistory(row)}>Versions</button>
                                    <button className="vilo-btn vilo-btn--danger vilo-btn--xs" type="button" onClick={() => setDeleteDocumentId(row.id)}>Delete</button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : idDocuments.length === 0 ? (
                      <div className="vilo-state-block">
                        <p className="vilo-state">No identification documents have been uploaded for this client.</p>
                        <button className="vilo-btn vilo-btn--primary vilo-btn--xs" type="button" onClick={() => setIdUploadOpen(true)}>Add ID</button>
                      </div>
                    ) : (
                      <div className="vilo-state-block"><p className="vilo-state">No identification documents matched this search.</p></div>
                    )}
                  </>
                ) : (
                  <div className="vilo-state-block"><p className="vilo-state">Client identification documents are unavailable for your account.</p></div>
                )}
              </div>
            ) : (
              <>
            <div className="clients-toolbar-row client-detail-toolbar-row">
              <input className="case-search-input" placeholder="Search" value={timelineDraft} onChange={(e) => setTimelineDraft(e.target.value)} />
              <button className="vilo-btn vilo-btn--primary" type="button" onClick={() => setTimelineSearch(timelineDraft)}>Search</button>
              <div className="clients-select-wrap">
                <select value={timelineType} onChange={(e) => setTimelineType(e.target.value)}>
                  <option value="all">Type</option>
                  <option value="cases">Cases</option>
                  <option value="tasks">Tasks</option>
                  <option value="documents">Documents</option>
                  <option value="client_ids">Client IDs</option>
                  <option value="messages">Messages</option>
                  <option value="notes">Notes</option>
                </select>
              </div>
              <div className="clients-select-wrap">
                <select value={timelineOrder} onChange={(e) => setTimelineOrder(e.target.value)}>
                  <option value="newest">Last Modified</option>
                  <option value="oldest">Oldest First</option>
                </select>
              </div>
            </div>

            <div className="case-tab-panel" style={{ paddingTop: "0.5rem" }}>
              {timelineRows.length ? (
                <div className="vilo-table-wrap case-table-wrap">
                  <table className="team-table">
                    <thead>
                      <tr><th>Timeline</th><th>Priority</th><th>Filing Date</th><th>Status</th><th>Actions</th></tr>
                    </thead>
                    <tbody>
                      {timelineRows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.title}</td>
                          <td><span className={`vilo-badge vilo-badge--priority-${row.priority}`}>{row.priority}</span></td>
                          <td>{formatDate(row.filing_date)}</td>
                          <td><span className={`vilo-badge vilo-badge--${row.status}`}>{row.status}</span></td>
                          <td>
                            {row.documentId ? <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => openTimelineDocument(row)}>View</button> : row.href ? <Link href={row.href}>View</Link> : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="vilo-state-block"><p className="vilo-state">No timeline data available for this filter.</p></div>
              )}
              <Link href="/dashboard/cases" className="client-view-all-link">View All Cases →</Link>
            </div>
              </>
            )}
          </article>

          <article className="dashboard-card client-billing-card">
            <div className="dashboard-card__header dashboard-card__header--action client-section-header">
              <h2>Invoices &amp; Billing</h2>
              <Link href={`/dashboard/invoices?create=1&client_id=${id}`} className="vilo-btn vilo-btn--primary vilo-btn--xs">
                Create Invoice
              </Link>
            </div>
            <div className="client-billing-summary">
              <div className="client-billing-metric">
                <span>Overdue Balance</span>
                <strong>{formatMoney(overdueAmount)}</strong>
              </div>
              <div className="client-billing-metric">
                <span>Invoices</span>
                <strong>{invoices.length}</strong>
              </div>
            </div>
            {invoices.length ? (
              <div className="vilo-table-wrap case-table-wrap">
                <table className="team-table">
                  <thead><tr><th>Invoice</th><th>Status</th><th>Payment</th><th>Amount</th><th>Due</th><th>Action</th></tr></thead>
                  <tbody>
                    {invoices.slice(0, 6).map((row) => (
                      <tr key={row.id}>
                        <td>{row.invoice_number}</td>
                        <td><span className={`vilo-badge vilo-badge--${row.display_status || row.status}`}>{row.display_status || row.status}</span></td>
                        <td>{paymentMethodLabel(row)}</td>
                        <td>{formatMoney(row.total, row.currency || "USD")}</td>
                        <td>{formatDate(row.due_date)}</td>
                        <td><Link href={`/dashboard/invoices/${row.id}`}>View</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="vilo-card-copy">No invoices yet for this client.</p>
            )}
          </article>

          <article className="dashboard-card clients-list-card">
            <div className="dashboard-card__header dashboard-card__header--action client-section-header">
              <h2>Tasks</h2>
              <Link href={`/dashboard/tasks?create=1&client_id=${id}`} className="vilo-btn vilo-btn--primary vilo-btn--xs">
                Add Task
              </Link>
            </div>
            {tasks.length ? (
              <div className="vilo-table-wrap case-table-wrap">
                <table className="team-table">
                  <thead><tr><th>Title</th><th>Linked Case</th><th>Assigned</th><th>Status</th><th>Priority</th><th>Due</th><th>Action</th></tr></thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr key={task.id} className={`tasks-table-row${task.status === "completed" ? " is-completed" : ""}${task.is_overdue ? " is-overdue" : ""}`}>
                        <td>
                          <div className="tasks-table-title">
                            <strong>{task.title}</strong>
                            <span>{labelize(task.task_type || "general")}</span>
                          </div>
                        </td>
                        <td>{task.case_id ? casesById.get(Number(task.case_id))?.title || `Case #${task.case_id}` : "No case linked"}</td>
                        <td>{teamById.get(Number(task.assigned_user_id || task.assigned_to || 0))?.name || "Unassigned"}</td>
                        <td>
                          <div className="tasks-status-stack">
                            <span className={`vilo-badge vilo-badge--${task.status}`}>{labelize(task.status)}</span>
                            {task.is_overdue ? <span className="vilo-badge vilo-badge--overdue">Overdue</span> : null}
                          </div>
                        </td>
                        <td><span className={`vilo-badge vilo-badge--priority-${task.priority}`}>{labelize(task.priority)}</span></td>
                        <td>{formatDate(task.due_date)}</td>
                        <td><Link href={`/dashboard/tasks/${task.id}`}>Open</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="vilo-card-copy">No tasks linked to this client yet.</p>
            )}
          </article>

          <article ref={notesSectionRef} className="dashboard-card">
            <div className="dashboard-card__header dashboard-card__header--action client-section-header">
              <h2>Notes</h2>
              <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={openNoteModal}>
                Add Note
              </button>
            </div>
            {noteLines.length ? (
              <div className="client-notes-list">
                {noteLines.map((line, index) => (
                  <div key={`${line}-${index}`} className="client-note-row">{line}</div>
                ))}
              </div>
            ) : (
              <p className="vilo-card-copy">No notes saved for this client yet.</p>
            )}
          </article>

        </div>

        <aside className="client-detail-right">
          <article className="dashboard-card">
            <div className="dashboard-card__header"><h2>Client Overview</h2></div>
            <div className="client-overview-inner">
              <div className="client-overview-avatar">{(client?.name || "C").slice(0, 1).toUpperCase()}</div>
              <div className="client-overview-row"><span>TRN No:</span><strong>{client?.trn_no || "-"}</strong></div>
              <div className="client-overview-row"><span>Status:</span><span className={`vilo-badge ${client?.archived_at ? "vilo-badge--archived" : "vilo-badge--active"}`}>{statusLabel}</span></div>
              <div className="client-overview-row"><span>Type:</span><span className="vilo-badge vilo-badge--priority-medium">{type}</span></div>
              {type === "Individual" ? <div className="client-overview-row"><span>Occupation:</span><strong>{client?.occupation || "-"}</strong></div> : null}
              <div className="client-overview-row"><span>Preferred Contact:</span><strong>{formatContactMethod(client?.preferred_contact_method)}</strong></div>
              <div className="client-overview-row"><span>Billing Currency:</span><strong>{client?.billing_currency || "JMD"}</strong></div>
              <div className="client-overview-row"><span>Date of Birth:</span><strong>{formatDate(client?.date_of_birth)}</strong></div>
              <div className="client-overview-row"><span>Email:</span><strong>{client?.email || "-"}</strong></div>
              <div className="client-overview-row"><span>Phone:</span><strong>{client?.phone || "-"}</strong></div>
              <div className="client-overview-row"><span>Created:</span><strong>{formatDate(client?.created_at)}</strong></div>
            </div>
          </article>

          <article className="dashboard-card">
            <div className="dashboard-card__header"><h2>Team Members</h2></div>
            <div className="client-team-panel">
              <div className="client-team-controls">
                <select value="" onChange={(e) => { if (!e.target.value) return; toggleTeamMember(Number(e.target.value)); }}>
                  <option value="">Assign team member</option>
                  {availableTeam.map((member) => (
                    <option key={member.id} value={member.id}>{member.name} ({member.role})</option>
                  ))}
                </select>
                <button type="button" className="vilo-btn vilo-btn--primary vilo-btn--xs" onClick={saveAssignedTeam} disabled={saving}>
                  {saving ? "Saving..." : "Save Team"}
                </button>
              </div>

              <div className="case-assigned-list">
                {assignedUsers.length ? assignedUsers.map((member) => (
                  <span key={member.id} className="case-assigned-pill">
                    {member.name} ({member.role})
                    <button type="button" onClick={() => toggleTeamMember(member.id)} aria-label={`Remove ${member.name}`}>×</button>
                  </span>
                )) : <span className="case-assigned-empty">No team members selected.</span>}
              </div>

              {assignedUsers.length ? (
                <div className="client-team-list">
                  {assignedUsers.map((member) => (
                    <div key={member.id} className="client-team-row">
                      <div>
                        <strong>{member.name}</strong>
                        <span>{member.role} · {member.email}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

            </div>
          </article>

          <article className="dashboard-card">
            <div className="dashboard-card__header"><h2>Quick Actions</h2></div>
            <div className="client-quick-actions">
              <Link className="vilo-btn vilo-btn--secondary" href={`/dashboard/invoices?create=1&client_id=${id}`}>Create Invoice</Link>
              <Link className="vilo-btn vilo-btn--secondary" href={`/dashboard/tasks?create=1&client_id=${id}`}>Add Task</Link>
              <Link className="vilo-btn vilo-btn--secondary" href={`/dashboard/messages?create=1&client_id=${id}`}>Send Message</Link>
              <Link className="vilo-btn vilo-btn--secondary" href={`/dashboard/documents?upload=1&client_id=${id}`}>Upload Document</Link>
              <button type="button" className="vilo-btn vilo-btn--secondary" onClick={focusNotesSection}>Add Note</button>
            </div>
          </article>
        </aside>
      </div>

      <ClientIntakeModal
        open={editOpen}
        mode="edit"
        client={client}
        saving={saving}
        apiError={error}
        showIdUpload={false}
        onClose={() => setEditOpen(false)}
        onSubmit={handleEdit}
      />

      {noteModalOpen ? (
        <div className="vilo-modal-overlay" onClick={() => setNoteModalOpen(false)}>
          <div className="vilo-modal" onClick={(e) => e.stopPropagation()}>
            <div className="vilo-modal__header">
              <h3>Add Note</h3>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setNoteModalOpen(false)}>Close</button>
            </div>
            <div className="vilo-modal__body">
              <div className="vilo-form-grid">
                <textarea placeholder="Add a client note" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} />
                <div className="vilo-table-actions">
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setNoteModalOpen(false)}>Cancel</button>
                  <button type="button" className="vilo-btn vilo-btn--primary" onClick={saveNote} disabled={saving || !noteDraft.trim()}>
                    {saving ? "Saving..." : "Save Note"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {deleteDocumentId ? (
        <div className="vilo-modal-overlay" onClick={() => setDeleteDocumentId(null)}>
          <div className="vilo-modal" onClick={(e) => e.stopPropagation()}>
            <div className="vilo-modal__header">
              <h3>Delete ID Document</h3>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setDeleteDocumentId(null)}>Close</button>
            </div>
            <div className="vilo-modal__body">
              <p>Delete this ID document? This cannot be undone.</p>
              <div className="vilo-table-actions">
                <button type="button" className="vilo-btn vilo-btn--danger" disabled={saving} onClick={() => removeIdDocument(deleteDocumentId)}>
                  {saving ? "Deleting..." : "Delete"}
                </button>
                <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setDeleteDocumentId(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {idUploadOpen ? (
        <div className="vilo-modal-overlay" onClick={() => setIdUploadOpen(false)}>
          <div className="vilo-modal" onClick={(e) => e.stopPropagation()}>
            <div className="vilo-modal__header">
              <h3>Add Client ID</h3>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setIdUploadOpen(false)}>Close</button>
            </div>
            <div className="vilo-modal__body">
              <form className="vilo-form-grid" onSubmit={uploadIdDocument}>
                <div>
                  <label>ID Type</label>
                  <select value={idUploadType} onChange={(event) => setIdUploadType(event.target.value)} required>
                    <option value="">Select ID type</option>
                    <option value="national_id">National ID</option>
                    <option value="trn">TRN</option>
                    <option value="passport">Passport</option>
                    <option value="driver_licence">Driver's License</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div>
                  <label>File</label>
                  <input type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" onChange={(event) => setIdUploadFile(event.target.files?.[0] || null)} required />
                </div>
                <div className="vilo-table-actions">
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setIdUploadOpen(false)}>Cancel</button>
                  <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving || !idUploadType || !idUploadFile}>{saving ? "Uploading..." : "Upload ID"}</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}

      {replaceTarget ? (
        <div className="vilo-modal-overlay" onClick={() => { setReplaceTarget(null); setReplaceFile(null); setReplaceNotes(""); }}>
          <div className="vilo-modal" onClick={(e) => e.stopPropagation()}>
            <div className="vilo-modal__header">
              <h3>Replace Document</h3>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => { setReplaceTarget(null); setReplaceFile(null); setReplaceNotes(""); }}>Close</button>
            </div>
            <div className="vilo-modal__body">
              <form className="vilo-form-grid" onSubmit={replaceIdDocument}>
                <p>Current file: <strong>{replaceTarget.file_name}</strong></p>
                <input type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" onChange={(e) => setReplaceFile(e.target.files?.[0] || null)} required />
                <textarea placeholder="Version notes (optional)" value={replaceNotes} onChange={(e) => setReplaceNotes(e.target.value)} />
                <div className="vilo-table-actions">
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => { setReplaceTarget(null); setReplaceFile(null); setReplaceNotes(""); }}>Cancel</button>
                  <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving}>{saving ? "Replacing..." : "Replace Document"}</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}

      {versionTarget ? (
        <div className="vilo-modal-overlay" onClick={() => setVersionTarget(null)}>
          <div className="vilo-modal" onClick={(e) => e.stopPropagation()}>
            <div className="vilo-modal__header">
              <h3>Version History</h3>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setVersionTarget(null)}>Close</button>
            </div>
            <div className="vilo-modal__body">
              {!versionRows.length ? <p className="vilo-state">No previous versions.</p> : null}
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
                          <td><button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => apiDownload(`/api/v1/documents/${versionTarget.id}/versions/${row.id}/download`)}>Download</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <ProtectedFilePreviewModal preview={preview} onClose={closePreview} />
      {onlyOfficeTarget ? (
        <OnlyOfficeDocumentModal
          document={onlyOfficeTarget}
          mode="view"
          downloadPath={onlyOfficeTarget.downloadPath}
          onClose={() => setOnlyOfficeTarget(null)}
        />
      ) : null}
    </section>
  );
}
