"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getCachedUser, setCachedUser } from "../../../lib/auth";
import { apiDownload, apiRequest } from "../../../lib/api";
import { invoiceErrorsByField, normalizeInvoicePayload } from "../../../lib/invoicePayload";
import { DiscardChangesDialog, useModalCloseGuard } from "../../../components/useModalCloseGuard";
import { formatViloDate } from "../../../lib/dateFormat";
import ViloDateInput from "../../../components/ViloDateInput";

const LINE_ITEM_TYPE_OPTIONS = [
  ["legal_fee", "Legal Fee"],
  ["hourly_work", "Hourly Work"],
  ["flat_fee", "Flat Fee"],
  ["disbursement", "Disbursement"],
  ["expense", "Expense"],
  ["approved_billable_expense", "Approved Billable Expense"],
];

const initialForm = {
  client_id: "",
  manual_client_name: "",
  case_id: "",
  invoice_number: "",
  currency: "JMD",
  issue_date: "",
  due_date: "",
  notes: "",
  payment_instructions: "",
  payment_account_id: "",
  line_items: [
    { line_type: "legal_fee", description: "", quantity: "1", unit_price: "", amount: "", time_entry_id: null },
  ],
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function localToday() {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
}

const initialBillingTax = {
  invoice_tax_label: "GCT",
  invoice_tax_rate: "0.00",
};

function formatMoney(value, currency = "JMD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value || 0));
}

function formatDate(value) {
  return formatViloDate(value);
}

function roleCanManagePayments(role) {
  return role === "partner" || role === "admin";
}

function buildPaymentInstructions(account) {
  if (!account) return "";
  const lines = [
    account.bank_name ? `Bank: ${account.bank_name}` : null,
    account.account_name ? `Account Name: ${account.account_name}` : null,
    account.account_number ? `Account Number: ${account.account_number}` : null,
    account.swift_routing ? `Routing Number / SWIFT: ${account.swift_routing}` : null,
    account.notes ? `Notes: ${account.notes}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function calculateLineAmount(quantity, unitPrice) {
  const qty = Number(quantity || 0);
  const price = Number(unitPrice || 0);
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return "0.00";
  return (qty * price).toFixed(2);
}

function makeManualLineItem() {
  return { line_type: "legal_fee", description: "", quantity: "1", unit_price: "", amount: "", time_entry_id: null };
}

function resolveDefaultPaymentAccount(accounts, currency) {
  return (accounts || []).find((account) => account.currency === currency && account.is_default && account.is_active)
    || (accounts || []).find((account) => account.currency === currency && account.is_active)
    || null;
}

function createTimeEntryLine(entry) {
  return {
    line_type: "hourly_work",
    description: entry.description || "Time entry",
    quantity: String(entry.duration_minutes ? Number(entry.duration_minutes) / 60 : 0),
    unit_price: String(entry.hourly_rate || 0),
    amount: calculateLineAmount(entry.duration_minutes ? Number(entry.duration_minutes) / 60 : 0, entry.hourly_rate || 0),
    time_entry_id: entry.id,
    hours: entry.duration_minutes ? (Number(entry.duration_minutes) / 60).toFixed(2) : "0.00",
    rate: String(entry.hourly_rate || 0),
    staff_name: entry.staff_name || "Staff",
    currency: entry.currency || "JMD",
  };
}

export default function InvoicesPage() {
  return (
    <Suspense fallback={<section className="dashboard-page-stack"><div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading invoices...</p></div></section>}>
      <InvoicesPageContent />
    </Suspense>
  );
}

function InvoicesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [currentUser, setCurrentUser] = useState(getCachedUser());
  const [items, setItems] = useState([]);
  const [clientResults, setClientResults] = useState([]);
  const [clientSearch, setClientSearch] = useState("");
  const [clientSearchOpen, setClientSearchOpen] = useState(false);
  const [clientSearchLoading, setClientSearchLoading] = useState(false);
  const [clientSearchError, setClientSearchError] = useState("");
  const [activeClientIndex, setActiveClientIndex] = useState(-1);
  const [cases, setCases] = useState([]);
  const [paymentAccounts, setPaymentAccounts] = useState([]);
  const [billingTax, setBillingTax] = useState(initialBillingTax);
  const [billableEntries, setBillableEntries] = useState([]);
  const [matterTrustBalance, setMatterTrustBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingTimeEntries, setLoadingTimeEntries] = useState(false);
  const [loadingTrustBalance, setLoadingTrustBalance] = useState(false);
  const [error, setError] = useState("");
  const [createError, setCreateError] = useState("");
  const [createFieldErrors, setCreateFieldErrors] = useState({});
  const [timeEntryError, setTimeEntryError] = useState("");
  const [trustBalanceError, setTrustBalanceError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [actionsOpenId, setActionsOpenId] = useState(null);
  const [voidingInvoice, setVoidingInvoice] = useState(null);
  const [voidReason, setVoidReason] = useState("");
  const [form, setForm] = useState(initialForm);
  const [createInitialForm, setCreateInitialForm] = useState(initialForm);
  const requestedClientId = searchParams.get("client_id") || "";
  const requestedCaseId = searchParams.get("case_id") || "";

  const filteredPaymentAccounts = useMemo(
    () => (paymentAccounts || []).filter((account) => account.currency === form.currency && account.is_active),
    [form.currency, paymentAccounts],
  );
  const selectedPaymentAccount = useMemo(
    () => filteredPaymentAccounts.find((account) => Number(account.id) === Number(form.payment_account_id || 0)) || null,
    [filteredPaymentAccounts, form.payment_account_id],
  );
  const paymentAccountWarning = !filteredPaymentAccounts.length
    ? "No payment account configured for this currency. Add one in Settings."
    : "";
  const selectedClientId = Number(form.client_id || 0);
  const caseOptions = useMemo(() => {
    const rows = asArray(cases);
    if (!selectedClientId) return rows;
    return rows.filter((row) => Number(row.client_id) === selectedClientId);
  }, [cases, selectedClientId]);
  const availableBillableEntries = useMemo(
    () => (billableEntries || []).filter((entry) => (entry.currency || "JMD") === form.currency),
    [billableEntries, form.currency],
  );

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [invoiceRows, caseRows, accountRows, taxSettings] = await Promise.all([
        apiRequest("/api/v1/invoices"),
        apiRequest("/api/v1/cases").catch(() => []),
        apiRequest("/api/v1/settings/payment-accounts").catch(() => []),
        apiRequest("/api/v1/settings/billing-tax").catch(() => initialBillingTax),
      ]);
      setItems(asArray(invoiceRows));
      setCases(asArray(caseRows));
      setPaymentAccounts(asArray(accountRows));
      setBillingTax(taxSettings || initialBillingTax);
    } catch (err) {
      setError(err.message || "Failed to load invoices");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setClientSearchLoading(true);
      setClientSearchError("");
      try {
        const query = clientSearch.trim();
        const rows = await apiRequest(`/api/v1/clients?status=active&limit=20${query ? `&q=${encodeURIComponent(query)}` : ""}`);
        if (!cancelled) {
          setClientResults(asArray(rows));
          setActiveClientIndex(-1);
        }
      } catch (err) {
        if (!cancelled) {
          setClientResults([]);
          setClientSearchError(err.message || "Unable to search clients.");
        }
      } finally {
        if (!cancelled) setClientSearchLoading(false);
      }
    }, clientSearch.trim() ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [clientSearch, createOpen]);

  useEffect(() => {
    if (!createOpen || !form.client_id) return;
    let cancelled = false;
    apiRequest(`/api/v1/clients/${form.client_id}`)
      .then((client) => {
        if (cancelled) return;
        setClientSearch(client.name || "");
        setClientResults((rows) => {
          const currentRows = asArray(rows);
          return currentRows.some((row) => row.id === client.id) ? currentRows : [client, ...currentRows];
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [createOpen, form.client_id]);

  useEffect(() => {
    const closeMenus = () => setActionsOpenId(null);
    window.addEventListener("click", closeMenus);
    return () => window.removeEventListener("click", closeMenus);
  }, []);

  useEffect(() => {
    if (currentUser) return;
    let cancelled = false;
    apiRequest("/api/v1/auth/me")
      .then((me) => {
        if (cancelled) return;
        setCurrentUser(me);
        setCachedUser(me);
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
    if (searchParams.get("create") === "1") openCreateModal();
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get("create") !== "1") return;
    const nextClientId = searchParams.get("client_id") || "";
    const nextCaseId = searchParams.get("case_id") || "";
    setForm((current) => ({ ...current, client_id: nextClientId, case_id: nextCaseId }));
  }, [searchParams]);

  useEffect(() => {
    if (!requestedCaseId || !cases.length) return;
    const caseRow = cases.find((row) => Number(row.id) === Number(requestedCaseId));
    if (!caseRow) return;
    setForm((current) => ({
      ...current,
      case_id: current.case_id || String(caseRow.id),
      client_id: current.client_id || String(caseRow.client_id),
    }));
  }, [cases, requestedCaseId]);

  useEffect(() => {
    const defaultAccount = resolveDefaultPaymentAccount(paymentAccounts, form.currency);
    setForm((current) => {
      const currentStillValid = (paymentAccounts || []).some(
        (account) => Number(account.id) === Number(current.payment_account_id || 0) && account.currency === current.currency && account.is_active,
      );
      const resolvedAccount = currentStillValid
        ? (paymentAccounts || []).find((account) => Number(account.id) === Number(current.payment_account_id || 0))
        : defaultAccount;
      return {
        ...current,
        payment_account_id: currentStillValid ? current.payment_account_id : defaultAccount ? String(defaultAccount.id) : "",
        payment_instructions: buildPaymentInstructions(resolvedAccount),
      };
    });
  }, [form.currency, paymentAccounts]);

  useEffect(() => {
    if (!selectedPaymentAccount) {
      setForm((current) => ({ ...current, payment_instructions: "" }));
      return;
    }
    setForm((current) => ({ ...current, payment_instructions: buildPaymentInstructions(selectedPaymentAccount) }));
  }, [selectedPaymentAccount]);

  useEffect(() => {
    if (!createOpen || !form.case_id) {
      setBillableEntries([]);
      return;
    }
    let cancelled = false;
    async function loadBillableEntries() {
      setLoadingTimeEntries(true);
      setTimeEntryError("");
      try {
        const rows = await apiRequest(`/api/v1/time-entries?case_id=${form.case_id}&status=billable&page=1&per_page=100&sort_by=newest`);
        if (cancelled) return;
        const selectedIds = new Set((form.line_items || []).map((item) => item.time_entry_id).filter(Boolean));
        setBillableEntries(asArray(rows?.items).filter((entry) => !selectedIds.has(entry.id)));
      } catch (err) {
        if (cancelled) return;
        setTimeEntryError(err.message || "Failed to load billable time entries.");
      } finally {
        if (!cancelled) setLoadingTimeEntries(false);
      }
    }
    loadBillableEntries();
    return () => {
      cancelled = true;
    };
  }, [createOpen, form.case_id, form.line_items]);

  useEffect(() => {
    if (!createOpen || !form.case_id) {
      setMatterTrustBalance(null);
      setTrustBalanceError("");
      return;
    }
    let cancelled = false;
    async function loadTrustBalance() {
      setLoadingTrustBalance(true);
      setTrustBalanceError("");
      try {
        const response = await apiRequest(`/api/v1/trust/balances?case_id=${form.case_id}&currency=${form.currency}`);
        if (cancelled) return;
        setMatterTrustBalance(response?.matter_balance ?? 0);
      } catch (err) {
        if (cancelled) return;
        setTrustBalanceError(err.message || "Unable to load matter trust balance.");
      } finally {
        if (!cancelled) setLoadingTrustBalance(false);
      }
    }
    loadTrustBalance();
    return () => {
      cancelled = true;
    };
  }, [createOpen, form.case_id, form.currency]);

  const totals = useMemo(() => ({
    balance: items.reduce((sum, row) => sum + Number(row.balance_due || 0), 0),
    drafts: items.filter((row) => row.status === "draft").length,
    sent: items.filter((row) => ["sent", "partially_paid"].includes(row.display_status || row.status)).length,
    overdue: items.filter((row) => (row.display_status || row.status) === "overdue").length,
  }), [items]);
  const canManagePayments = roleCanManagePayments(currentUser?.role || "");

  function openCreateModal() {
    setCreateError("");
    setCreateFieldErrors({});
    setClientSearch("");
    setClientSearchOpen(false);
    const defaultAccount = resolveDefaultPaymentAccount(paymentAccounts, "JMD");
    const nextForm = {
      ...initialForm,
      issue_date: localToday(),
      client_id: requestedClientId,
      case_id: requestedCaseId,
      payment_account_id: defaultAccount ? String(defaultAccount.id) : "",
      payment_instructions: buildPaymentInstructions(defaultAccount),
    };
    setForm(nextForm);
    setCreateInitialForm(nextForm);
    setCreateOpen(true);
  }

  function closeCreateModal() {
    setCreateOpen(false);
    setCreateError("");
    setCreateFieldErrors({});
    setClientSearch("");
    setClientSearchOpen(false);
    setTimeEntryError("");
    const defaultAccount = resolveDefaultPaymentAccount(paymentAccounts, "JMD");
    const nextForm = {
      ...initialForm,
      issue_date: localToday(),
      client_id: requestedClientId,
      case_id: requestedCaseId,
      payment_account_id: defaultAccount ? String(defaultAccount.id) : "",
      payment_instructions: buildPaymentInstructions(defaultAccount),
    };
    setForm(nextForm);
    setCreateInitialForm(nextForm);
    if (searchParams.get("create") === "1") {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("create");
      const next = params.toString();
      router.replace(next ? `/dashboard/invoices?${next}` : "/dashboard/invoices");
    }
  }

  function addManualLineItem() {
    setForm((current) => ({
      ...current,
      line_items: [...current.line_items, makeManualLineItem()],
    }));
  }

  function addTimeEntryLine(entry) {
    setForm((current) => ({
      ...current,
      line_items: [...current.line_items, createTimeEntryLine(entry)],
    }));
  }

  function removeLineItem(index) {
    setForm((current) => ({
      ...current,
      line_items: current.line_items.length === 1 ? current.line_items : current.line_items.filter((_, rowIndex) => rowIndex !== index),
    }));
  }

  function updateLineItem(index, patch) {
    setForm((current) => {
      const next = [...current.line_items];
      const updated = { ...next[index], ...patch };
      if (!updated.time_entry_id) {
        updated.amount = calculateLineAmount(updated.quantity, updated.unit_price);
      }
      next[index] = updated;
      return { ...current, line_items: next };
    });
  }

  function selectInvoiceClient(client) {
    setForm((current) => ({
      ...current,
      client_id: String(client.id),
      manual_client_name: "",
      case_id: "",
      line_items: [makeManualLineItem()],
    }));
    setClientSearch(client.name || "");
    setClientSearchOpen(false);
    setCreateFieldErrors((current) => ({ ...current, client_id: undefined, manual_client_name: undefined }));
  }

  function useManualInvoiceRecipient() {
    const name = clientSearch.trim();
    if (!name) return;
    setForm((current) => ({
      ...current,
      client_id: "",
      manual_client_name: name,
      case_id: "",
      line_items: current.line_items.filter((item) => !item.time_entry_id).length
        ? current.line_items.filter((item) => !item.time_entry_id)
        : [makeManualLineItem()],
    }));
    setClientSearchOpen(false);
    setCreateFieldErrors((current) => ({ ...current, client_id: undefined, manual_client_name: undefined, case_id: undefined }));
  }

  function handleClientSearchKeyDown(event) {
    const optionCount = clientResults.length + (clientSearch.trim() ? 1 : 0);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setClientSearchOpen(true);
      setActiveClientIndex((current) => Math.min(current + 1, optionCount - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveClientIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && clientSearchOpen && activeClientIndex >= 0) {
      event.preventDefault();
      if (activeClientIndex < clientResults.length) selectInvoiceClient(clientResults[activeClientIndex]);
      else useManualInvoiceRecipient();
    } else if (event.key === "Escape") {
      setClientSearchOpen(false);
    }
  }

  async function refreshTimeEntries() {
    if (!form.case_id) return;
    setLoadingTimeEntries(true);
    setTimeEntryError("");
    try {
      const rows = await apiRequest(`/api/v1/time-entries?case_id=${form.case_id}&status=billable&page=1&per_page=100&sort_by=newest`);
      const selectedIds = new Set((form.line_items || []).map((item) => item.time_entry_id).filter(Boolean));
      setBillableEntries(asArray(rows?.items).filter((entry) => !selectedIds.has(entry.id)));
    } catch (err) {
      setTimeEntryError(err.message || "Failed to load billable time entries.");
    } finally {
      setLoadingTimeEntries(false);
    }
  }

  async function markSent(id) {
    setError("");
    try {
      await apiRequest(`/api/v1/invoices/${id}/mark-sent`, { method: "PATCH" });
      await load();
    } catch (err) {
      setError(err.message || "Failed to mark invoice as sent");
    }
  }

  async function markPaid(id) {
    setError("");
    try {
      await apiRequest(`/api/v1/invoices/${id}/mark-paid`, { method: "PATCH" });
      await load();
    } catch (err) {
      setError(err.message || "Failed to mark invoice as paid");
    }
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (saving) return;
    const { payload, errors } = normalizeInvoicePayload(form, billingTax.invoice_tax_rate);
    setCreateFieldErrors(errors);
    if (Object.keys(errors).length) {
      setCreateError("Please correct the highlighted invoice fields.");
      return;
    }

    setSaving(true);
    setCreateError("");
    try {
      const created = await apiRequest("/api/v1/invoices", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      closeCreateModal();
      await load();
      router.push(`/dashboard/invoices/${created.id}`);
    } catch (err) {
      const backendErrors = invoiceErrorsByField(err.errors);
      setCreateFieldErrors(backendErrors);
      if (Number(err.status || 0) >= 500) {
        setCreateError("Invoice could not be created because of a server error. Please try again or contact support.");
      } else {
        setCreateError(!err.message || err.message === "Request failed"
          ? "Invoice could not be created. Please review the highlighted fields and try again."
          : err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleVoidInvoice(event) {
    event.preventDefault();
    if (!voidingInvoice || !voidReason.trim()) {
      setError("Void reason is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiRequest(`/api/v1/invoices/${voidingInvoice.id}/void`, {
        method: "POST",
        body: JSON.stringify({ void_reason: voidReason.trim() }),
      });
      setVoidingInvoice(null);
      setVoidReason("");
      await load();
    } catch (err) {
      setError(err.message || "Failed to void invoice.");
    } finally {
      setSaving(false);
    }
  }

  const financialSummary = useMemo(() => {
    const subtotal = (form.line_items || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const taxRate = Number(billingTax.invoice_tax_rate || 0);
    const taxAmount = subtotal * (taxRate / 100);
    return {
      subtotal,
      taxAmount,
      total: subtotal + taxAmount,
    };
  }, [billingTax.invoice_tax_rate, form.line_items]);
  const createFormDirty = createOpen && JSON.stringify(form) !== JSON.stringify(createInitialForm);
  const createCloseGuard = useModalCloseGuard({ open: createOpen, isDirty: createFormDirty, isSubmitting: saving, onClose: closeCreateModal });

  return (
    <section className="dashboard-page-stack">
      <div className="invoice-page-top-row">
        <div className="dashboard-page-heading">
          <h1>Invoices</h1>
          <p className="invoice-page-intro">Create, review, and collect earned-fee invoices while keeping trust funds separate until applied.</p>
        </div>
        <div className="invoice-page-actions">
          <Link className="vilo-btn vilo-btn--secondary" href="/dashboard/billing">Billing Hub</Link>
          <button type="button" className="vilo-btn vilo-btn--primary" onClick={openCreateModal} disabled={loading}>Create Invoice</button>
        </div>
      </div>

      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}

      <div className="invoice-summary-grid">
        <article className="dashboard-card invoice-summary-card">
          <span>Total Invoices</span>
          <strong>{items.length}</strong>
        </article>
        <article className="dashboard-card invoice-summary-card">
          <span>Drafts</span>
          <strong>{totals.drafts}</strong>
        </article>
        <article className="dashboard-card invoice-summary-card">
          <span>Sent / Partial</span>
          <strong>{totals.sent}</strong>
        </article>
        <article className="dashboard-card invoice-summary-card">
          <span>Overdue</span>
          <strong>{totals.overdue}</strong>
        </article>
        <article className="dashboard-card invoice-summary-card">
          <span>Outstanding</span>
          <strong>{formatMoney(totals.balance)}</strong>
        </article>
      </div>

      {loading ? <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading invoices...</p></div> : null}

      {!loading && !error && !items.length ? (
        <div className="vilo-state-block">
          <p className="vilo-state">No invoices found yet. Use Create Invoice to start the billing flow.</p>
        </div>
      ) : null}

      {!loading && !error && items.length ? (
        <article className="dashboard-card vilo-table-card">
          <div className="dashboard-card__header"><h2>Invoice List</h2></div>
          <div className="vilo-table-wrap">
            <table className="team-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Client</th>
                  <th>Matter</th>
                  <th>Issue Date</th>
                  <th>Due Date</th>
                  <th>Status</th>
                  <th>Payment Method</th>
                  <th>Payment Account</th>
                  <th>Total</th>
                  <th>Balance</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id}>
                    <td>{row.invoice_number}</td>
                    <td>{row.client?.name || row.manual_client_name || "Manual recipient"}</td>
                    <td>{row.matter_title || (row.case_id ? `Matter #${row.case_id}` : "-")}</td>
                    <td>{formatDate(row.issue_date)}</td>
                    <td>{formatDate(row.due_date)}</td>
                    <td><span className={`vilo-badge vilo-badge--${row.display_status || row.status}`}>{row.display_status || row.status}</span></td>
                    <td>{row.payment_method_summary}</td>
                    <td>{row.payment_account?.account_name || "-"}</td>
                    <td>{formatMoney(row.total, row.currency || "USD")}</td>
                    <td>{formatMoney(row.balance_due, row.currency || "USD")}</td>
                    <td>
                      <div className="vilo-table-actions invoice-row-actions">
                        <button
                          type="button"
                          className="time-entry-actions__trigger"
                          aria-expanded={actionsOpenId === row.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            setActionsOpenId((current) => (current === row.id ? null : row.id));
                          }}
                        >
                          Actions
                        </button>
                        {actionsOpenId === row.id ? (
                          <div className="case-actions-menu invoice-actions-menu" onClick={(event) => event.stopPropagation()}>
                            <Link href={`/dashboard/invoices/${row.id}`}>View</Link>
                            <button type="button" onClick={() => apiDownload(`/api/v1/invoices/${row.id}/pdf`)}>PDF</button>
                            {canManagePayments && row.status === "draft" ? <button type="button" onClick={() => markSent(row.id)}>Send Invoice</button> : null}
                            {canManagePayments && !["paid", "cancelled", "voided"].includes(row.display_status || row.status) ? <button type="button" onClick={() => markPaid(row.id)}>Record Payment</button> : null}
                            {canManagePayments && row.case_id && !["paid", "cancelled", "voided"].includes(row.display_status || row.status) ? <Link href={`/dashboard/invoices/${row.id}?apply_trust=1`}>Apply Trust Funds</Link> : null}
                            {canManagePayments && !["voided", "paid"].includes(row.display_status || row.status) ? <button type="button" className="is-danger" onClick={() => { setVoidingInvoice(row); setVoidReason(""); setActionsOpenId(null); }}>Void Invoice</button> : null}
                          </div>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      ) : null}

      {createOpen ? (
        <div className="vilo-modal-overlay" onClick={createCloseGuard.requestClose}>
          <div className="vilo-modal invoice-create-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header">
              <div>
                <h3>Create Invoice</h3>
                <p className="invoice-modal-copy">Firm billing only. Billable/legal line items belong here; trust deposits and client funds do not.</p>
              </div>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={createCloseGuard.requestClose} disabled={saving}>Close</button>
            </div>
            <form className="invoice-create-shell" onSubmit={handleCreate}>
              <div className="vilo-modal__body invoice-create-form invoice-create-form--scrollable">
                <section className="invoice-form-section">
                  <div className="invoice-form-section__heading"><h4>1. Client + Matter</h4></div>
                  <div className="vilo-form-row-two">
                    <div className="invoice-client-combobox">
                      <label htmlFor="invoice-client-search">Client / Invoice Recipient *</label>
                      <input
                        id="invoice-client-search"
                        type="search"
                        role="combobox"
                        aria-autocomplete="list"
                        aria-controls="invoice-client-options"
                        aria-expanded={clientSearchOpen}
                        aria-activedescendant={activeClientIndex >= 0 ? `invoice-client-option-${activeClientIndex}` : undefined}
                        value={clientSearch}
                        placeholder="Search by name, email, or reference"
                        autoComplete="off"
                        onFocus={() => setClientSearchOpen(true)}
                        onBlur={() => window.setTimeout(() => setClientSearchOpen(false), 150)}
                        onKeyDown={handleClientSearchKeyDown}
                        onChange={(event) => {
                          setClientSearch(event.target.value);
                          setClientSearchOpen(true);
                          setForm((current) => ({ ...current, client_id: "", manual_client_name: "", case_id: "" }));
                        }}
                      />
                      {clientSearchOpen ? (
                        <div className="invoice-client-options" id="invoice-client-options" role="listbox">
                          {clientSearchLoading ? <p className="invoice-client-options__state">Searching clients...</p> : null}
                          {clientSearchError ? <p className="invoice-client-options__state is-error">{clientSearchError}</p> : null}
                          {!clientSearchLoading && !clientSearchError && !clientResults.length ? <p className="invoice-client-options__state">No matching clients.</p> : null}
                          {clientResults.map((client, index) => (
                            <button
                              id={`invoice-client-option-${index}`}
                              key={client.id}
                              type="button"
                              role="option"
                              aria-selected={activeClientIndex === index}
                              className={activeClientIndex === index ? "is-active" : ""}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => selectInvoiceClient(client)}
                            >
                              <strong>{client.name}</strong>
                              <span>{[client.email, client.trn_no ? `Ref: ${client.trn_no}` : null].filter(Boolean).join(" · ") || `Client #${client.id}`}</span>
                            </button>
                          ))}
                          {clientSearch.trim() ? (
                            <button
                              id={`invoice-client-option-${clientResults.length}`}
                              type="button"
                              role="option"
                              aria-selected={activeClientIndex === clientResults.length}
                              className={`invoice-client-options__manual${activeClientIndex === clientResults.length ? " is-active" : ""}`}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={useManualInvoiceRecipient}
                            >
                              <strong>Use “{clientSearch.trim()}” as a manual invoice recipient</strong>
                              <span>Applies to this invoice only; no Client record will be created.</span>
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {form.client_id ? <p className="invoice-recipient-mode">Existing VILO client selected.</p> : null}
                      {form.manual_client_name ? <p className="invoice-recipient-mode is-manual">Manual recipient: <strong>{form.manual_client_name}</strong> · this invoice only.</p> : null}
                      {createFieldErrors.client_id ? <p className="vilo-field-error">{createFieldErrors.client_id}</p> : null}
                      {createFieldErrors.manual_client_name ? <p className="vilo-field-error">{createFieldErrors.manual_client_name}</p> : null}
                    </div>
                    <div>
                      <label>Matter / Case</label>
                      <select disabled={!form.client_id} value={form.case_id} onChange={(event) => setForm((current) => ({ ...current, case_id: event.target.value, line_items: current.line_items.filter((item) => !item.time_entry_id).length ? current.line_items.filter((item) => !item.time_entry_id) : [makeManualLineItem()] }))}>
                        <option value="">{form.manual_client_name ? "Not available for manual recipients" : "No related matter"}</option>
                        {caseOptions.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
                      </select>
                      {createFieldErrors.case_id ? <p className="vilo-field-error">{createFieldErrors.case_id}</p> : null}
                    </div>
                  </div>
                </section>

                <section className="invoice-form-section">
                  <div className="invoice-form-section__heading"><h4>2. Invoice Details</h4></div>
                  <div className="vilo-form-row-two">
                    <div>
                      <label>Invoice Number</label>
                      <input value={form.invoice_number} onChange={(event) => setForm((current) => ({ ...current, invoice_number: event.target.value }))} placeholder="Auto-generate if blank" />
                    </div>
                    <div>
                      <label>Currency *</label>
                      <select value={form.currency} onChange={(event) => setForm((current) => ({ ...current, currency: event.target.value }))} required>
                        <option value="JMD">JMD</option>
                        <option value="USD">USD</option>
                      </select>
                    </div>
                  </div>
                  <div className="vilo-form-row-two">
                    <div>
                      <label>Issue Date *</label>
                      <ViloDateInput value={form.issue_date} onChange={(value) => setForm((current) => ({ ...current, issue_date: value }))} required />
                      {createFieldErrors.issue_date ? <p className="vilo-field-error">{createFieldErrors.issue_date}</p> : null}
                    </div>
                    <div>
                      <label>Due Date</label>
                      <ViloDateInput value={form.due_date} onChange={(value) => setForm((current) => ({ ...current, due_date: value }))} />
                      {createFieldErrors.due_date ? <p className="vilo-field-error">{createFieldErrors.due_date}</p> : null}
                    </div>
                  </div>
                </section>

                <section className="invoice-form-section">
                  <div className="invoice-form-section__heading"><h4>3. Payment Account</h4></div>
                  <label>Payment Account</label>
                  <select value={form.payment_account_id} onChange={(event) => setForm((current) => ({ ...current, payment_account_id: event.target.value }))} disabled={!filteredPaymentAccounts.length}>
                    <option value="">{paymentAccountWarning || "Use default payment account"}</option>
                    {filteredPaymentAccounts.map((account) => <option key={account.id} value={account.id}>{account.account_name} · {account.bank_name}{account.is_default ? " · Default" : ""}</option>)}
                  </select>
                  {createFieldErrors.payment_account_id || createFieldErrors.currency ? <p className="vilo-field-error">{createFieldErrors.payment_account_id || createFieldErrors.currency}</p> : null}
                  {paymentAccountWarning ? (
                    <article className="settings-info-banner invoice-payment-warning">
                      <strong>No payment account configured for this currency.</strong>
                      <span>Add one in Settings before creating this invoice.</span>
                    </article>
                  ) : null}
                </section>

                <section className="invoice-form-section">
                  <div className="invoice-form-section__heading"><h4>4. Payment Instructions</h4></div>
                  <textarea value={form.payment_instructions} readOnly className="invoice-readonly-textarea" />
                </section>

                <section className="invoice-form-section">
                  <div className="invoice-form-section__heading invoice-form-section__heading--with-action">
                    <h4>5. Time Entries</h4>
                    <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={refreshTimeEntries} disabled={!form.case_id || loadingTimeEntries}>Refresh Time Entries</button>
                  </div>
                  <article className="dashboard-card invoice-time-entry-picker">
                    <div className="invoice-line-items-editor__header">
                      <p className="invoice-modal-copy">Imported time entries preserve staff, hours, rate, amount, and currency. Manual rate re-entry is blocked.</p>
                    </div>
                    {!form.case_id ? <p className="vilo-state">Select a matter to load billable time entries.</p> : null}
                    {loadingTimeEntries ? <p className="vilo-state vilo-state--loading">Loading billable time entries...</p> : null}
                    {timeEntryError ? <p className="vilo-state vilo-state--error">{timeEntryError}</p> : null}
                    {!loadingTimeEntries && !timeEntryError && form.case_id && !availableBillableEntries.length ? <p className="vilo-state">No unbilled billable time entries found for this matter.</p> : null}
                    {!!availableBillableEntries.length ? (
                      <div className="vilo-table-wrap">
                        <table className="team-table">
                          <thead>
                            <tr>
                              <th>Staff</th>
                              <th>Description</th>
                              <th>Hours</th>
                              <th>Rate</th>
                              <th>Amount</th>
                              <th>Currency</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {availableBillableEntries.map((entry) => (
                              <tr key={entry.id}>
                                <td>{entry.staff_name || "Staff"}</td>
                                <td>{entry.description || "-"}</td>
                                <td>{entry.duration_minutes ? (Number(entry.duration_minutes) / 60).toFixed(2) : "0.00"}</td>
                                <td>{formatMoney(entry.hourly_rate, entry.currency || form.currency)}</td>
                                <td>{formatMoney(entry.amount, entry.currency || form.currency)}</td>
                                <td>{entry.currency || form.currency}</td>
                                <td><button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={() => addTimeEntryLine(entry)}>Add</button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </article>
                </section>

                <section className="invoice-form-section">
                  <div className="invoice-form-section__heading invoice-form-section__heading--with-action">
                    <h4>6. Line Items</h4>
                    <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={addManualLineItem}>Add Line Item</button>
                  </div>
                  {form.line_items.map((item, index) => (
                    item.time_entry_id ? (
                      <div className="invoice-linked-time-row" key={`line-${index}`}>
                        <div className="invoice-linked-time-row__main">
                          <strong>{item.description}</strong>
                          <span>{item.staff_name || "Staff"} · {item.hours || item.quantity} hrs · {formatMoney(item.rate || item.unit_price, form.currency)}</span>
                        </div>
                        <div className="invoice-linked-time-row__meta">
                          <span>{formatMoney(item.amount, form.currency)}</span>
                          <button type="button" className="invoice-line-remove" onClick={() => removeLineItem(index)}>Remove</button>
                        </div>
                      </div>
                    ) : (
                      <div className="invoice-line-item-row" key={`line-${index}`}>
                        <select aria-label={`Line item ${index + 1} type`} value={item.line_type} onChange={(event) => updateLineItem(index, { line_type: event.target.value })}>
                          {LINE_ITEM_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                        <input aria-label={`Line item ${index + 1} description`} value={item.description} onChange={(event) => updateLineItem(index, { description: event.target.value })} placeholder="Description" />
                        <input aria-label={`Line item ${index + 1} quantity`} type="number" step="0.01" min="0.01" value={item.quantity} onChange={(event) => updateLineItem(index, { quantity: event.target.value })} placeholder="Qty" />
                        <input aria-label={`Line item ${index + 1} unit price`} type="number" step="0.01" min="0" value={item.unit_price} onChange={(event) => updateLineItem(index, { unit_price: event.target.value })} placeholder="Unit price" />
                        <input aria-label={`Line item ${index + 1} amount`} type="text" value={formatMoney(item.amount || 0, form.currency)} readOnly className="invoice-line-item-row__amount" />
                        <button type="button" className="invoice-line-remove" onClick={() => removeLineItem(index)}>Remove</button>
                        {Object.entries(createFieldErrors).filter(([field]) => field.startsWith(`line_items.${index}.`)).map(([field, message]) => <p key={field} className="vilo-field-error invoice-line-item-row__error">{message}</p>)}
                      </div>
                    )
                  ))}
                  {createFieldErrors.line_items ? <p className="vilo-field-error">{createFieldErrors.line_items}</p> : null}
                </section>

                <section className="invoice-form-section">
                  <div className="invoice-form-section__heading"><h4>7. Notes</h4></div>
                  <textarea value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Optional invoice notes" />
                </section>

                <section className="invoice-form-section">
                  <div className="invoice-form-section__heading"><h4>8. Financial Summary</h4></div>
                  <article className="dashboard-card invoice-financial-summary">
                    <div><span>Subtotal</span><strong>{formatMoney(financialSummary.subtotal, form.currency)}</strong></div>
                    <div><span>{billingTax.invoice_tax_label}: {Number(billingTax.invoice_tax_rate || 0).toFixed(2)}% from firm billing settings</span><strong>{formatMoney(financialSummary.taxAmount, form.currency)}</strong></div>
                    <div><span>Total</span><strong>{formatMoney(financialSummary.total, form.currency)}</strong></div>
                  </article>
                </section>

                <section className="invoice-form-section invoice-form-section--trust">
                  <div className="invoice-form-section__heading"><h4>9. Trust Information</h4></div>
                  <article className="dashboard-card invoice-trust-banner invoice-trust-banner--create">
                    <div>
                      <strong>Available matter trust balance</strong>
                      <span>{loadingTrustBalance ? "Loading..." : formatMoney(matterTrustBalance || 0, form.currency)}</span>
                    </div>
                    <p>Trust funds stay separate from earned-fee revenue and can be applied only after this invoice is created.</p>
                    {trustBalanceError ? <p className="vilo-state vilo-state--error">{trustBalanceError}</p> : null}
                  </article>
                </section>

                {createError ? (
                  <div className="invoice-validation-summary" role="alert">
                    <strong>{createError}</strong>
                    {Object.entries(createFieldErrors).length ? (
                      <ul>{Object.entries(createFieldErrors).map(([field, message]) => <li key={field}>{message}</li>)}</ul>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="vilo-modal__footer invoice-create-footer">
                <div className="vilo-table-actions invoice-create-actions">
                  <button className="vilo-btn vilo-btn--secondary" type="button" onClick={createCloseGuard.requestClose} disabled={saving}>Cancel</button>
                  <button className="vilo-btn vilo-btn--primary" type="submit" disabled={saving}>{saving ? "Creating..." : "Create Invoice"}</button>
                </div>
              </div>
            </form>
          </div>
          <DiscardChangesDialog open={createCloseGuard.confirmDiscard} onKeepEditing={createCloseGuard.keepEditing} onDiscard={createCloseGuard.discard} />
        </div>
      ) : null}

      {voidingInvoice ? (
        <div className="vilo-modal-overlay" onClick={() => { setVoidingInvoice(null); setVoidReason(""); }}>
          <div className="vilo-modal invoice-finance-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header">
              <div>
                <h3>Void Invoice</h3>
                <p className="invoice-modal-copy">Voiding keeps the invoice record but removes it from active receivables. This cannot be used to delete records.</p>
              </div>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => { setVoidingInvoice(null); setVoidReason(""); }}>Close</button>
            </div>
            <form className="vilo-modal__body invoice-create-form" onSubmit={handleVoidInvoice}>
              <p className="vilo-card-copy">Invoice <strong>{voidingInvoice.invoice_number}</strong> will remain on record and be marked voided.</p>
              <textarea value={voidReason} onChange={(event) => setVoidReason(event.target.value)} placeholder="Reason for voiding this invoice" required />
              <div className="vilo-table-actions invoice-create-actions">
                <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => { setVoidingInvoice(null); setVoidReason(""); }}>Cancel</button>
                <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving || !voidReason.trim()}>{saving ? "Voiding..." : "Void Invoice"}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
