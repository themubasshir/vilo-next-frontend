"use client";

import { useEffect, useMemo, useState } from "react";
import { apiDownload, apiRequest, apiUpload } from "../../../lib/api";
import { getCachedUser } from "../../../lib/auth";
import ProtectedFilePreviewModal, { useProtectedFilePreview } from "../../../components/ProtectedFilePreviewModal";

const PRACTICE_TABS = [
  { value: "", label: "All Precedents" },
  { value: "civil", label: "Civil Litigation" },
  { value: "employment", label: "Employment Law" },
  { value: "family", label: "Family Law" },
  { value: "corporate", label: "Corporate Law" },
  { value: "criminal", label: "Criminal Law" },
  { value: "other", label: "Other" },
];

const DOCUMENT_TYPE_OPTIONS = [
  { value: "", label: "All Types" },
  { value: "motion", label: "Motion" },
  { value: "contract", label: "Contract" },
  { value: "agreement", label: "Agreement" },
  { value: "affidavit", label: "Affidavit" },
  { value: "court_form", label: "Court Form" },
  { value: "letter", label: "Letter" },
  { value: "legal_notice", label: "Legal Notice" },
  { value: "other", label: "Other" },
];

const SORT_OPTIONS = [
  { value: "updated_at", label: "Last Modified" },
  { value: "created_at", label: "Created Date" },
  { value: "name", label: "Title A-Z" },
];

const CREATE_INITIAL = {
  mode: "text",
  name: "",
  description: "",
  practice_area: "",
  document_type: "",
  tags: "",
  content_text: "",
  file: null,
};

const EDIT_INITIAL = {
  name: "",
  description: "",
  practice_area: "",
  document_type: "",
  tags: "",
  content_text: "",
};

const COPY_INITIAL = {
  case_id: "",
  name: "",
  content_text: "",
  caseSearch: "",
};

function formatRelativeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";

  const diffMs = Date.now() - date.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.max(0, Math.floor(diffMs / dayMs));

  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  return `${months} months ago`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function formatPracticeArea(value) {
  const map = {
    civil: "Civil Litigation",
    employment: "Employment Law",
    family: "Family Law",
    corporate: "Corporate Law",
    criminal: "Criminal Law",
    other: "Other",
  };
  return map[value] || toTitleCase(value || "other");
}

function formatDocumentType(value) {
  return toTitleCase(String(value || "").replaceAll("_", " "));
}

