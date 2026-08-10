"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiDownload, apiRequest, apiUpload } from "../../../lib/api";
import { getCachedUser } from "../../../lib/auth";
import { DiscardChangesDialog, useModalCloseGuard } from "../../../components/useModalCloseGuard";
import ProtectedFilePreviewModal, { useProtectedFilePreview } from "../../../components/ProtectedFilePreviewModal";
import OnlyOfficeDocumentModal from "../../../components/OnlyOfficeDocumentModal";
import { getDocumentViewerType } from "../../../lib/documentViewer";

const initialForm = {
  client_id: "",
  case_id: "",
  title: "",
  description: "",
  category: "",
  file: null,
};

const CATEGORY_OPTIONS = [
  { value: "", label: "Select Category" },
  { value: "case_files", label: "Case Files" },
  { value: "client_records", label: "Client Records" },
  { value: "templates", label: "Templates" },
  { value: "archive", label: "Archive" },
  { value: "general", label: "General" },
];

const FOLDER_ITEMS = [
  { key: "all", label: "Folders" },
  { key: "case_files", label: "Case Files" },
  { key: "client_records", label: "Client Records" },
  { key: "templates", label: "Templates" },
  { key: "archive", label: "Archive" },
];

export default function DocumentsPage() {
  return (
    <Suspense fallback={<section className="dashboard-page-stack"><div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading documents...</p></div></section>}>
      <DocumentsPageContent />
    </Suspense>
  );
}

function DocumentsPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const titleInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const [documents, setDocuments] = useState([]);
  const [cases, setCases] = useState([]);
  const [clients, setClients] = useState([]);
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState(null);
  const [replaceFile, setReplaceFile] = useState(null);
  const [replaceNotes, setReplaceNotes] = useState("");
  const [editTarget, setEditTarget] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [editInitialContent, setEditInitialContent] = useState("");
  const [editVersionNote, setEditVersionNote] = useState("");
  const [editWarning, setEditWarning] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [onlyOfficeTarget, setOnlyOfficeTarget] = useState(null);
  const [versionTarget, setVersionTarget] = useState(null);
  const [versions, setVersions] = useState([]);
  const [success, setSuccess] = useState("");
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [draftSearch, setDraftSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [activeFolder, setActiveFolder] = useState("all");
  const [sortBy, setSortBy] = useState("case");
  const [perPage, setPerPage] = useState(10);
  const [page, setPage] = useState(1);
  const [dragActive, setDragActive] = useState(false);
  const [folderNotice, setFolderNotice] = useState("");
  const [filterCase, setFilterCase] = useState("");
  const [filterClient, setFilterClient] = useState("");
  const [filterUploader, setFilterUploader] = useState("");
  const [filterVisibility, setFilterVisibility] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [uploaders, setUploaders] = useState([]);
  const { preview, openPreview, closePreview } = useProtectedFilePreview();
  const [serverTotal, setServerTotal] = useState(0);
  const [serverTotalPages, setServerTotalPages] = useState(1);
  const uploadOpen = searchParams.get("upload") === "1";
  const requestedClientId = searchParams.get("client_id") || "";
  const requestedDocumentId = searchParams.get("document_id") || "";
  const currentUser = useMemo(() => getCachedUser(), []);
  const uploadDirty = uploadOpen && (
    form.title !== initialForm.title ||
    form.description !== initialForm.description ||
    form.category !== initialForm.category ||
    form.case_id !== initialForm.case_id ||
    Boolean(form.file) ||
    (requestedClientId ? form.client_id !== requestedClientId : form.client_id !== initialForm.client_id)
  );
  const uploadCloseGuard = useModalCloseGuard({ open: uploadOpen, isDirty: uploadDirty, isSubmitting: saving, onClose: closeUploadModal });
  const replaceDirty = Boolean(replaceTarget) && (Boolean(replaceFile) || Boolean(replaceNotes.trim()));
  const replaceCloseGuard = useModalCloseGuard({ open: Boolean(replaceTarget), isDirty: replaceDirty, isSubmitting: saving, onClose: closeReplaceModal });
  const editDirty = Boolean(editTarget) && (editContent !== editInitialContent || Boolean(editVersionNote.trim()));
  const editCloseGuard = useModalCloseGuard({ open: Boolean(editTarget), isDirty: editDirty, isSubmitting: saving || editLoading, onClose: closeEditModal });

  async function load() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(page), per_page: String(perPage), sort_by: sortBy });
      if (searchQuery.trim()) params.set("search", searchQuery.trim());
      if (activeFolder !== "all") params.set("category", activeFolder);
      if (activeTab === "mine" && currentUser?.id) params.set("uploaded_by", String(currentUser.id));
      if (filterCase) params.set("case_id", filterCase);
      if (filterClient) params.set("client_id", filterClient);
      if (filterUploader) params.set("uploaded_by", filterUploader);
      if (filterVisibility) params.set("visibility", filterVisibility);
      if (filterType) params.set("file_type", filterType);
      if (filterFrom) params.set("created_from", filterFrom);
      if (filterTo) params.set("created_to", filterTo);
      if (requestedDocumentId) params.set("document_id", requestedDocumentId);
      const [docs, caseData, clientData, teamData] = await Promise.all([
        apiRequest(`/api/v1/documents/query?${params.toString()}`),
        apiRequest("/api/v1/cases"),
        apiRequest("/api/v1/clients"),
        apiRequest("/api/v1/team"),
      ]);
      setDocuments(docs.items || []);
      setServerTotal(docs.total || 0);
      setServerTotalPages(docs.total_pages || 1);
      setVersionTarget((current) => {
        if (!current) return current;
        return (docs.items || []).find((row) => Number(row.id) === Number(current.id)) || current;
      });
      setCases(caseData || []);
      setClients(clientData || []);
      setUploaders((teamData || []).filter((member) => member.role !== "client"));
    } catch (err) {
      setError(err.message || "Failed to load documents");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [activeFolder, activeTab, filterCase, filterClient, filterFrom, filterTo, filterType, filterUploader, filterVisibility, page, perPage, requestedDocumentId, searchQuery, sortBy]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(draftSearch), 300);
    return () => window.clearTimeout(timer);
  }, [draftSearch]);

  useEffect(() => {
    if (!uploadOpen) return;
    setForm((current) => {
      if (current.client_id === requestedClientId) return current;
      return { ...current, client_id: requestedClientId, case_id: "" };
    });
    const timer = window.setTimeout(() => titleInputRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [requestedClientId, uploadOpen]);

  useEffect(() => {
    setMenuOpenId(null);
  }, [page, perPage, searchQuery, activeFolder, activeTab, sortBy]);

  useEffect(() => {
    function handlePointerDown(event) {
      if (!menuOpenId) return;
      if (event.target instanceof Element && event.target.closest(".case-row-actions")) return;
      setMenuOpenId(null);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpenId]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, activeFolder, activeTab, sortBy, perPage, filterCase, filterClient, filterFrom, filterTo, filterType, filterUploader, filterVisibility]);

  useEffect(() => {
    function handleKeydown(event) {
      if (event.key !== "Escape") return;
      if (menuOpenId) {
        setMenuOpenId(null);
        return;
      }
      if (versionTarget) {
        setVersionTarget(null);
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [editTarget, menuOpenId, replaceTarget, versionTarget, uploadOpen]);

  const casesById = useMemo(() => {
    return new Map(cases.map((row) => [Number(row.id), row]));
  }, [cases]);

  const caseOptions = useMemo(() => {
    if (!form.client_id) return cases;
    return cases.filter((row) => Number(row.client_id) === Number(form.client_id));
  }, [cases, form.client_id]);

  const categoryOptions = useMemo(() => {
    const seen = new Set(CATEGORY_OPTIONS.map((option) => option.value).filter(Boolean));
    const extras = [];

    documents.forEach((document) => {
      const value = String(document.category || "").trim();
      if (!value) return;
      if (seen.has(value)) return;
      seen.add(value);
      extras.push({ value, label: toTitleCase(value) });
    });

    return [...CATEGORY_OPTIONS, ...extras];
  }, [documents]);

  const filteredDocuments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return documents.filter((document) => {
      if (activeTab === "mine" && currentUser?.id && Number(document.uploaded_by) !== Number(currentUser.id)) {
        return false;
      }

      if (activeFolder !== "all" && !matchesFolder(document, activeFolder)) {
        return false;
      }

      if (!query) return true;

      const caseTitle = document.case_id ? casesById.get(Number(document.case_id))?.title || "" : "";
      const haystack = [
        document.title,
        document.file_name,
        document.category,
        document.description,
        caseTitle,
        document.case_id ? `case ${document.case_id}` : "",
        document.client_id ? `client ${document.client_id}` : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [activeFolder, activeTab, casesById, currentUser?.id, documents, searchQuery]);

  const sortedDocuments = useMemo(() => {
    const rows = [...filteredDocuments];

    rows.sort((a, b) => {
      if (sortBy === "name") {
        return String(a.title || a.file_name || "").localeCompare(String(b.title || b.file_name || ""));
      }

      if (sortBy === "size") {
        return Number(b.file_size || 0) - Number(a.file_size || 0);
      }

      if (sortBy === "updated") {
        return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
      }

      const caseA = a.case_id ? casesById.get(Number(a.case_id))?.title || `Case #${a.case_id}` : a.category || "Unassigned";
      const caseB = b.case_id ? casesById.get(Number(b.case_id))?.title || `Case #${b.case_id}` : b.category || "Unassigned";
      return caseA.localeCompare(caseB);
    });

    return rows;
  }, [casesById, filteredDocuments, sortBy]);

  const totalPages = serverTotalPages;
  const pageRows = sortedDocuments;

  useEffect(() => {
    if (page <= totalPages) return;
    setPage(totalPages);
  }, [page, totalPages]);

  async function uploadDocument(event) {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (!form.title.trim()) {
      setError("Document name is required.");
      return;
    }

    if (!form.file) {
      setError("Please select a file to upload.");
      return;
    }

    setSaving(true);

    try {
      const formData = new FormData();
      formData.append("title", form.title.trim());
      if (form.description.trim()) formData.append("description", form.description.trim());
      if (form.category) formData.append("category", form.category);
      if (form.client_id) formData.append("client_id", form.client_id);
      if (form.case_id) formData.append("case_id", form.case_id);
      formData.append("file", form.file);

      await apiUpload("/api/v1/documents/upload", formData);
      setForm(initialForm);
      setDragActive(false);
      closeUploadModal();
      setSuccess("Document uploaded successfully.");
      await load();
    } catch (err) {
      setError(err.message || "Upload failed");
    } finally {
      setSaving(false);
    }
  }

  async function replaceDocument(event) {
    event.preventDefault();
    if (!replaceTarget || !replaceFile) {
      setError("Select a replacement file.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", replaceFile);
      if (replaceNotes.trim()) formData.append("notes", replaceNotes.trim());
      await apiUpload(`/api/v1/documents/${replaceTarget.id}/replace`, formData);
      setReplaceTarget(null);
      setReplaceFile(null);
      setReplaceNotes("");
      setSuccess("Document replaced successfully.");
      await load();
    } catch (err) {
      setError(err.message || "Replace failed");
    } finally {
      setSaving(false);
    }
  }

  async function openVersions(document) {
    setVersionTarget(document);
    setVersions([]);
    setMenuOpenId(null);
    setError("");

    try {
      const rows = await apiRequest(`/api/v1/documents/${document.id}/versions`);
      setVersions(rows || []);
    } catch (err) {
      setError(err.message || "Failed to load versions");
    }
  }

  async function openEditModal(document) {
    setEditTarget(document);
    setEditContent("");
    setEditInitialContent("");
    setEditVersionNote("");
    setEditWarning("");
    setEditLoading(true);
    setMenuOpenId(null);
    setError("");
    setSuccess("");

    try {
      const response = await apiRequest(`/api/v1/documents/${document.id}/editable-content`);
      if (!response.editable) {
        setEditTarget(null);
        setError(response.reason || "This document cannot be edited in the DOCX workflow.");
        return;
      }
      setEditContent(response.content || "");
      setEditInitialContent(response.content || "");
      setEditWarning(response.warning || "");
    } catch (err) {
      setEditTarget(null);
      setError(err.message || "Failed to load editable content");
    } finally {
      setEditLoading(false);
    }
  }

  async function openOnlyOfficeModal(document) {
    setOnlyOfficeTarget(document);
    setMenuOpenId(null);
    setError("");
    setSuccess("");
  }

  function closeEditModal() {
    setEditTarget(null);
    setEditContent("");
    setEditInitialContent("");
    setEditVersionNote("");
    setEditWarning("");
    setEditLoading(false);
  }

  async function closeOnlyOfficeModal() {
    setOnlyOfficeTarget(null);
    try {
      await load();
    } catch {
      // load() already updates the shared error state.
    }
  }

  async function saveEditedContent(event) {
    event.preventDefault();
    if (!editTarget) return;

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      await apiRequest(`/api/v1/documents/${editTarget.id}/editable-content`, {
        method: "POST",
        body: JSON.stringify({
          content: editContent,
          version_note: editVersionNote.trim() || null,
        }),
      });
      closeEditModal();
      setSuccess("DOCX content saved as a new version.");
      await load();
    } catch (err) {
      setError(err.message || "Failed to save edited content");
    } finally {
      setSaving(false);
    }
  }

  async function deleteDocument(id) {
    setError("");
    setSuccess("");
    try {
      await apiRequest(`/api/v1/documents/${id}`, { method: "DELETE" });
      setMenuOpenId(null);
      setSuccess("Document deleted.");
      await load();
    } catch (err) {
      setError(err.message || "Delete failed");
    }
  }

  function openUploadModal() {
    setSuccess("");
    setError("");
    const params = new URLSearchParams(searchParams.toString());
    params.set("upload", "1");
    router.replace(`${pathname}?${params.toString()}`);
  }

  function openDocumentPreview(document) {
    setMenuOpenId(null);
    setError("");
    void openPreview({
      path: `/api/v1/documents/${document.id}/view`,
      downloadPath: `/api/v1/documents/${document.id}/download`,
      filename: document.file_name || document.title || `Document #${document.id}`,
    });
  }

  function closeUploadModal() {
    setForm({ ...initialForm, client_id: requestedClientId });
    setDragActive(false);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("upload");
    const next = params.toString();
    router.replace(next ? `${pathname}?${next}` : pathname);
  }

  function openReplaceModal(document) {
    setReplaceTarget(document);
    setReplaceFile(null);
    setReplaceNotes("");
    setMenuOpenId(null);
    setSuccess("");
  }

  function closeReplaceModal() {
    setReplaceTarget(null);
    setReplaceFile(null);
    setReplaceNotes("");
  }

  function selectUploadFile(file) {
    if (!file) return;
    setForm((current) => ({ ...current, file }));
    setDragActive(false);
    setError("");
  }

  function handleFolderSelect(folderKey) {
    setActiveFolder(folderKey);
    setFolderNotice("");
  }

  function handleNewFolderPlaceholder() {
    setFolderNotice("Folder creation will be enabled when backend folder support is available.");
  }

  return (
    <section className="dashboard-page-stack dashboard-content-container documents-page">
      <div className="documents-page__hero">
        <div>
          <div className="dashboard-page-heading"><h1>Documents</h1></div>
          <p className="documents-page__subcopy">Manage firm documents, case files, templates, and document intake from one workspace.</p>
        </div>
        <button type="button" className="vilo-btn vilo-btn--primary documents-page__create" onClick={openUploadModal}>
          <span aria-hidden="true">+</span>
          New Document
        </button>
      </div>

      {success ? <div className="vilo-state-block"><p className="vilo-state">{success}</p></div> : null}
      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}

      <article className="dashboard-card documents-shell">
        <div className="documents-shell__tabs" role="tablist" aria-label="Document tabs">
          <button type="button" className={`documents-shell__tab${activeTab === "all" ? " is-active" : ""}`} onClick={() => setActiveTab("all")} role="tab" aria-selected={activeTab === "all"}>
            All Documents
          </button>
          <button type="button" className={`documents-shell__tab${activeTab === "mine" ? " is-active" : ""}`} onClick={() => setActiveTab("mine")} role="tab" aria-selected={activeTab === "mine"}>
            My Documents
          </button>
        </div>

        <div className="documents-shell__body">
          <aside className="documents-folders" aria-label="Document folders">
            <div className="documents-folders__list">
              {FOLDER_ITEMS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`documents-folder-item${activeFolder === item.key ? " is-active" : ""}`}
                  onClick={() => handleFolderSelect(item.key)}
                >
                  <FolderIcon />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            <button type="button" className="documents-folders__new" onClick={handleNewFolderPlaceholder}>
              + New Folder
            </button>
            {folderNotice ? <p className="documents-folders__note">{folderNotice}</p> : null}
          </aside>

          <div className="documents-content">
            <div className="documents-toolbar">
              <form className="documents-search" onSubmit={(event) => event.preventDefault()}>
                <SearchIcon />
                <input
                  type="search"
                  placeholder="Search documents"
                  value={draftSearch}
                  onChange={(event) => setDraftSearch(event.target.value)}
                  aria-label="Search documents"
                />
              </form>

              <div className="documents-toolbar__filters">
                <label className="documents-select">
                  <span>Sort By:</span>
                  <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                    <option value="case">Case</option>
                    <option value="updated">Last Modified</option>
                    <option value="name">Name</option>
                    <option value="size">Size</option>
                  </select>
                </label>

                <label className="documents-select">
                  <span>Per Page:</span>
                  <select value={perPage} onChange={(event) => setPerPage(Number(event.target.value))}>
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="documents-advanced-filters">
              <label><span>Case</span><select value={filterCase} onChange={(event) => setFilterCase(event.target.value)}><option value="">All cases</option>{cases.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
              <label><span>Client</span><select value={filterClient} onChange={(event) => setFilterClient(event.target.value)}><option value="">All clients</option>{clients.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
              <label><span>Uploaded by</span><select value={filterUploader} onChange={(event) => setFilterUploader(event.target.value)}><option value="">Anyone</option>{uploaders.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
              <label><span>Status</span><select value={filterVisibility} onChange={(event) => setFilterVisibility(event.target.value)}><option value="">Any status</option><option value="internal">Internal</option><option value="client_visible">Client visible</option></select></label>
              <label><span>File type</span><select value={filterType} onChange={(event) => setFilterType(event.target.value)}><option value="">All types</option><option value="pdf">PDF</option><option value="word">Word</option><option value="image">Image</option></select></label>
              <label><span>Uploaded from</span><input type="date" value={filterFrom} onChange={(event) => setFilterFrom(event.target.value)} /></label>
              <label><span>Uploaded to</span><input type="date" value={filterTo} onChange={(event) => setFilterTo(event.target.value)} /></label>
              <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={() => { setDraftSearch(""); setSearchQuery(""); setActiveFolder("all"); setActiveTab("all"); setFilterCase(""); setFilterClient(""); setFilterUploader(""); setFilterVisibility(""); setFilterType(""); setFilterFrom(""); setFilterTo(""); setPage(1); const params = new URLSearchParams(searchParams.toString()); params.delete("document_id"); router.replace(params.toString() ? `${pathname}?${params.toString()}` : pathname); }}>Clear filters</button>
            </div>

            {loading ? (
              <div className="documents-state"><p className="vilo-state">Loading documents...</p></div>
            ) : null}

            {!loading && !sortedDocuments.length ? (
              <div className="documents-state">
                <p className="vilo-state">{searchQuery || activeFolder !== "all" || activeTab !== "all" ? "No documents matched the current filters." : "No documents uploaded yet."}</p>
              </div>
            ) : null}

            {!loading && sortedDocuments.length ? (
              <>
                <div className={`vilo-table-wrap case-table-wrap documents-table-wrap${menuOpenId ? " case-table-wrap--menu-visible" : ""}`}>
                  <table className="team-table documents-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Case / Client</th>
                        <th>Size</th>
                        <th>Last Modified</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((document) => {
                        const caseRow = document.case_id ? casesById.get(Number(document.case_id)) : null;

                        return (
                          <tr key={document.id}>
                            <td>
                              <div className="documents-table__name">
                                <span className="documents-table__name-title">{document.title || document.file_name || `Document #${document.id}`}</span>
                                <span className="documents-table__name-meta">{document.file_name}</span>
                              </div>
                            </td>
                            <td>
                              <div className="documents-table__meta">
                                <span>{caseRow?.title || (document.case_id ? `Case #${document.case_id}` : document.client_id ? `Client #${document.client_id}` : toTitleCase(document.category || "General"))}</span>
                                <small>{document.category ? toTitleCase(document.category) : "Uncategorized"}</small>
                              </div>
                            </td>
                            <td>{formatFileSize(document.file_size)}</td>
                            <td>{formatRelativeDate(document.updated_at || document.created_at)}</td>
                            <td>
                              <div className="vilo-table-actions case-row-actions">
                                <button
                                  type="button"
                                  className="vilo-btn vilo-btn--ghost vilo-btn--xs documents-actions__trigger"
                                  aria-expanded={menuOpenId === document.id}
                                  onClick={() => setMenuOpenId((openId) => (openId === document.id ? null : document.id))}
                                >
                                  Actions
                                </button>
                                {menuOpenId === document.id ? (
                                  <div className="case-actions-menu documents-actions-menu">
                                    <button type="button" onClick={() => openDocumentPreview(document)}>View</button>
                                    <button type="button" onClick={() => apiDownload(`/api/v1/documents/${document.id}/download`).catch((err) => setError(err.message || "Download failed"))}>Download</button>
                                    {getDocumentViewerType({ filename: document.file_name, mediaType: document.file_type }) === "onlyoffice" ? (
                                      <button type="button" onClick={() => openOnlyOfficeModal(document)}>Open in Word Editor</button>
                                    ) : null}
                                    {getDocumentViewerType({ filename: document.file_name, mediaType: document.file_type }) === "onlyoffice" ? (
                                      <button type="button" onClick={() => openEditModal(document)}>Edit Content</button>
                                    ) : null}
                                    {getDocumentViewerType({ filename: document.file_name, mediaType: document.file_type }) === "pdf" ? (
                                      <button type="button" className="is-disabled" disabled title="PDF editing will be added later. Use Replace File for now.">
                                        PDF Editing Later
                                      </button>
                                    ) : null}
                                    <button type="button" onClick={() => openReplaceModal(document)}>Edit / Replace</button>
                                    <button type="button" onClick={() => openVersions(document)}>Versions</button>
                                    <button type="button" className="is-danger" onClick={() => deleteDocument(document.id)}>Delete</button>
                                  </div>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="documents-footer">
                  <span className="documents-footer__summary">
                    Showing {serverTotal ? (page - 1) * perPage + 1 : 0}-{Math.min(page * perPage, serverTotal)} of {serverTotal} documents
                  </span>
                  <div className="files-pagination">
                    <button type="button" className="files-pagination__button is-arrow" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                      Prev
                    </button>
                    <button type="button" className="files-pagination__button is-active">
                      {page}
                    </button>
                    <button type="button" className="files-pagination__button is-text" disabled={page === totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
                      Next
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </article>

      {uploadOpen ? (
        <div className="vilo-modal-overlay" onClick={uploadCloseGuard.requestClose}>
          <div className="vilo-modal documents-intake-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header documents-intake-modal__header">
              <h3>Document Intake Form</h3>
              <button type="button" className="documents-intake-modal__close" onClick={uploadCloseGuard.requestClose} aria-label="Close document intake form" disabled={saving}>
                <CloseIcon />
              </button>
            </div>
            <div className="vilo-modal__body">
              <form className="documents-intake-form" onSubmit={uploadDocument}>
                <div className="documents-intake-form__field">
                  <label htmlFor="document-title">Document Name *</label>
                  <input
                    id="document-title"
                    ref={titleInputRef}
                    placeholder="Document Name"
                    value={form.title}
                    onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                    required
                  />
                </div>

                <div className="documents-intake-form__field">
                  <label htmlFor="document-client">Client (optional)</label>
                  <select
                    id="document-client"
                    value={form.client_id}
                    onChange={(event) => setForm((current) => ({ ...current, client_id: event.target.value, case_id: "" }))}
                  >
                    <option value="">Select Client</option>
                    {clients.map((clientRow) => <option key={clientRow.id} value={clientRow.id}>{clientRow.name}</option>)}
                  </select>
                </div>

                <div className="documents-intake-form__field">
                  <label htmlFor="document-case">Case (optional)</label>
                  <select
                    id="document-case"
                    value={form.case_id}
                    onChange={(event) => setForm((current) => ({ ...current, case_id: event.target.value }))}
                  >
                    <option value="">Select Case</option>
                    {caseOptions.map((caseRow) => <option key={caseRow.id} value={caseRow.id}>{caseRow.title}</option>)}
                  </select>
                </div>

                <div className="documents-intake-form__field">
                  <label htmlFor="document-category">Category</label>
                  <select
                    id="document-category"
                    value={form.category}
                    onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
                  >
                    {categoryOptions.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
                  </select>
                </div>

                <div className="documents-intake-form__field">
                  <label htmlFor="document-description">Description</label>
                  <textarea
                    id="document-description"
                    placeholder="Add context for this document"
                    value={form.description}
                    onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                  />
                </div>

                <div className="documents-intake-form__field">
                  <label>Upload Document</label>
                  <div
                    className={`documents-dropzone${dragActive ? " is-drag-active" : ""}`}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setDragActive(true);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragActive(true);
                    }}
                    onDragLeave={(event) => {
                      event.preventDefault();
                      setDragActive(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      selectUploadFile(event.dataTransfer.files?.[0] || null);
                    }}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.txt"
                      hidden
                      onChange={(event) => selectUploadFile(event.target.files?.[0] || null)}
                    />
                    <UploadIcon />
                    <p>
                      Drag &amp; drop or{" "}
                      <button type="button" className="documents-dropzone__link" onClick={() => fileInputRef.current?.click()}>
                        Browse
                      </button>
                    </p>
                    <span>PDF, DOC, DOCX, JPG, PNG, TXT up to 10MB</span>
                    {form.file ? <strong>{form.file.name}</strong> : null}
                  </div>
                </div>

                <div className="vilo-table-actions documents-intake-form__actions">
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={uploadCloseGuard.requestClose} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving}>
                    {saving ? "Creating..." : "Create Document"}
                  </button>
                </div>
              </form>
            </div>
          </div>
          <DiscardChangesDialog open={uploadCloseGuard.confirmDiscard} onKeepEditing={uploadCloseGuard.keepEditing} onDiscard={uploadCloseGuard.discard} />
        </div>
      ) : null}

      {replaceTarget ? (
        <div className="vilo-modal-overlay" onClick={replaceCloseGuard.requestClose}>
          <div className="vilo-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header">
              <h3>Replace Document</h3>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={replaceCloseGuard.requestClose} disabled={saving}>Close</button>
            </div>
            <div className="vilo-modal__body">
              <form className="vilo-form-grid" onSubmit={replaceDocument}>
                <p className="vilo-card-copy">Current file: <strong>{replaceTarget.file_name}</strong></p>
                <input type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.txt" onChange={(event) => setReplaceFile(event.target.files?.[0] || null)} required />
                <textarea placeholder="Version notes (optional)" value={replaceNotes} onChange={(event) => setReplaceNotes(event.target.value)} />
                <div className="vilo-table-actions">
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={replaceCloseGuard.requestClose} disabled={saving}>Cancel</button>
                  <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving}>{saving ? "Replacing..." : "Replace Document"}</button>
                </div>
              </form>
            </div>
          </div>
          <DiscardChangesDialog open={replaceCloseGuard.confirmDiscard} onKeepEditing={replaceCloseGuard.keepEditing} onDiscard={replaceCloseGuard.discard} />
        </div>
      ) : null}

      {editTarget ? (
        <div className="vilo-modal-overlay" onClick={editCloseGuard.requestClose}>
          <div className="vilo-modal documents-edit-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header">
              <h3>Edit DOCX Content</h3>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={editCloseGuard.requestClose} disabled={editLoading || saving}>Close</button>
            </div>
            <div className="vilo-modal__body">
              <form className="vilo-form-grid documents-edit-form" onSubmit={saveEditedContent}>
                <p className="documents-edit-form__warning">
                  {editWarning || "Saving creates a new DOCX version. The original file remains in version history."}
                </p>
                <p className="documents-edit-form__note">
                  Complex formatting may not be preserved perfectly in this MVP. Use Replace File when layout fidelity matters.
                </p>
                <label className="documents-edit-form__field">
                  <span>Content</span>
                  <textarea
                    className="documents-edit-form__textarea"
                    value={editContent}
                    onChange={(event) => setEditContent(event.target.value)}
                    placeholder="Editable DOCX text will appear here."
                    disabled={editLoading || saving}
                  />
                </label>
                <label className="documents-edit-form__field">
                  <span>Version Note</span>
                  <input
                    type="text"
                    value={editVersionNote}
                    onChange={(event) => setEditVersionNote(event.target.value)}
                    placeholder="Summarize what changed (optional)"
                    disabled={editLoading || saving}
                  />
                </label>
                <div className="vilo-table-actions">
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={editCloseGuard.requestClose} disabled={editLoading || saving}>Cancel</button>
                  <button type="submit" className="vilo-btn vilo-btn--primary" disabled={editLoading || saving}>
                    {editLoading ? "Loading..." : saving ? "Saving..." : "Save as New Version"}
                  </button>
                </div>
              </form>
            </div>
          </div>
          <DiscardChangesDialog open={editCloseGuard.confirmDiscard} onKeepEditing={editCloseGuard.keepEditing} onDiscard={editCloseGuard.discard} />
        </div>
      ) : null}

      {onlyOfficeTarget ? (
        <OnlyOfficeDocumentModal
          document={onlyOfficeTarget}
          mode="edit"
          onClose={closeOnlyOfficeModal}
        />
      ) : null}

      {versionTarget ? (
        <div className="vilo-modal-overlay" onClick={() => setVersionTarget(null)}>
          <div className="vilo-modal documents-versions-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header">
              <h3>Version History</h3>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setVersionTarget(null)}>Close</button>
            </div>
            <div className="vilo-modal__body">
              <div className="documents-version-current">
                <div>
                  <strong>Current Version</strong>
                  <p>v{versionTarget.version} • {formatVersionSource(versionTarget.version_source)} • User #{versionTarget.uploaded_by}</p>
                </div>
                <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => apiDownload(`/api/v1/documents/${versionTarget.id}/download`).catch((err) => setError(err.message || "Download failed"))}>
                  Download Current
                </button>
              </div>
              <div className="documents-version-current__meta">
                <span>Saved {new Date(versionTarget.updated_at || versionTarget.created_at).toLocaleString()}</span>
                <span>{versionTarget.version_note || "No version note."}</span>
              </div>
              {!versions.length ? <p className="vilo-state">No previous versions.</p> : null}
              {versions.length ? (
                <div className="vilo-table-wrap case-table-wrap documents-table-wrap">
                  <table className="team-table documents-table">
                    <thead><tr><th>Version</th><th>File</th><th>Size</th><th>Created</th><th>Created By</th><th>Source</th><th>Version Note</th><th>Action</th></tr></thead>
                    <tbody>
                      {versions.map((version) => (
                        <tr key={version.id}>
                          <td>v{version.version_number}</td>
                          <td>{version.file_name}</td>
                          <td>{formatFileSize(version.file_size)}</td>
                          <td>{new Date(version.created_at).toLocaleString()}</td>
                          <td>User #{version.uploaded_by}</td>
                          <td>{formatVersionSource(version.source)}</td>
                          <td>{version.version_note || version.notes || "-"}</td>
                          <td><button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => apiDownload(`/api/v1/documents/${versionTarget.id}/versions/${version.id}/download`).catch((err) => setError(err.message || "Download failed"))}>Download</button></td>
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
    </section>
  );
}

function matchesFolder(document, folder) {
  const normalized = String(document.category || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .trim();

  if (folder === "case_files") {
    return Boolean(document.case_id) || normalized.includes("case file") || normalized === "case";
  }

  if (folder === "client_records") {
    return Boolean(document.client_id) || normalized.includes("client") || normalized.includes("record") || normalized === "client id";
  }

  if (folder === "templates") {
    return normalized.includes("template");
  }

  if (folder === "archive") {
    return normalized.includes("archive");
  }

  return true;
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (!size) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function formatRelativeDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));

  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  if (diffMinutes < 1440) {
    const hours = Math.floor(diffMinutes / 60);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (diffMinutes < 10080) {
    const days = Math.floor(diffMinutes / 1440);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  return date.toLocaleDateString();
}

function toTitleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "-";
}

function formatVersionSource(value) {
  if (!value) return "-";
  if (value === "content_edit") return "Content Edit";
  if (value === "onlyoffice_edit") return "ONLYOFFICE Edit";
  return toTitleCase(value);
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3.75 7.5a2.25 2.25 0 0 1 2.25-2.25h4.05l1.5 1.8H18a2.25 2.25 0 0 1 2.25 2.25v7.2A2.25 2.25 0 0 1 18 18.75H6A2.25 2.25 0 0 1 3.75 16.5z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.25 4.25" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 16.5V6.75" />
      <path d="m8.25 10.5 3.75-3.75 3.75 3.75" />
      <path d="M4.5 17.25v.75A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-.75" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </svg>
  );
}
