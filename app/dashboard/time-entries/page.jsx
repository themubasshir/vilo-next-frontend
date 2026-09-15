"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getCachedUser, setCachedUser } from "../../../lib/auth";
import { apiRequest } from "../../../lib/api";
import { formatViloDateTime } from "../../../lib/dateFormat";
import ViloDateInput from "../../../components/ViloDateInput";

function nowLocalValue(offsetHours = 0) {
  const date = new Date();
  date.setHours(date.getHours() + offsetHours, 0, 0, 0);
  const tzOffset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - tzOffset * 60000);
  return local.toISOString().slice(0, 16);
}

function createInitialForm() {
  return {
    user_id: "",
    case_id: "",
    description: "",
    start_time: nowLocalValue(0),
    end_time: nowLocalValue(1),
    billing_mode: "billable",
    currency: "USD",
    hourly_rate: "",
  };
}

function formatDateTime(value) {
  return formatViloDateTime(value);
}

function formatMoney(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value || 0));
}

function formatDuration(minutes) {
  if (!minutes || minutes < 1) return "00:00";
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mins = String(minutes % 60).padStart(2, "0");
  return `${hours}:${mins}`;
}

function formatEntryNumber(id) {
  return `TE-${String(id).padStart(4, "0")}`;
}

function toBillingMode(type) {
  if (type === "non_billable") return "non_billable";
  if (type === "no_charge") return "no_charge";
  return "billable";
}

function toBillingType(mode) {
  if (mode === "non_billable") return "non_billable";
  if (mode === "no_charge") return "no_charge";
  return "professional_fee";
}

function getDurationMinutes(start, end) {
  if (!start || !end) return 0;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) return 0;
  return Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 60000));
}

function getAmountPreview(minutes, rate, mode) {
  if (mode !== "billable" || !minutes) return 0;
  const parsedRate = Number(rate || 0);
  if (!Number.isFinite(parsedRate)) return 0;
  return (minutes / 60) * parsedRate;
}

function badgeClass(type) {
  return `time-entry-badge time-entry-badge--${type}`;
}

function roleCanOverrideRates(role) {
  return role === "partner" || role === "admin";
}

function TimeEntriesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [currentUser, setCurrentUser] = useState(getCachedUser());
  const [entries, setEntries] = useState([]);
  const [cases, setCases] = useState([]);
  const [clients, setClients] = useState([]);
  const [team, setTeam] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingRate, setLoadingRate] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [modalError, setModalError] = useState("");
  const [rateStatus, setRateStatus] = useState({ source: "", message: "" });
  const [modalMode, setModalMode] = useState("create");
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [perPage, setPerPage] = useState(10);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [form, setForm] = useState(createInitialForm());
  const [caseSearch, setCaseSearch] = useState("");

  const canOverrideRates = roleCanOverrideRates(currentUser?.role || "");

  async function loadEntries(nextPage = page, nextPerPage = perPage) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        per_page: String(nextPerPage),
        sort_by: sortBy,
      });
      if (search.trim()) params.set("search", search.trim());
      if (dateRange !== "all") params.set("date_range", dateRange);
      const response = await apiRequest(`/api/v1/time-entries?${params.toString()}`);
      setEntries(response.items || []);
      setTotal(response.total || 0);
      setTotalPages(response.total_pages || 1);
    } catch (err) {
      setError(err.message || "Failed to load time entries");
    } finally {
      setLoading(false);
    }
  }

  async function loadReferences() {
    try {
      const [caseRows, clientRows, teamRows] = await Promise.all([
        apiRequest("/api/v1/cases").catch(() => []),
        apiRequest("/api/v1/clients").catch(() => []),
        apiRequest("/api/v1/team").catch(() => []),
      ]);
      setCases(caseRows || []);
      setClients(clientRows || []);
      setTeam((teamRows || []).filter((user) => user.role !== "client"));
    } catch {
      setCases([]);
      setClients([]);
      setTeam([]);
    }
  }

  useEffect(() => {
    loadReferences();
  }, []);

  useEffect(() => {
    if (currentUser) return;
    let cancelled = false;
    apiRequest("/api/v1/auth/me")
      .then((me) => {
        if (cancelled) return;
        setCurrentUser(me);
        setCachedUser(me);
        setForm((current) => ({ ...current, user_id: String(me.id) }));
      })
      .catch(() => {
        if (cancelled) return;
        setCurrentUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  useEffect(() => {
    loadEntries(page, perPage);
  }, [page, perPage, sortBy, dateRange]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPage(1);
      loadEntries(1, perPage);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    if (searchParams.get("create") === "1") openCreateModal();
  }, [searchParams]);

  useEffect(() => {
    const closeMenus = () => setMenuOpenId(null);
    window.addEventListener("click", closeMenus);
    return () => window.removeEventListener("click", closeMenus);
  }, []);

  const caseLookup = useMemo(() => {
    const map = new Map();
    clients.forEach((client) => map.set(client.id, client));
    return map;
  }, [clients]);

  const selectedCase = cases.find((item) => Number(item.id) === Number(form.case_id || 0));
  const selectedClient = selectedCase ? caseLookup.get(selectedCase.client_id) : null;
  const filteredCases = cases.filter((item) => {
    const clientName = caseLookup.get(item.client_id)?.name || "";
    const haystack = `${item.title} ${clientName}`.toLowerCase();
    return haystack.includes(caseSearch.trim().toLowerCase());
  });
  const durationMinutes = getDurationMinutes(form.start_time, form.end_time);
  const amountPreview = getAmountPreview(durationMinutes, form.hourly_rate, form.billing_mode);
  const startItem = total === 0 ? 0 : (page - 1) * perPage + 1;
  const endItem = total === 0 ? 0 : Math.min(total, (page - 1) * perPage + entries.length);

  useEffect(() => {
    if (!modalOpen || modalMode === "view") return;
    if (form.billing_mode !== "billable") {
      setRateStatus({ source: "non_billable", message: "Non-billable time is not treated as revenue and stays outside staff revenue reports." });
      return;
    }
    if (!form.user_id || !form.currency) return;

    let cancelled = false;
    async function loadEffectiveRate() {
      setLoadingRate(true);
      setModalError("");
      try {
        const rate = await apiRequest(`/api/v1/settings/billing-rates/effective?user_id=${form.user_id}&currency=${form.currency}`);
        if (cancelled) return;
        setForm((current) => {
          if (current.billing_mode !== "billable") return current;
          if (selectedEntry?.rate_is_manual && modalMode === "edit" && canOverrideRates) return current;
          return { ...current, hourly_rate: rate.hourly_rate || "0.00" };
        });
        if (rate.source === "user_override") {
          setRateStatus({ source: rate.source, message: "User override rate" });
        } else if (rate.source === "role") {
          setRateStatus({ source: rate.source, message: "Role-based rate" });
        } else {
          setRateStatus({ source: rate.source, message: "No billing rate configured. Billable time cannot be saved until a rate exists or a partner/admin overrides it." });
        }
      } catch (err) {
        if (cancelled) return;
        setRateStatus({ source: "error", message: "Effective rate unavailable." });
      } finally {
        if (!cancelled) setLoadingRate(false);
      }
    }

    loadEffectiveRate();
    return () => {
      cancelled = true;
    };
  }, [canOverrideRates, form.billing_mode, form.currency, form.user_id, modalMode, modalOpen, selectedEntry?.rate_is_manual]);

  function openCreateModal() {
    setSelectedEntry(null);
    setModalMode("create");
    setModalError("");
    setRateStatus({ source: "", message: "" });
    setCaseSearch("");
    setForm({
      ...createInitialForm(),
      user_id: currentUser?.id ? String(currentUser.id) : "",
    });
    setModalOpen(true);
  }

  function openEditModal(entry) {
    setSelectedEntry(entry);
    setModalMode("edit");
    setModalError("");
    setRateStatus({
      source: entry.rate_is_manual ? "manual" : "existing",
      message: entry.rate_is_manual ? "Manual rate override" : entry.hourly_rate ? "Saved auto-rate" : "No billing rate configured.",
    });
    setCaseSearch("");
    setForm({
      user_id: entry.user_id ? String(entry.user_id) : String(currentUser?.id || ""),
      case_id: entry.case_id ? String(entry.case_id) : "",
      description: entry.description || "",
      start_time: entry.start_time ? new Date(new Date(entry.start_time).getTime() - new Date(entry.start_time).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : nowLocalValue(0),
      end_time: entry.end_time ? new Date(new Date(entry.end_time).getTime() - new Date(entry.end_time).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : nowLocalValue(1),
      billing_mode: toBillingMode(entry.billing_type),
      currency: entry.currency || "USD",
      hourly_rate: entry.hourly_rate || "",
    });
    setModalOpen(true);
  }

  function openViewModal(entry) {
    openEditModal(entry);
    setModalMode("view");
  }

  function closeModal() {
    setModalOpen(false);
    setModalError("");
    setSelectedEntry(null);
    setRateStatus({ source: "", message: "" });
    if (searchParams.get("create") === "1") router.replace("/dashboard/time-entries");
  }

  async function handleSave(event) {
    event.preventDefault();
    if (modalMode === "view") {
      closeModal();
      return;
    }
    if (!form.start_time || !form.end_time) {
      setModalError("Start time and end time are required.");
      return;
    }
    if (!durationMinutes) {
      setModalError("End time must be after start time.");
      return;
    }
    if (form.billing_mode === "billable" && !canOverrideRates && rateStatus.source === "missing") {
      setModalError("No active billing rate is configured for this staff user and currency.");
      return;
    }

    setSaving(true);
    setModalError("");
    setSuccess("");
    try {
      const payload = {
        user_id: form.user_id ? Number(form.user_id) : null,
        case_id: form.case_id ? Number(form.case_id) : null,
        description: form.description.trim() || null,
        start_time: new Date(form.start_time).toISOString(),
        end_time: new Date(form.end_time).toISOString(),
        billing_type: toBillingType(form.billing_mode),
        currency: form.currency,
        hourly_rate: form.billing_mode === "billable" && form.hourly_rate ? String(form.hourly_rate) : null,
        rate_is_manual: form.billing_mode === "billable" ? canOverrideRates && rateStatus.source === "manual" : false,
      };
      if (modalMode === "edit" && selectedEntry) {
        await apiRequest(`/api/v1/time-entries/${selectedEntry.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setSuccess("Time entry updated.");
      } else {
        await apiRequest("/api/v1/time-entries", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setSuccess("Time entry created.");
      }
      closeModal();
      await loadEntries(page, perPage);
    } catch (err) {
      setModalError(err.message || "Failed to save time entry");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(entry) {
    if (!window.confirm("Delete this time entry?")) return;
    setError("");
    setSuccess("");
    try {
      await apiRequest(`/api/v1/time-entries/${entry.id}`, { method: "DELETE" });
      setMenuOpenId(null);
      setSuccess("Time entry deleted.");
      await loadEntries(page, perPage);
    } catch (err) {
      setError(err.message || "Failed to delete time entry");
    }
  }

  return (
    <section className="dashboard-page-stack time-entries-page">
      <div className="time-entries-page__top">
        <div className="dashboard-page-heading">
          <h1>Time Entries</h1>
          <p className="invoice-page-intro">Billable time pricing is driven by billing rates. Time worked is reported separately from collected revenue.</p>
        </div>
        <button type="button" className="vilo-btn vilo-btn--primary time-entries-page__add" onClick={openCreateModal}>
          + Add Time Entry
        </button>
      </div>

      {success ? <div className="vilo-state-block"><p className="vilo-state">{success}</p></div> : null}
      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}

      <article className="dashboard-card time-entries-shell">
        <div className="time-entries-toolbar">
          <label className="time-entries-search">
            <span aria-hidden="true">⌕</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search time entries" />
          </label>

          <div className="time-entries-filters">
            <label>
              <span>Date Range:</span>
              <select value={dateRange} onChange={(event) => { setDateRange(event.target.value); setPage(1); }}>
                <option value="all">All Dates</option>
                <option value="today">Today</option>
                <option value="last_7_days">Last 7 Days</option>
                <option value="last_30_days">Last 30 Days</option>
                <option value="this_month">This Month</option>
              </select>
            </label>
            <label>
              <span>Sort By:</span>
              <select value={sortBy} onChange={(event) => { setSortBy(event.target.value); setPage(1); }}>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="type">Type</option>
                <option value="amount_desc">Amount</option>
                <option value="duration_desc">Duration</option>
              </select>
            </label>
            <label>
              <span>Per Page:</span>
              <select value={perPage} onChange={(event) => { const next = Number(event.target.value); setPerPage(next); setPage(1); }}>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </label>
          </div>
        </div>

        <div className="time-entries-card">
          <div className="dashboard-card__header dashboard-card__header--action">
            <h2>Time Entries</h2>
          </div>

          {loading ? <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading time entries...</p></div> : null}
          {!loading && !error && !entries.length ? <div className="vilo-state-block"><p className="vilo-state">No time entries yet. Add one to start tracking billable work.</p></div> : null}

          {!loading && !error && entries.length ? (
            <>
              <div className="vilo-table-wrap time-entries-table-wrap">
                <table className="team-table time-entries-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Staff</th>
                      <th>Case</th>
                      <th>Description</th>
                      <th>Duration</th>
                      <th>Currency</th>
                      <th>Billing Type</th>
                      <th>Rate</th>
                      <th>Amount</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{formatEntryNumber(entry.id)}</td>
                        <td>{entry.staff_name || "-"}</td>
                        <td>
                          <div className="time-entry-case-cell">
                            <strong>{entry.case_title || "Unassigned"}</strong>
                            <span>{entry.client_name || entry.case_display_number || "No client"}</span>
                          </div>
                        </td>
                        <td>{entry.description || "-"}</td>
                        <td>{formatDuration(entry.duration_minutes)}</td>
                        <td>{entry.currency || "USD"}</td>
                        <td><span className={badgeClass(entry.billing_type)}>{entry.billing_type.replaceAll("_", " ")}</span></td>
                        <td>{entry.hourly_rate ? formatMoney(entry.hourly_rate, entry.currency || "USD") : "-"}</td>
                        <td>{formatMoney(entry.amount, entry.currency || "USD")}</td>
                        <td>
                          <div className="vilo-table-actions time-entry-actions">
                            <button
                              type="button"
                              className="time-entry-actions__trigger"
                              aria-expanded={menuOpenId === entry.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                setMenuOpenId((openId) => (openId === entry.id ? null : entry.id));
                              }}
                            >
                              •••
                            </button>
                            {menuOpenId === entry.id ? (
                              <div className="case-actions-menu time-entry-actions__menu" onClick={(event) => event.stopPropagation()}>
                                <button type="button" onClick={() => { openViewModal(entry); setMenuOpenId(null); }}>View</button>
                                <button type="button" onClick={() => { openEditModal(entry); setMenuOpenId(null); }}>Edit</button>
                                <button type="button" className="is-danger" onClick={() => handleDelete(entry)}>Delete</button>
                              </div>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="time-entries-footer">
                <p>Showing {startItem} to {endItem} of {total} time entries</p>
                <div className="time-entries-pagination">
                  <button type="button" className="time-entries-pagination__nav" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>‹</button>
                  {Array.from({ length: totalPages }, (_, index) => index + 1).slice(0, 5).map((value) => (
                    <button key={value} type="button" className={value === page ? "time-entries-pagination__page is-active" : "time-entries-pagination__page"} onClick={() => setPage(value)}>{value}</button>
                  ))}
                  <button type="button" className="time-entries-pagination__next" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </article>

      {modalOpen ? (
        <div className="vilo-modal-overlay" onClick={closeModal}>
          <div className="vilo-modal time-entry-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header">
              <div>
                <h3>{modalMode === "edit" ? "Edit Time Entry" : modalMode === "view" ? "View Time Entry" : "Add Time Entry"}</h3>
              </div>
              <button type="button" className="time-entry-modal__close" onClick={closeModal}>×</button>
            </div>

            <form className="vilo-modal__body time-entry-modal__body" onSubmit={handleSave}>
              <article className="settings-info-banner">
                <strong>Billing separation</strong>
                <span>Billing rates apply to time entries and invoicing only. They do not affect trust accounting.</span>
              </article>

              <div className="vilo-form-row-two">
                <div>
                  <label>Staff User</label>
                  <select value={form.user_id} disabled={modalMode === "view"} onChange={(event) => setForm((current) => ({ ...current, user_id: event.target.value }))}>
                    <option value="">Select staff user</option>
                    {team.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.role})</option>)}
                  </select>
                </div>
                <div>
                  <label>Currency</label>
                  <select value={form.currency} disabled={modalMode === "view"} onChange={(event) => setForm((current) => ({ ...current, currency: event.target.value }))}>
                    <option value="USD">USD</option>
                    <option value="JMD">JMD</option>
                  </select>
                </div>
              </div>

              <div className="vilo-form-row-two">
                <div>
                  <label>Start Time</label>
                  <ViloDateInput includeTime value={form.start_time} disabled={modalMode === "view"} onChange={(value) => setForm((current) => ({ ...current, start_time: value }))} />
                </div>
                <div>
                  <label>End Time</label>
                  <ViloDateInput includeTime value={form.end_time} disabled={modalMode === "view"} onChange={(value) => setForm((current) => ({ ...current, end_time: value }))} />
                </div>
              </div>

              <div className="time-entry-modal__summary">
                <span>Duration: {formatDuration(durationMinutes)}</span>
                <span>Amount Preview: {form.billing_mode === "billable" ? formatMoney(amountPreview, form.currency) : "Non-billable / 0.00"}</span>
              </div>

              <div>
                <label>Matter / Case</label>
                <input className="time-entry-modal__case-search" value={caseSearch} disabled={modalMode === "view"} onChange={(event) => setCaseSearch(event.target.value)} placeholder="Search case or client" />
                {selectedCase ? (
                  <button type="button" className="time-entry-case-picker is-selected" disabled={modalMode === "view"} onClick={() => setForm((current) => ({ ...current, case_id: "" }))}>
                    <strong>{selectedCase.title}</strong>
                    <span>{selectedClient?.name || "Client unavailable"}</span>
                  </button>
                ) : null}
                {modalMode !== "view" ? (
                  <div className="time-entry-case-list">
                    <button type="button" className={!form.case_id ? "time-entry-case-picker is-active" : "time-entry-case-picker"} onClick={() => setForm((current) => ({ ...current, case_id: "" }))}>
                      <strong>No linked case</strong>
                      <span>Create an internal entry without attaching a matter.</span>
                    </button>
                    {filteredCases.slice(0, 6).map((item) => (
                      <button key={item.id} type="button" className={Number(form.case_id) === Number(item.id) ? "time-entry-case-picker is-active" : "time-entry-case-picker"} onClick={() => setForm((current) => ({ ...current, case_id: String(item.id) }))}>
                        <strong>{item.title}</strong>
                        <span>{caseLookup.get(item.client_id)?.name || "Client unavailable"}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div>
                <label>Description</label>
                <textarea value={form.description} disabled={modalMode === "view"} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="Add work summary" />
              </div>

              <div>
                <label>Billable Status</label>
                <div className="time-entry-billing-options">
                  <label><input type="radio" name="billing_mode" checked={form.billing_mode === "billable"} disabled={modalMode === "view"} onChange={() => setForm((current) => ({ ...current, billing_mode: "billable" }))} /> Billable</label>
                  <label><input type="radio" name="billing_mode" checked={form.billing_mode === "non_billable"} disabled={modalMode === "view"} onChange={() => setForm((current) => ({ ...current, billing_mode: "non_billable" }))} /> Non-Billable</label>
                  <label><input type="radio" name="billing_mode" checked={form.billing_mode === "no_charge"} disabled={modalMode === "view"} onChange={() => setForm((current) => ({ ...current, billing_mode: "no_charge" }))} /> Mark As No Charge</label>
                </div>
              </div>

              <div className="vilo-form-row-two">
                <div>
                  <label>Rate</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.hourly_rate}
                    disabled={modalMode === "view" || form.billing_mode !== "billable" || (!canOverrideRates && form.billing_mode === "billable")}
                    onChange={(event) => {
                      setRateStatus({ source: "manual", message: "Manual rate override" });
                      setForm((current) => ({ ...current, hourly_rate: event.target.value }));
                    }}
                    placeholder="0.00"
                  />
                </div>
                <div className="time-entry-rate-meta">
                  <label>Rate Source</label>
                  <div className="time-entry-rate-status">
                    {loadingRate ? <span className="vilo-state vilo-state--loading">Loading effective rate...</span> : <span>{rateStatus.message || "Select staff and currency to load rate."}</span>}
                  </div>
                </div>
              </div>

              <article className="dashboard-card time-entry-rate-banner">
                <strong>Amount Preview</strong>
                <span>{form.billing_mode === "billable" ? `${formatDuration(durationMinutes)} × ${formatMoney(form.hourly_rate || 0, form.currency)} = ${formatMoney(amountPreview, form.currency)}` : "Non-billable time stays outside revenue and invoice collection reports."}</span>
              </article>

              {modalError ? <p className="vilo-state vilo-state--error">{modalError}</p> : null}

              <div className="time-entry-modal__actions">
                <button type="button" className="vilo-btn vilo-btn--secondary" onClick={closeModal}>Cancel</button>
                <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving || modalMode === "view" || (form.billing_mode === "billable" && !canOverrideRates && rateStatus.source === "missing")}>
                  {modalMode === "edit" ? (saving ? "Saving..." : "Save") : saving ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function TimeEntriesPage() {
  return (
    <Suspense fallback={<section className="dashboard-page-stack"><div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading time entries...</p></div></section>}>
      <TimeEntriesPageContent />
    </Suspense>
  );
}