function toTitleCase(value) {
  return String(value || "")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getTone(practiceArea) {
  const tones = {
    family: "violet",
    employment: "green",
    civil: "red",
    criminal: "orange",
    corporate: "blue",
    other: "violet",
  };
  return tones[practiceArea] || "blue";
}

function parseTags(value) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function roleCanManage(role) {
  return role === "partner" || role === "admin";
}

function roleCanView(role) {
  return role === "partner" || role === "admin" || role === "lawyer" || role === "paralegal";
}

function Modal({ title, copy, onClose, children }) {
  return (
    <div className="vilo-modal-overlay" onClick={onClose}>
      <div className="vilo-modal precedents-modal" onClick={(event) => event.stopPropagation()}>
        <div className="vilo-modal__header">
          <div>
            <h3>{title}</h3>
            {copy ? <p className="precedents-modal__copy">{copy}</p> : null}
          </div>
          <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={onClose}>Close</button>
        </div>
        <div className="vilo-modal__body">{children}</div>
      </div>
    </div>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 3.75h6l4.25 4.25V18a2.25 2.25 0 0 1-2.25 2.25h-8A2.25 2.25 0 0 1 5.75 18V6A2.25 2.25 0 0 1 8 3.75Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M14 3.75V8h4.25" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M9 12.25h6M9 15.75h4.25" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

function ChipIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="5.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8.5 3.75v3.5M15.5 3.75v3.5M7.75 11.5h8.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

export default function PrecedentsPage() {
  const [currentUser, setCurrentUser] = useState(getCachedUser());
  const [precedents, setPrecedents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [activeTab, setActiveTab] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sortBy, setSortBy] = useState("updated_at");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(CREATE_INITIAL);
  const [createError, setCreateError] = useState("");
  const [createSaving, setCreateSaving] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState(EDIT_INITIAL);
  const [editError, setEditError] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyForm, setCopyForm] = useState(COPY_INITIAL);
  const [copyError, setCopyError] = useState("");
  const [copySaving, setCopySaving] = useState(false);
  const [cases, setCases] = useState([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [casesError, setCasesError] = useState("");
  const [practiceAreas, setPracticeAreas] = useState([]);
  const [practiceAreasError, setPracticeAreasError] = useState("");
  const [practiceAreaOpen, setPracticeAreaOpen] = useState(false);
  const [practiceAreaName, setPracticeAreaName] = useState("");
  const [practiceAreaError, setPracticeAreaError] = useState("");
  const { preview, openPreview, closePreview } = useProtectedFilePreview();

  const role = currentUser?.role || "";
  const canManage = roleCanManage(role);
  const canView = roleCanView(role);
  const practiceTabs = useMemo(() => {
    const known = new Set(PRACTICE_TABS.map((tab) => tab.value.toLocaleLowerCase()));
    const dynamic = [];
    [...practiceAreas.map((area) => area.name), ...precedents.map((row) => row.practice_area)]
      .filter(Boolean)
      .forEach((value) => {
        const key = String(value).toLocaleLowerCase();
        if (known.has(key)) return;
        known.add(key);
        dynamic.push({ value, label: formatPracticeArea(value) });
      });
    return [...PRACTICE_TABS, ...dynamic.sort((a, b) => a.label.localeCompare(b.label))];
  }, [practiceAreas, precedents]);

  useEffect(() => {
    if (!canView) return;
    setPracticeAreasError("");
    apiRequest("/api/v1/precedents/practice-areas")
      .then((rows) => setPracticeAreas(rows || []))
      .catch((err) => {
        setPracticeAreas([]);
        setPracticeAreasError(err.message || "Practice areas could not be loaded.");
      });
  }, [canView]);

  useEffect(() => {
    if (currentUser) return;
    let cancelled = false;

    async function loadMe() {
      try {
        const me = await apiRequest("/api/v1/auth/me");
        if (!cancelled) setCurrentUser(me);
      } catch {
        if (!cancelled) setCurrentUser(null);
      }
    }

    loadMe();
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(draftSearch.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draftSearch]);

  useEffect(() => {
    let cancelled = false;

    async function loadPrecedents() {
      if (currentUser && !canView) {
        setLoading(false);
        setPrecedents([]);
        setTotal(0);
        setError("");
        return;
      }

      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams();
        if (searchQuery) params.set("q", searchQuery);
        if (activeTab) params.set("practice_area", activeTab);
        if (typeFilter) params.set("document_type", typeFilter);
        if (sortBy) params.set("sort", sortBy);
        if (includeArchived) params.set("include_archived", "true");
        params.set("limit", "120");
        params.set("offset", "0");

        const data = await apiRequest(`/api/v1/precedents?${params.toString()}`);
        if (cancelled) return;
        setPrecedents(data.items || []);
        setTotal(Number(data.total || 0));
      } catch (err) {
        if (cancelled) return;
        setError(err.message || "Failed to load precedents");
        setPrecedents([]);
        setTotal(0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPrecedents();
    return () => {
      cancelled = true;
    };
  }, [activeTab, canView, currentUser, includeArchived, searchQuery, sortBy, typeFilter]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError("");
      setEditOpen(false);
      setCopyOpen(false);
      return;
    }

    let cancelled = false;

    async function loadDetail() {
      setDetailLoading(true);
      setDetailError("");
      try {
        const data = await apiRequest(`/api/v1/precedents/${selectedId}`);
        if (cancelled) return;
        setDetail(data);
      } catch (err) {
        if (cancelled) return;
        setDetail(null);
        setDetailError(err.message || "Failed to load precedent");
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }

    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!editOpen || !detail) return;
    setEditForm({
      name: detail.name || "",
      description: detail.description || "",
      practice_area: detail.practice_area || "",
      document_type: detail.document_type || "",
      tags: (detail.tags || []).join(", "),
      content_text: detail.content_text || "",
    });
    setEditError("");
  }, [detail, editOpen]);

  const filteredCases = useMemo(() => {
    const query = copyForm.caseSearch.trim().toLowerCase();
    if (!query) return cases;
    return cases.filter((row) => {
      const haystack = [row.title, row.description, row.client_id ? `client ${row.client_id}` : ""]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [cases, copyForm.caseSearch]);

  async function refreshList() {
    const params = new URLSearchParams();
    if (searchQuery) params.set("q", searchQuery);
    if (activeTab) params.set("practice_area", activeTab);
    if (typeFilter) params.set("document_type", typeFilter);
    if (sortBy) params.set("sort", sortBy);
    if (includeArchived) params.set("include_archived", "true");
    params.set("limit", "120");
    params.set("offset", "0");
    const data = await apiRequest(`/api/v1/precedents?${params.toString()}`);
    setPrecedents(data.items || []);
    setTotal(Number(data.total || 0));
  }

  async function refreshDetail(precedentId) {
    const data = await apiRequest(`/api/v1/precedents/${precedentId}`);
    setDetail(data);
    return data;
  }

  function resetFilters() {
    setActiveTab("");
    setDraftSearch("");
    setSearchQuery("");
    setTypeFilter("");
    setSortBy("updated_at");
    setIncludeArchived(false);
  }

  function closeCreateModal() {
    setCreateOpen(false);
    setCreateForm(CREATE_INITIAL);
    setCreateError("");
  }

  function closeDetailModal() {
    setSelectedId(null);
    setDetail(null);
    setDetailError("");
    setEditOpen(false);
    setCopyOpen(false);
    setCopyForm(COPY_INITIAL);
  }

  async function handleCreate(event) {
    event.preventDefault();
    setCreateError("");
    setSuccess("");

    if (!createForm.name.trim() || !createForm.practice_area || !createForm.document_type) {
      setCreateError("Name, practice area, and document type are required.");
      return;
    }

    if (createForm.mode === "upload" && !createForm.file) {
      setCreateError("Please select a file to upload.");
      return;
    }

    setCreateSaving(true);
    try {
      if (createForm.mode === "text") {
        await apiRequest("/api/v1/precedents", {
          method: "POST",
          body: JSON.stringify({
            name: createForm.name.trim(),
            description: createForm.description.trim() || null,
            practice_area: createForm.practice_area,
            document_type: createForm.document_type,
            tags: parseTags(createForm.tags),
            content_text: createForm.content_text.trim() || null,
          }),
        });
      } else {
        const formData = new FormData();
        formData.append("name", createForm.name.trim());
        formData.append("practice_area", createForm.practice_area);
        formData.append("document_type", createForm.document_type);
        if (createForm.description.trim()) formData.append("description", createForm.description.trim());
        if (createForm.tags.trim()) formData.append("tags", createForm.tags.trim());
        if (createForm.content_text.trim()) formData.append("content_text", createForm.content_text.trim());
        formData.append("file", createForm.file);
        await apiUpload("/api/v1/precedents/upload", formData);
      }

      await refreshList();
      setSuccess("Precedent saved successfully.");
      closeCreateModal();
    } catch (err) {
      setCreateError(err.message || "Failed to save precedent");
    } finally {
      setCreateSaving(false);
    }
  }

  async function handleDownload() {
    if (!detail?.has_file) return;
    try {
      await apiDownload(`/api/v1/precedents/${detail.id}/download`);
    } catch (err) {
      setDetailError(err.message || "Failed to download precedent");
    }
  }

  function handleView() {
    if (!detail?.has_file) return;
    setDetailError("");
    void openPreview({
      path: `/api/v1/precedents/${detail.id}/view`,
      downloadPath: `/api/v1/precedents/${detail.id}/download`,
      filename: detail.file_name || detail.name || `Precedent #${detail.id}`,
    });
  }

  async function addPracticeArea(event) {
    event.preventDefault();
    setPracticeAreaError("");
    const normalizedName = practiceAreaName.trim().replace(/\s+/g, " ");
    if (!normalizedName) {
      setPracticeAreaError("Practice area name is required.");
      return;
    }
    try {
      const created = await apiRequest("/api/v1/precedents/practice-areas", {
        method: "POST",
        body: JSON.stringify({ name: normalizedName }),
      });
      setPracticeAreas((rows) => [...rows.filter((row) => row.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name)));
      setCreateForm((current) => ({ ...current, practice_area: created.name }));
      setPracticeAreaName("");
      setPracticeAreaOpen(false);
    } catch (err) {
      setPracticeAreaError(err.message || "Practice area could not be added.");
    }
  }

  async function handleArchive() {
    if (!detail) return;
    const confirmed = window.confirm("Archive this precedent? Existing case copies will not change.");
    if (!confirmed) return;

    setDetailError("");
    try {
      await apiRequest(`/api/v1/precedents/${detail.id}/archive`, { method: "POST" });
      await refreshList();
      setSuccess("Precedent archived.");
      closeDetailModal();
    } catch (err) {
      setDetailError(err.message || "Failed to archive precedent");
    }
  }

  async function handleEdit(event) {
    event.preventDefault();
    if (!detail) return;
    setEditError("");
    setSuccess("");

    if (!editForm.name.trim() || !editForm.practice_area || !editForm.document_type) {
      setEditError("Name, practice area, and document type are required.");
      return;
    }

    setEditSaving(true);
    try {
      await apiRequest(`/api/v1/precedents/${detail.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          practice_area: editForm.practice_area,
          document_type: editForm.document_type,
          tags: parseTags(editForm.tags),
          content_text: editForm.content_text.trim() || null,
        }),
      });
      await refreshList();
      await refreshDetail(detail.id);
      setSuccess("Master precedent updated.");
      setEditOpen(false);
    } catch (err) {
      setEditError(err.message || "Failed to update precedent");
    } finally {
      setEditSaving(false);
    }
  }

  async function openCopyModal() {
    setCopyOpen(true);
    setCopyError("");
    setCopyForm({
      case_id: "",
      name: detail?.name || "",
      content_text: "",
      caseSearch: "",
    });

    if (cases.length > 0 || casesLoading) return;

    setCasesLoading(true);
    setCasesError("");
    try {
      const rows = await apiRequest("/api/v1/cases");
      setCases(rows || []);
    } catch (err) {
      setCases([]);
      setCasesError(err.message || "Failed to load cases");
    } finally {
      setCasesLoading(false);
    }
  }

  async function handleCopy(event) {
    event.preventDefault();
    if (!detail) return;
    setCopyError("");
    setSuccess("");

    if (!copyForm.case_id) {
      setCopyError("Please select a case.");
      return;
    }

    setCopySaving(true);
    try {
      const response = await apiRequest(`/api/v1/precedents/${detail.id}/copy-to-case`, {
        method: "POST",
        body: JSON.stringify({
          case_id: Number(copyForm.case_id),
          name: copyForm.name.trim() || null,
          content_text: copyForm.content_text.trim() || null,
        }),
      });
      setSuccess(`Precedent copied to case as document #${response.document.id}.`);
      setCopyOpen(false);
      setCopyForm(COPY_INITIAL);
    } catch (err) {
      setCopyError(err.message || "Failed to copy precedent to case");
    } finally {
      setCopySaving(false);
    }
  }

  if (currentUser && !canView) {
    return (
      <section className="dashboard-page-stack precedents-page">
        <div className="precedents-page__topbar">
          <div className="dashboard-page-heading precedents-page__heading">
            <h1>Precedents</h1>
            <p>Standardized legal templates and drafting starters for repeatable firm work.</p>
          </div>
        </div>
        <div className="precedents-shell">
          <div className="vilo-state-block precedents-empty">
            <p className="vilo-state vilo-state--error">You do not have access to the precedents library.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="dashboard-page-stack precedents-page">
      <div className="precedents-page__topbar">
        <div className="dashboard-page-heading precedents-page__heading">
          <h1>Precedents</h1>
          <p>Standardized legal templates and drafting starters for repeatable firm work.</p>
        </div>

        {canManage ? (
          <button type="button" className="vilo-btn vilo-btn--primary precedents-page__create" onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            <span>New Precedent</span>
          </button>
        ) : null}
      </div>

      {success ? <div className="vilo-state-block"><p className="vilo-state">{success}</p></div> : null}

      <div className="precedents-shell">
        <div className="precedents-tabs" role="tablist" aria-label="Precedent categories">
          {practiceTabs.map((tab) => (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.value}
              className={`precedents-tab${activeTab === tab.value ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="precedents-filters precedents-filters--rich">
          <label className="precedents-search-field">
            <span className="sr-only">Search precedents</span>
            <input
              type="search"
              value={draftSearch}
              onChange={(event) => setDraftSearch(event.target.value)}
              placeholder="Search precedents, descriptions, or text"
            />
          </label>

          <label className="precedents-filter-field">
            <span className="sr-only">Type</span>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              {DOCUMENT_TYPE_OPTIONS.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
            </select>
            <ChevronDownIcon />
          </label>

          <label className="precedents-filter-field">
            <span className="sr-only">Sort order</span>
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
              {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <ChevronDownIcon />
          </label>

          <label className="precedents-toggle">
            <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
            <span>Include archived</span>
          </label>
        </div>

        <div className="precedents-results-head precedents-results-head--between">
          <h2>{total} {total === 1 ? "Precedent" : "Precedents"}</h2>
          <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={resetFilters}>
            Reset filters
          </button>
        </div>

        {loading ? (
          <div className="vilo-state-block precedents-empty">
            <p className="vilo-state vilo-state--loading">Loading precedents...</p>
          </div>
        ) : null}

        {!loading && error ? (
          <div className="vilo-state-block precedents-empty">
            <p className="vilo-state vilo-state--error">{error}</p>
          </div>
        ) : null}

        {!loading && !error && precedents.length === 0 ? (
          <div className="vilo-state-block precedents-empty">
            <p className="vilo-state">No precedents matched the selected filters.</p>
          </div>
        ) : null}

        {!loading && !error && precedents.length > 0 ? (
          <div className="precedents-grid">
            {precedents.map((row) => {
              const tone = getTone(row.practice_area);
              return (
                <button
                  key={row.id}
                  type="button"
                  className={`precedent-card${row.is_archived ? " is-archived" : ""}`}
                  onClick={() => setSelectedId(row.id)}
                  aria-label={`Preview ${row.name}`}
                >
                  <div className="precedent-card__body">
                    <div className="precedent-card__title-row">
                      <span className="precedent-card__icon">
                        <FileIcon />
                      </span>
                      <div>
                        <h3>{row.name}</h3>
                        {row.has_file ? <span className="precedent-card__subtle">{row.file_name}</span> : <span className="precedent-card__subtle">Text precedent</span>}
                      </div>
                    </div>

                    <div className={`precedent-card__chip precedent-card__chip--${tone}`}>
                      <ChipIcon />
                      <span>{formatPracticeArea(row.practice_area)}</span>
                      <span className="precedent-card__chip-dot" />
                      <span>{formatDocumentType(row.document_type)}</span>
                    </div>

                    <p>{row.description || "No description added yet."}</p>

                    {row.tags?.length ? (
                      <div className="precedent-card__tags">
                        {row.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="precedent-card__tag">{tag}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="precedent-card__footer">
                    <span>Modified {formatRelativeDate(row.updated_at || row.created_at)}</span>
                    <span className="precedent-card__footer-dot" />
                    <span>by {row.updated_by_name || row.created_by_name || "Unknown"}</span>
                  </div>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {selectedId ? (
        <Modal
          title={detail?.name || "Precedent preview"}
          copy="This is the reusable master precedent. Editing it changes future use only and does not update existing copied case documents."
          onClose={closeDetailModal}
        >
          {detailLoading ? <p className="vilo-state vilo-state--loading">Loading precedent...</p> : null}
          {detailError ? <p className="vilo-state vilo-state--error">{detailError}</p> : null}

          {!detailLoading && !detailError && detail ? (
            <div className="precedents-modal__stack">
              <div className={`precedent-card__chip precedent-card__chip--${getTone(detail.practice_area)}`}>
                <ChipIcon />
                <span>{formatPracticeArea(detail.practice_area)}</span>
                <span className="precedent-card__chip-dot" />
                <span>{formatDocumentType(detail.document_type)}</span>
              </div>

              {detail.description ? <p className="precedents-modal__description">{detail.description}</p> : null}

              {detail.tags?.length ? (
                <div className="precedents-modal__tag-list">
                  {detail.tags.map((tag) => <span key={tag} className="precedent-card__tag">{tag}</span>)}
                </div>
              ) : null}

              {detail.content_text ? (
                <div className="precedents-detail-panel">
                  <h4>Master Text</h4>
                  <pre className="precedents-detail-panel__content">{detail.content_text}</pre>
                </div>
              ) : null}

              {detail.has_file ? (
                <div className="precedents-detail-panel">
                  <h4>File</h4>
                  <p className="precedents-detail-panel__meta">
                    {detail.file_name} {detail.file_type ? `· ${detail.file_type}` : ""} {detail.file_size ? `· ${detail.file_size} bytes` : ""}
                  </p>
                </div>
              ) : null}

              <div className="precedents-modal__meta">
                <span>Created {formatDateTime(detail.created_at)} by {detail.created_by_name || "Unknown"}</span>
                <span>Updated {formatDateTime(detail.updated_at)}{detail.updated_by_name ? ` by ${detail.updated_by_name}` : ""}</span>
                {detail.is_archived ? <span>Status: Archived</span> : null}
              </div>

              {!editOpen && !copyOpen ? (
                <div className="precedents-modal__actions precedents-modal__actions--split">
                  <div className="precedents-modal__actions-group">
                    {detail.has_file ? <button type="button" className="vilo-btn vilo-btn--secondary" onClick={handleView}>View</button> : null}
                    {detail.has_file ? <button type="button" className="vilo-btn vilo-btn--secondary" onClick={handleDownload}>Download</button> : null}
                    <button type="button" className="vilo-btn vilo-btn--primary" onClick={openCopyModal}>Use for Case</button>
                  </div>
                  {canManage ? (
                    <div className="precedents-modal__actions-group">
                      <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setEditOpen(true)}>Edit Master</button>
                      {!detail.is_archived ? <button type="button" className="vilo-btn vilo-btn--danger" onClick={handleArchive}>Archive</button> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {editOpen ? (
                <form className="vilo-form-grid precedents-form-grid" onSubmit={handleEdit}>
                  <div className="precedents-detail-panel">
                    <h4>Edit Master</h4>
                    <p className="precedents-detail-panel__meta">Changes here affect future copies only.</p>
                  </div>
                  <input
                    placeholder="Name"
                    value={editForm.name}
                    onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))}
                    required
                  />
                  <textarea
                    placeholder="Description"
                    value={editForm.description}
                    onChange={(event) => setEditForm((current) => ({ ...current, description: event.target.value }))}
                  />
                  <div className="vilo-form-row-two">
                    <select
                      value={editForm.practice_area}
                      onChange={(event) => setEditForm((current) => ({ ...current, practice_area: event.target.value }))}
                      required
                    >
                      <option value="">Select practice area</option>
                      {PRACTICE_TABS.filter((tab) => tab.value).map((tab) => <option key={tab.value} value={tab.value}>{tab.label}</option>)}
                    </select>
                    <select
                      value={editForm.document_type}
                      onChange={(event) => setEditForm((current) => ({ ...current, document_type: event.target.value }))}
                      required
                    >
                      <option value="">Select document type</option>
                      {DOCUMENT_TYPE_OPTIONS.filter((option) => option.value).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                  <input
                    placeholder="Tags separated by commas"
                    value={editForm.tags}
                    onChange={(event) => setEditForm((current) => ({ ...current, tags: event.target.value }))}
                  />
                  <textarea
                    placeholder="Master content"
                    value={editForm.content_text}
                    onChange={(event) => setEditForm((current) => ({ ...current, content_text: event.target.value }))}
                  />
                  {editError ? <p className="vilo-state vilo-state--error">{editError}</p> : null}
                  <div className="precedents-modal__actions precedents-modal__actions--split">
                    <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setEditOpen(false)}>Cancel</button>
                    <button type="submit" className="vilo-btn vilo-btn--primary" disabled={editSaving}>{editSaving ? "Saving..." : "Save Master"}</button>
                  </div>
                </form>
              ) : null}

              {copyOpen ? (
                <form className="vilo-form-grid precedents-form-grid" onSubmit={handleCopy}>
                  <div className="precedents-detail-panel">
                    <h4>Copy to Case</h4>
                    <p className="precedents-detail-panel__meta">This creates an independent case document. Editing the copy does not change the master precedent.</p>
                  </div>

                  <input
                    type="search"
                    placeholder="Search accessible cases"
                    value={copyForm.caseSearch}
                    onChange={(event) => setCopyForm((current) => ({ ...current, caseSearch: event.target.value }))}
                  />

                  <select
                    value={copyForm.case_id}
                    onChange={(event) => setCopyForm((current) => ({ ...current, case_id: event.target.value }))}
                    required
                  >
                    <option value="">Select case</option>
                    {filteredCases.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
                  </select>

                  <input
                    placeholder="Case document name"
                    value={copyForm.name}
                    onChange={(event) => setCopyForm((current) => ({ ...current, name: event.target.value }))}
                  />

                  <textarea
                    placeholder="Optional content override"
                    value={copyForm.content_text}
                    onChange={(event) => setCopyForm((current) => ({ ...current, content_text: event.target.value }))}
                  />

                  {casesLoading ? <p className="vilo-state vilo-state--loading">Loading cases...</p> : null}
                  {casesError ? <p className="vilo-state vilo-state--error">{casesError}</p> : null}
                  {copyError ? <p className="vilo-state vilo-state--error">{copyError}</p> : null}

                  <div className="precedents-modal__actions precedents-modal__actions--split">
                    <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setCopyOpen(false)}>Cancel</button>
                    <button type="submit" className="vilo-btn vilo-btn--primary" disabled={copySaving}>{copySaving ? "Copying..." : "Create Case Copy"}</button>
                  </div>
                </form>
              ) : null}
            </div>
          ) : null}
        </Modal>
      ) : null}

      {createOpen ? (
        <Modal
          title="New precedent"
          copy="Create a reusable master precedent as text or upload a file-backed template."
          onClose={closeCreateModal}
        >
          <form className="vilo-form-grid precedents-form-grid" onSubmit={handleCreate}>
            <div className="precedents-mode-switch">
              <button
                type="button"
                className={`precedents-mode-switch__item${createForm.mode === "text" ? " is-active" : ""}`}
                onClick={() => setCreateForm((current) => ({ ...current, mode: "text", file: null }))}
              >
                Text Precedent
              </button>
              <button
                type="button"
                className={`precedents-mode-switch__item${createForm.mode === "upload" ? " is-active" : ""}`}
                onClick={() => setCreateForm((current) => ({ ...current, mode: "upload" }))}
              >
                Upload File
              </button>
            </div>

            <input
              placeholder="Name"
              value={createForm.name}
              onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
              required
            />

            <textarea
              placeholder="Description"
              value={createForm.description}
              onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))}
            />

            <div className="vilo-form-row-two precedents-practice-row">
              <div className="precedents-practice-field">
                <label htmlFor="precedent-practice-area">Practice Area *</label>
                <select
                  id="precedent-practice-area"
                  value={createForm.practice_area}
                  onChange={(event) => setCreateForm((current) => ({ ...current, practice_area: event.target.value }))}
                  required
                >
                  <option value="">Select practice area</option>
                  {practiceTabs.filter((tab) => tab.value).map((tab) => <option key={tab.value} value={tab.value}>{tab.label}</option>)}
                </select>
                <button type="button" className="precedents-add-practice-action" onClick={() => { setPracticeAreaError(""); setPracticeAreaOpen(true); }}>+ Add Practice Area</button>
                {practiceAreasError ? <p className="vilo-field-error">{practiceAreasError}</p> : null}
              </div>

              <div>
                <label htmlFor="precedent-document-type">Document Type *</label>
                <select
                  id="precedent-document-type"
                  value={createForm.document_type}
                  onChange={(event) => setCreateForm((current) => ({ ...current, document_type: event.target.value }))}
                  required
                >
                  <option value="">Select document type</option>
                  {DOCUMENT_TYPE_OPTIONS.filter((option) => option.value).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            </div>

            <input
              placeholder="Tags separated by commas"
              value={createForm.tags}
              onChange={(event) => setCreateForm((current) => ({ ...current, tags: event.target.value }))}
            />

            <textarea
              placeholder="Master content"
              value={createForm.content_text}
              onChange={(event) => setCreateForm((current) => ({ ...current, content_text: event.target.value }))}
            />

            {createForm.mode === "upload" ? (
              <label className="precedents-upload-field">
                <span>Template file</span>
                <input
                  type="file"
                  onChange={(event) => setCreateForm((current) => ({ ...current, file: event.target.files?.[0] || null }))}
                  required={createForm.mode === "upload"}
                />
                <small>{createForm.file ? createForm.file.name : "PDF, Word, image, or text file"}</small>
              </label>
            ) : null}

            {createError ? <p className="vilo-state vilo-state--error">{createError}</p> : null}

            <div className="precedents-modal__actions precedents-modal__actions--split">
              <button type="button" className="vilo-btn vilo-btn--secondary" onClick={closeCreateModal}>Cancel</button>
              <button type="submit" className="vilo-btn vilo-btn--primary" disabled={createSaving}>{createSaving ? "Saving..." : "Save Precedent"}</button>
            </div>
          </form>
        </Modal>
      ) : null}
      {practiceAreaOpen ? (
        <div className="vilo-modal-overlay vilo-modal-overlay--nested" onClick={() => setPracticeAreaOpen(false)}>
          <div className="vilo-modal vilo-confirm-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header"><h3>Add Practice Area</h3><button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setPracticeAreaOpen(false)}>Close</button></div>
            <form className="vilo-modal__body vilo-form-grid" onSubmit={addPracticeArea}>
              <div><label>Practice Area Name</label><input value={practiceAreaName} onChange={(event) => setPracticeAreaName(event.target.value)} maxLength={100} required autoFocus /></div>
              {practiceAreaError ? <p className="vilo-state vilo-state--error">{practiceAreaError}</p> : null}
              <div className="vilo-table-actions"><button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => setPracticeAreaOpen(false)}>Cancel</button><button type="submit" className="vilo-btn vilo-btn--primary">Add Practice Area</button></div>
            </form>
          </div>
        </div>
      ) : null}
      <ProtectedFilePreviewModal preview={preview} onClose={closePreview} />
    </section>
  );
}
