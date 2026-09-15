"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { getCachedUser, setCachedUser } from "../../../../lib/auth";
import { apiDownload, apiRequest } from "../../../../lib/api";
import { formatViloDate } from "../../../../lib/dateFormat";
import ViloDateInput from "../../../../components/ViloDateInput";

const LINE_ITEM_TYPE_OPTIONS = [
  ["legal_fee", "Legal Fee"],
  ["hourly_work", "Hourly Work"],
  ["flat_fee", "Flat Fee"],
  ["disbursement", "Disbursement"],
  ["expense", "Expense"],
  ["approved_billable_expense", "Approved Billable Expense"],
];

const initialBillingTax = {
  invoice_tax_label: "GCT",
  invoice_tax_rate: "0.00",
};

function roleCanManage(role) {
  return role === "partner" || role === "admin";
}

function formatMoney(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value || 0));
}

function formatDate(value) {
  return formatViloDate(value);
}

function invoiceCurrency(invoice) {
  return invoice?.payments?.[0]?.currency || invoice?.currency || "USD";
}

function renderFirmLines(organization) {
  const lines = [organization?.name || "Firm"];
  if (organization?.address) lines.push(organization.address);
  if (organization?.email) lines.push(organization.email);
  if (organization?.phone) lines.push(organization.phone);
  if (organization?.tax_number) lines.push(`Tax / TRN: ${organization.tax_number}`);
  return lines;
}

function resolveDefaultPaymentAccount(accounts, currency) {
  return (accounts || []).find((account) => account.currency === currency && account.is_default && account.is_active)
    || (accounts || []).find((account) => account.currency === currency && account.is_active)
    || null;
}

function buildPaymentInstructions(account) {
  if (!account) return "";
  return [
    account.bank_name ? `Bank: ${account.bank_name}` : null,
    account.account_name ? `Account Name: ${account.account_name}` : null,
    account.account_number ? `Account Number: ${account.account_number}` : null,
    account.swift_routing ? `Routing Number / SWIFT: ${account.swift_routing}` : null,
    account.notes ? `Notes: ${account.notes}` : null,
  ].filter(Boolean).join("\n");
}

function calculateLineAmount(quantity, unitPrice) {
  const qty = Number(quantity || 0);
  const price = Number(unitPrice || 0);
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return "0.00";
  return (qty * price).toFixed(2);
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
    staff_user_id: entry.user_id || null,
    staff_name: entry.staff_name || "Staff",
  };
}

function EmptyState({ message, error = false }) {
  return (
    <div className="vilo-state-block">
      <p className={error ? "vilo-state vilo-state--error" : "vilo-state"}>{message}</p>
    </div>
  );
}

function Modal({ title, copy, onClose, children }) {
  return (
    <div className="vilo-modal-overlay" onClick={onClose}>
      <div className="vilo-modal invoice-finance-modal" onClick={(event) => event.stopPropagation()}>
        <div className="vilo-modal__header">
          <div>
            <h3>{title}</h3>
            {copy ? <p className="invoice-modal-copy">{copy}</p> : null}
          </div>
          <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={onClose}>Close</button>
        </div>
        <div className="vilo-modal__body">{children}</div>
      </div>
    </div>
  );
}

function InvoiceDetailInner() {
  const { id } = useParams();
  const searchParams = useSearchParams();
  const [currentUser, setCurrentUser] = useState(getCachedUser());
  const [invoice, setInvoice] = useState(null);
  const [trustAccounts, setTrustAccounts] = useState([]);
  const [paymentAccounts, setPaymentAccounts] = useState([]);
  const [billingTax, setBillingTax] = useState(initialBillingTax);
  const [cases, setCases] = useState([]);
  const [team, setTeam] = useState([]);
  const [billableEntries, setBillableEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingTimeEntries, setLoadingTimeEntries] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [timeEntryError, setTimeEntryError] = useState("");
  const [modal, setModal] = useState("");
  const [selectedPayment, setSelectedPayment] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [applyForm, setApplyForm] = useState({
    amount: "",
    trust_account_id: "",
    payment_date: "",
    external_reference_number: "",
    description: "",
  });
  const [voidReason, setVoidReason] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);

  const requestedApplyTrust = searchParams.get("apply_trust") === "1";

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

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [invoiceRow, trustRows, accountRows, caseRows, teamRows, taxSettings] = await Promise.all([
        apiRequest(`/api/v1/invoices/${id}`),
        apiRequest("/api/v1/trust/accounts").catch(() => []),
        apiRequest("/api/v1/settings/payment-accounts").catch(() => []),
        apiRequest("/api/v1/cases").catch(() => []),
        apiRequest("/api/v1/team").catch(() => []),
        apiRequest("/api/v1/settings/billing-tax").catch(() => initialBillingTax),
      ]);
      setInvoice(invoiceRow);
      setTrustAccounts(trustRows || []);
      setPaymentAccounts(accountRows || []);
      setBillingTax(taxSettings || initialBillingTax);
      setCases(caseRows || []);
      setTeam((teamRows || []).filter((row) => row.role !== "client"));
    } catch (err) {
      setError(err.message || "Failed to load invoice.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!id) return;
    load();
  }, [id]);

  useEffect(() => {
    const closeMenus = () => setActionsOpen(false);
    window.addEventListener("click", closeMenus);
    return () => window.removeEventListener("click", closeMenus);
  }, []);

  const canManage = roleCanManage(currentUser?.role || "");
  const firmLines = useMemo(() => renderFirmLines(invoice?.organization), [invoice?.organization]);
  const activePayments = useMemo(() => (invoice?.payments || []).filter((row) => !row.voided_at), [invoice?.payments]);
  const currency = invoiceCurrency(invoice);
  const eligibleTrustAccounts = useMemo(
    () => trustAccounts.filter((row) => (row.currency || "USD").toUpperCase() === currency.toUpperCase()),
    [currency, trustAccounts],
  );
  const filteredPaymentAccounts = useMemo(
    () => paymentAccounts.filter((row) => row.currency === (editForm?.currency || invoice?.currency || "USD") && row.is_active),
    [editForm?.currency, invoice?.currency, paymentAccounts],
  );
  const canApplyTrust = Boolean(
    canManage
      && invoice
      && invoice.balance_due > 0
      && Number(invoice.trust_balance_available || 0) > 0
      && !["paid", "cancelled", "voided"].includes(invoice.display_status || invoice.status),
  );
  const availableBillableEntries = useMemo(() => {
    if (!editForm) return [];
    const selectedIds = new Set((editForm.line_items || []).map((item) => item.time_entry_id).filter(Boolean));
    return (billableEntries || []).filter(
      (entry) => (entry.currency || "USD") === (editForm.currency || "USD") && !selectedIds.has(entry.id),
    );
  }, [billableEntries, editForm]);

  useEffect(() => {
    if (!invoice) return;
    setEditForm({
      client_id: String(invoice.client_id || ""),
      manual_client_name: invoice.manual_client_name || "",
      case_id: String(invoice.case_id || ""),
      invoice_number: invoice.invoice_number || "",
      currency: invoice.currency || currency,
      issue_date: invoice.issue_date || "",
      due_date: invoice.due_date || "",
      notes: invoice.notes || "",
      payment_instructions: invoice.payment_instructions || "",
      payment_account_id: invoice.payment_account_id ? String(invoice.payment_account_id) : "",
      line_items: (invoice.line_items || []).map((line) => ({
        line_type: line.line_type,
        description: line.description,
        quantity: String(line.quantity),
        unit_price: String(line.unit_price),
        amount: String(line.amount),
        time_entry_id: line.time_entry_id || null,
        hours: line.hours ? String(line.hours) : "",
        rate: line.rate ? String(line.rate) : "",
        staff_user_id: line.staff_user_id || null,
        staff_name: team.find((user) => Number(user.id) === Number(line.staff_user_id))?.name || null,
      })),
    });
  }, [currency, invoice, team]);

  useEffect(() => {
    if (!invoice) return;
    const defaultAccount = eligibleTrustAccounts[0]?.id ? String(eligibleTrustAccounts[0].id) : "";
    setApplyForm((current) => ({
      ...current,
      trust_account_id: current.trust_account_id || defaultAccount,
      payment_date: current.payment_date || new Date().toISOString().slice(0, 10),
      description: current.description || `Applied trust funds to Invoice ${invoice.invoice_number}`,
    }));
  }, [eligibleTrustAccounts, invoice]);

  useEffect(() => {
    if (!editForm) return;
    const currentStillValid = filteredPaymentAccounts.some((account) => Number(account.id) === Number(editForm.payment_account_id || 0));
    const defaultAccount = resolveDefaultPaymentAccount(paymentAccounts, editForm.currency || "USD");
    const resolvedAccount = currentStillValid
      ? filteredPaymentAccounts.find((account) => Number(account.id) === Number(editForm.payment_account_id || 0))
      : defaultAccount;
    setEditForm((current) => current ? ({
      ...current,
      payment_account_id: currentStillValid ? current.payment_account_id : defaultAccount ? String(defaultAccount.id) : "",
      payment_instructions: buildPaymentInstructions(resolvedAccount),
    }) : current);
  }, [editForm?.currency, filteredPaymentAccounts, paymentAccounts]);

  useEffect(() => {
    if (requestedApplyTrust && invoice && canApplyTrust) {
      setFormError("");
      setModal("apply_trust");
    }
  }, [requestedApplyTrust, invoice, canApplyTrust]);

  useEffect(() => {
    if (modal !== "edit_invoice" || !editForm?.case_id) {
      setBillableEntries([]);
      return;
    }
    let cancelled = false;
    async function loadBillableEntries() {
      setLoadingTimeEntries(true);
      setTimeEntryError("");
      try {
        const rows = await apiRequest(`/api/v1/time-entries?case_id=${editForm.case_id}&status=billable&page=1&per_page=100&sort_by=newest`);
        if (cancelled) return;
        setBillableEntries(rows.items || []);
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
  }, [editForm?.case_id, modal]);

  function closeModal() {
    setModal("");
    setSelectedPayment(null);
    setVoidReason("");
    setFormError("");
    setTimeEntryError("");
  }

  function addManualLineItem() {
    setEditForm((current) => current ? ({
      ...current,
      line_items: [...current.line_items, { line_type: "legal_fee", description: "", quantity: "1", unit_price: "", amount: "", time_entry_id: null }],
    }) : current);
  }

  function addTimeEntryLine(entry) {
    setEditForm((current) => current ? ({
      ...current,
      line_items: [...current.line_items, createTimeEntryLine(entry)],
    }) : current);
  }

  function updateLineItem(index, patch) {
    setEditForm((current) => {
      if (!current) return current;
      const next = [...current.line_items];
      const updated = { ...next[index], ...patch };
      if (!updated.time_entry_id) updated.amount = calculateLineAmount(updated.quantity, updated.unit_price);
      next[index] = updated;
      return { ...current, line_items: next };
    });
  }

  function removeLineItem(index) {
    setEditForm((current) => {
      if (!current) return current;
      return {
        ...current,
        line_items: current.line_items.length === 1 ? current.line_items : current.line_items.filter((_, rowIndex) => rowIndex !== index),
      };
    });
  }

  async function markSent() {
    setError("");
    try {
      await apiRequest(`/api/v1/invoices/${id}/mark-sent`, { method: "PATCH" });
      await load();
    } catch (err) {
      setError(err.message || "Failed to mark invoice as sent.");
    }
  }

  async function submitDirectPayment(event) {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      await apiRequest(`/api/v1/invoices/${id}/mark-paid`, { method: "PATCH" });
      closeModal();
      await load();
    } catch (err) {
      setFormError(err.message || "Failed to record direct payment.");
    } finally {
      setSaving(false);
    }
  }

  async function submitApplyTrust(event) {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      await apiRequest(`/api/v1/invoices/${id}/apply-trust`, {
        method: "POST",
        body: JSON.stringify({
          amount: Number(applyForm.amount),
          trust_account_id: applyForm.trust_account_id ? Number(applyForm.trust_account_id) : null,
          payment_date: applyForm.payment_date || null,
          external_reference_number: applyForm.external_reference_number || null,
          description: applyForm.description || null,
        }),
      });
      closeModal();
      setApplyForm((current) => ({ ...current, amount: "", external_reference_number: "" }));
      await load();
    } catch (err) {
      setFormError(err.message || "Failed to apply trust funds.");
    } finally {
      setSaving(false);
    }
  }

  async function submitVoidPayment(event) {
    event.preventDefault();
    if (!selectedPayment) return;
    setSaving(true);
    setFormError("");
    try {
      await apiRequest(`/api/v1/invoices/${id}/payments/${selectedPayment.id}/void`, {
        method: "POST",
        body: JSON.stringify({ void_reason: voidReason }),
      });
      closeModal();
      await load();
    } catch (err) {
      setFormError(err.message || "Failed to void invoice payment.");
    } finally {
      setSaving(false);
    }
  }

  async function submitEditInvoice(event) {
    event.preventDefault();
    if (!editForm.payment_account_id) {
      setFormError("Payment account is required for this invoice currency.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      await apiRequest(`/api/v1/invoices/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          client_id: editForm.client_id ? Number(editForm.client_id) : null,
          manual_client_name: editForm.manual_client_name?.trim() || null,
          case_id: editForm.case_id ? Number(editForm.case_id) : null,
          invoice_number: editForm.invoice_number || null,
          currency: editForm.currency,
          issue_date: editForm.issue_date,
          due_date: editForm.due_date || null,
          notes: editForm.notes || null,
          payment_instructions: editForm.payment_instructions || null,
          payment_account_id: Number(editForm.payment_account_id),
          line_items: (editForm.line_items || []).filter((line) => line.time_entry_id || line.description.trim()).map((line) => (
            line.time_entry_id
              ? {
                  line_type: line.line_type,
                  description: line.description.trim() || "Time entry",
                  time_entry_id: Number(line.time_entry_id),
                }
              : {
                  line_type: line.line_type,
                  description: line.description.trim(),
                  quantity: Number(line.quantity || 0),
                  unit_price: Number(line.unit_price || 0),
                  amount: Number(calculateLineAmount(line.quantity, line.unit_price)),
                }
          )),
        }),
      });
      closeModal();
      await load();
    } catch (err) {
      setFormError(err.message || "Failed to update invoice.");
    } finally {
      setSaving(false);
    }
  }

  async function submitVoidInvoice(event) {
    event.preventDefault();
    if (!voidReason.trim()) {
      setFormError("Void reason is required.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      await apiRequest(`/api/v1/invoices/${id}/void`, {
        method: "POST",
        body: JSON.stringify({ void_reason: voidReason.trim() }),
      });
      closeModal();
      await load();
    } catch (err) {
      setFormError(err.message || "Failed to void invoice.");
    } finally {
      setSaving(false);
    }
  }

  if (error && !invoice) return <EmptyState message={error} error />;
  if (loading && !invoice) return <EmptyState message="Loading invoice..." />;
  if (!invoice) return <EmptyState message="Invoice not found." error />;

  return (
    <section className="dashboard-page-stack invoice-finance-page">
      <div className="invoice-detail-top-row">
        <div>
          <h1>Invoice {invoice.invoice_number}</h1>
          <p><Link href="/dashboard/invoices">Invoices</Link> &gt; Invoice Detail</p>
        </div>
        <div className="invoice-page-actions">
          <div className="vilo-table-actions invoice-row-actions">
            <button
              type="button"
              className="time-entry-actions__trigger"
              aria-expanded={actionsOpen}
              onClick={(event) => {
                event.stopPropagation();
                setActionsOpen((current) => !current);
              }}
            >
              Actions
            </button>
            {actionsOpen ? (
              <div className="case-actions-menu invoice-actions-menu" onClick={(event) => event.stopPropagation()}>
                <button type="button" onClick={() => apiDownload(`/api/v1/invoices/${id}/pdf`)}>PDF</button>
                {invoice.status === "draft" ? <button type="button" onClick={markSent}>Send Invoice</button> : null}
                {canManage ? <button type="button" onClick={() => { setFormError(""); setModal("edit_invoice"); setActionsOpen(false); }}>Edit Invoice</button> : null}
                {canManage && invoice.balance_due > 0 && !["paid", "cancelled", "voided"].includes(invoice.display_status || invoice.status) ? <button type="button" onClick={() => { setFormError(""); setModal("direct_payment"); setActionsOpen(false); }}>Record Payment</button> : null}
                {canApplyTrust ? <button type="button" onClick={() => { setFormError(""); setModal("apply_trust"); setActionsOpen(false); }}>Apply Trust Funds</button> : null}
                {canManage && !activePayments.length && !["voided", "paid"].includes(invoice.display_status || invoice.status) ? <button type="button" className="is-danger" onClick={() => { setFormError(""); setModal("void_invoice"); setActionsOpen(false); }}>Void Invoice</button> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <EmptyState message={error} error /> : null}

      <article className="dashboard-card invoice-hero-card">
        <div className="invoice-hero-grid">
          <div className="invoice-party-card">
            <span className="invoice-party-label">Firm Details</span>
            {firmLines.map((line) => <strong key={line}>{line}</strong>)}
          </div>
          <div className="invoice-party-card">
            <span className="invoice-party-label">Bill To</span>
            <strong>{invoice.client?.name || invoice.manual_client_name || "Manual recipient"}</strong>
            {invoice.client?.address ? <span>{invoice.client.address}</span> : null}
            {invoice.client?.email ? <span>{invoice.client.email}</span> : null}
            {invoice.client?.phone ? <span>{invoice.client.phone}</span> : null}
          </div>
          <div className="invoice-party-card">
            <span className="invoice-party-label">Invoice Status</span>
            <strong><span className={`vilo-badge vilo-badge--${invoice.display_status || invoice.status}`}>{invoice.display_status || invoice.status}</span></strong>
            <span>Issue Date: {formatDate(invoice.issue_date)}</span>
            <span>Due Date: {formatDate(invoice.due_date)}</span>
            <span>Matter: {invoice.matter_title || (invoice.case_id ? `#${invoice.case_id}` : "Not linked")}</span>
            <span>Payment Method: {invoice.payment_method_summary}</span>
            {invoice.void_reason ? <span>Void Reason: {invoice.void_reason}</span> : null}
          </div>
        </div>
      </article>

      <div className="invoice-summary-grid">
        <article className="dashboard-card invoice-summary-card">
          <span>Subtotal</span>
          <strong>{formatMoney(invoice.subtotal, currency)}</strong>
        </article>
        <article className="dashboard-card invoice-summary-card">
          <span>{billingTax.invoice_tax_label} / Tax</span>
          <strong>{formatMoney(invoice.tax_amount, currency)}</strong>
        </article>
        <article className="dashboard-card invoice-summary-card">
          <span>Paid Amount</span>
          <strong>{formatMoney(invoice.paid_amount, currency)}</strong>
        </article>
        <article className="dashboard-card invoice-summary-card">
          <span>Balance Due</span>
          <strong>{formatMoney(invoice.balance_due, currency)}</strong>
        </article>
      </div>

      <article className="dashboard-card invoice-payment-account-panel">
        <div className="dashboard-card__header">
          <div>
            <h2>Payment Account</h2>
            <p className="settings-copy">Displayed on invoices only. Changing this does not affect accounting, revenue, trust, or payment records.</p>
          </div>
        </div>
        {invoice.payment_account ? (
          <div className="invoice-payment-account-preview__grid">
            <span><strong>Bank:</strong> {invoice.payment_account.bank_name}</span>
            <span><strong>Account Name:</strong> {invoice.payment_account.account_name}</span>
            <span><strong>Account Number:</strong> {invoice.payment_account.account_number}</span>
            <span><strong>Currency:</strong> {invoice.payment_account.currency}</span>
            {invoice.payment_account.swift_routing ? <span><strong>SWIFT / Routing:</strong> {invoice.payment_account.swift_routing}</span> : null}
            {invoice.payment_account.notes ? <span><strong>Notes:</strong> {invoice.payment_account.notes}</span> : null}
          </div>
        ) : <p className="vilo-state">No payment account selected for this invoice.</p>}
        {invoice.payment_instructions ? <p className="vilo-card-copy invoice-payment-account-panel__instructions">{invoice.payment_instructions}</p> : null}
      </article>

      <article className="dashboard-card invoice-trust-banner">
        <strong>Client Trust Balance (Matter): {formatMoney(invoice.trust_balance_available || 0, currency)}</strong>
        <span>This balance is informational only and does not affect this invoice until Apply Trust Funds is used.</span>
        <p>Only funds held for this same client and matter can be applied. Trust deposits themselves are not invoice items or firm revenue.</p>
      </article>

      <article className="dashboard-card vilo-table-card">
        <div className="dashboard-card__header"><h2>Line Items</h2></div>
        {invoice.line_items.length ? (
          <div className="vilo-table-wrap">
            <table className="team-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Staff</th>
                  <th>Hours / Qty</th>
                  <th>Rate / Unit</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.line_items.map((line) => {
                  const staffName = team.find((user) => Number(user.id) === Number(line.staff_user_id))?.name;
                  return (
                    <tr key={line.id}>
                      <td>{line.line_type}</td>
                      <td>{line.description}</td>
                      <td>{staffName || (line.staff_user_id ? `Staff #${line.staff_user_id}` : "-")}</td>
                      <td>{line.hours || line.quantity}</td>
                      <td>{formatMoney(line.rate || line.unit_price, currency)}</td>
                      <td>{formatMoney(line.amount, currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <EmptyState message="This invoice has no line items yet." />}
      </article>

      <article className="dashboard-card vilo-table-card">
        <div className="dashboard-card__header"><h2>Payment History</h2></div>
        {!invoice.payments?.length ? <EmptyState message="This invoice has no payments yet." /> : (
          <div className="vilo-table-wrap">
            <table className="team-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Amount</th>
                  <th>Reference</th>
                  <th>Status</th>
                  <th>Links</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {invoice.payments.map((payment) => (
                  <tr key={payment.id} className={payment.voided_at ? "invoice-payment-row invoice-payment-row--voided" : "invoice-payment-row"}>
                    <td>{formatDate(payment.paid_at)}</td>
                    <td>{payment.payment_source === "trust" ? "Trust Transfer" : "Direct Payment"}</td>
                    <td>{formatMoney(payment.amount, payment.currency || currency)}</td>
                    <td>{payment.reference_number || "-"}</td>
                    <td>
                      <span className={`vilo-badge trust-status-badge trust-status-badge--${payment.voided_at ? "voided" : "active"}`}>{payment.voided_at ? "voided" : "active"}</span>
                      {payment.void_reason ? <div className="invoice-payment-note">Reason: {payment.void_reason}</div> : null}
                    </td>
                    <td className="invoice-payment-links">
                      {payment.linked_trust_transaction_id ? <span>Trust #{payment.linked_trust_transaction_id}</span> : null}
                      {payment.linked_operating_transaction_id ? <span>Operating #{payment.linked_operating_transaction_id}</span> : null}
                    </td>
                    <td>
                      {canManage && !payment.voided_at ? <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={() => { setSelectedPayment(payment); setVoidReason(""); setFormError(""); setModal("void_payment"); }}>Void</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      {invoice.notes ? (
        <article className="dashboard-card vilo-detail-card">
          <div className="dashboard-card__header"><h2>Notes</h2></div>
          <p className="vilo-card-copy">{invoice.notes}</p>
        </article>
      ) : null}

      {modal === "edit_invoice" && editForm ? (
        <Modal title="Edit Invoice" copy="Billable/legal line items only. Trust deposits and client funds remain outside the invoice." onClose={closeModal}>
          {formError ? <p className="vilo-state vilo-state--error trust-modal__error">{formError}</p> : null}
          <form className="vilo-form-grid" onSubmit={submitEditInvoice}>
            <div className="vilo-form-row-two">
              <input value={editForm.invoice_number} onChange={(event) => setEditForm((current) => ({ ...current, invoice_number: event.target.value }))} placeholder="Invoice number" />
              <select value={editForm.currency} onChange={(event) => setEditForm((current) => ({ ...current, currency: event.target.value }))}>
                <option value="USD">USD</option>
                <option value="JMD">JMD</option>
              </select>
            </div>

            <div className="vilo-form-row-two">
              <select value={editForm.case_id} onChange={(event) => {
                const nextCaseId = event.target.value;
                const caseRow = cases.find((row) => Number(row.id) === Number(nextCaseId));
                setEditForm((current) => current ? ({
                  ...current,
                  case_id: nextCaseId,
                  client_id: caseRow ? String(caseRow.client_id) : current.client_id,
                  line_items: current.line_items.filter((line) => !line.time_entry_id).length ? current.line_items.filter((line) => !line.time_entry_id) : [{ line_type: "legal_fee", description: "", quantity: "1", unit_price: "", amount: "", time_entry_id: null }],
                }) : current);
              }}>
                <option value="">Select matter</option>
                {cases.filter((row) => Number(row.client_id) === Number(editForm.client_id)).map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
              </select>
              <select value={editForm.payment_account_id} onChange={(event) => {
                const account = filteredPaymentAccounts.find((row) => Number(row.id) === Number(event.target.value));
                setEditForm((current) => current ? ({
                  ...current,
                  payment_account_id: event.target.value,
                  payment_instructions: buildPaymentInstructions(account),
                }) : current);
              }}>
                <option value="">{filteredPaymentAccounts.length ? "Select payment account" : "No payment account configured for this currency"}</option>
                {filteredPaymentAccounts.map((account) => <option key={account.id} value={account.id}>{account.account_name} · {account.bank_name}{account.is_default ? " · Default" : ""}</option>)}
              </select>
            </div>

            <div className="vilo-form-row-two">
              <ViloDateInput value={editForm.issue_date} onChange={(value) => setEditForm((current) => ({ ...current, issue_date: value }))} required />
              <ViloDateInput value={editForm.due_date} onChange={(value) => setEditForm((current) => ({ ...current, due_date: value }))} />
            </div>
            <div className="vilo-form-row-two">
              <input value={editForm.client_id ? `Client #${editForm.client_id}` : editForm.manual_client_name || "Manual recipient"} readOnly placeholder="Invoice recipient" />
              <input value={`${billingTax.invoice_tax_label}: ${Number(billingTax.invoice_tax_rate || 0).toFixed(2)}% from firm billing settings`} readOnly />
            </div>

            {!filteredPaymentAccounts.length ? (
              <article className="settings-info-banner invoice-payment-warning">
                <strong>No payment account configured for this currency.</strong>
                <span>Add one in Settings before saving this invoice.</span>
              </article>
            ) : null}

            <textarea value={editForm.payment_instructions} readOnly className="invoice-readonly-textarea" />

            <article className="dashboard-card invoice-time-entry-picker">
              <div className="invoice-line-items-editor__header">
                <div>
                  <label>Add Billable Time Entries</label>
                  <p className="invoice-modal-copy">Imported time entries preserve their staff, hours, rate, and line total.</p>
                </div>
              </div>
              {loadingTimeEntries ? <p className="vilo-state vilo-state--loading">Loading billable time entries...</p> : null}
              {timeEntryError ? <p className="vilo-state vilo-state--error">{timeEntryError}</p> : null}
              {!loadingTimeEntries && !timeEntryError && !availableBillableEntries.length ? <p className="vilo-state">No unbilled billable time entries found for this matter.</p> : null}
              {!!availableBillableEntries.length ? (
                <div className="vilo-table-wrap">
                  <table className="team-table">
                    <thead>
                      <tr>
                        <th>Staff</th>
                        <th>Description</th>
                        <th>Hours</th>
                        <th>Rate</th>
                        <th>Total</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {availableBillableEntries.map((entry) => (
                        <tr key={entry.id}>
                          <td>{entry.staff_name || "Staff"}</td>
                          <td>{entry.description || "-"}</td>
                          <td>{entry.duration_minutes ? (Number(entry.duration_minutes) / 60).toFixed(2) : "0.00"}</td>
                          <td>{formatMoney(entry.hourly_rate, entry.currency || editForm.currency)}</td>
                          <td>{formatMoney(entry.amount, entry.currency || editForm.currency)}</td>
                          <td><button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={() => addTimeEntryLine(entry)}>Add</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </article>

            {(editForm.line_items || []).map((line, index) => (
              line.time_entry_id ? (
                <div className="invoice-linked-time-row" key={`edit-line-${index}`}>
                  <div className="invoice-linked-time-row__main">
                    <strong>{line.description}</strong>
                    <span>{line.staff_name || "Staff"} · {line.hours || line.quantity} hrs · {formatMoney(line.rate || line.unit_price, editForm.currency)}</span>
                  </div>
                  <div className="invoice-linked-time-row__meta">
                    <span>{formatMoney(line.amount, editForm.currency)}</span>
                    <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => removeLineItem(index)}>Remove</button>
                  </div>
                </div>
              ) : (
                <div className="invoice-line-item-row" key={`edit-line-${index}`}>
                  <select value={line.line_type} onChange={(event) => updateLineItem(index, { line_type: event.target.value })}>
                    {LINE_ITEM_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <input value={line.description} onChange={(event) => updateLineItem(index, { description: event.target.value })} placeholder="Description" />
                  <input type="number" step="0.01" min="0.01" value={line.quantity} onChange={(event) => updateLineItem(index, { quantity: event.target.value })} placeholder="Qty" />
                  <input type="number" step="0.01" min="0" value={line.unit_price} onChange={(event) => updateLineItem(index, { unit_price: event.target.value })} placeholder="Unit price" />
                  <input type="text" value={formatMoney(line.amount || 0, editForm.currency)} readOnly className="invoice-line-item-row__amount" />
                  <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => removeLineItem(index)}>Remove</button>
                </div>
              )
            ))}

            <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={addManualLineItem}>Add line item</button>
            <textarea placeholder="Notes" value={editForm.notes} onChange={(event) => setEditForm((current) => ({ ...current, notes: event.target.value }))} />
            <div className="vilo-table-actions invoice-create-actions">
              <button type="button" className="vilo-btn vilo-btn--secondary" onClick={closeModal}>Cancel</button>
              <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving || !editForm.payment_account_id}>{saving ? "Saving..." : "Save invoice"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {modal === "apply_trust" ? (
        <Modal title="Apply Trust Funds" copy="Only funds held for this same client and matter can be applied." onClose={closeModal}>
          {formError ? <p className="vilo-state vilo-state--error trust-modal__error">{formError}</p> : null}
          <form className="vilo-form-grid" onSubmit={submitApplyTrust}>
            <div className="invoice-action-review">
              <span>Invoice balance due</span>
              <strong>{formatMoney(invoice.balance_due, currency)}</strong>
              <span>Available trust balance</span>
              <strong>{formatMoney(invoice.trust_balance_available || 0, currency)}</strong>
            </div>
            <div className="vilo-form-row-two">
              <input type="number" step="0.01" min="0" max={Math.min(Number(invoice.balance_due || 0), Number(invoice.trust_balance_available || 0))} placeholder="Amount" value={applyForm.amount} onChange={(event) => setApplyForm((current) => ({ ...current, amount: event.target.value }))} required />
              <select value={applyForm.trust_account_id} onChange={(event) => setApplyForm((current) => ({ ...current, trust_account_id: event.target.value }))}>
                <option value="">Default trust account</option>
                {eligibleTrustAccounts.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </div>
            <div className="vilo-form-row-two">
              <ViloDateInput value={applyForm.payment_date} onChange={(value) => setApplyForm((current) => ({ ...current, payment_date: value }))} />
              <input placeholder="External reference / check number" value={applyForm.external_reference_number} onChange={(event) => setApplyForm((current) => ({ ...current, external_reference_number: event.target.value }))} />
            </div>
            <textarea placeholder="Description" value={applyForm.description} onChange={(event) => setApplyForm((current) => ({ ...current, description: event.target.value }))} />
            <div className="vilo-table-actions invoice-create-actions">
              <button type="button" className="vilo-btn vilo-btn--secondary" onClick={closeModal}>Cancel</button>
              <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving}>{saving ? "Applying..." : "Apply trust funds"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {modal === "direct_payment" ? (
        <Modal title="Record Direct Payment" copy="This records a direct operating payment for the remaining invoice balance. It does not touch trust balances." onClose={closeModal}>
          {formError ? <p className="vilo-state vilo-state--error trust-modal__error">{formError}</p> : null}
          <form className="vilo-form-grid" onSubmit={submitDirectPayment}>
            <div className="invoice-action-review">
              <span>Remaining balance</span>
              <strong>{formatMoney(invoice.balance_due, currency)}</strong>
              <span>Active payments on invoice</span>
              <strong>{activePayments.length}</strong>
            </div>
            <p className="trust-form-warning">The current backend records direct payment for the remaining balance only.</p>
            <div className="vilo-table-actions invoice-create-actions">
              <button type="button" className="vilo-btn vilo-btn--secondary" onClick={closeModal}>Cancel</button>
              <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving}>{saving ? "Recording..." : "Record direct payment"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {modal === "void_invoice" ? (
        <Modal title="Void Invoice" copy="Voiding keeps the invoice record but removes it from active receivables. This cannot be used to delete records." onClose={closeModal}>
          {formError ? <p className="vilo-state vilo-state--error trust-modal__error">{formError}</p> : null}
          <form className="vilo-form-grid" onSubmit={submitVoidInvoice}>
            <div className="invoice-action-review">
              <span>Invoice</span>
              <strong>{invoice.invoice_number}</strong>
              <span>Active payments</span>
              <strong>{activePayments.length}</strong>
            </div>
            <textarea placeholder="Void reason" value={voidReason} onChange={(event) => setVoidReason(event.target.value)} required />
            <div className="vilo-table-actions invoice-create-actions">
              <button type="button" className="vilo-btn vilo-btn--secondary" onClick={closeModal}>Cancel</button>
              <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving || !voidReason.trim()}>{saving ? "Voiding..." : "Void invoice"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {modal === "void_payment" && selectedPayment ? (
        <Modal
          title="Void Invoice Payment"
          copy={selectedPayment.payment_source === "trust"
            ? "This will reverse the trust-to-operating transfer and restore funds to trust."
            : "This will reverse the recorded operating payment."}
          onClose={closeModal}
        >
          {formError ? <p className="vilo-state vilo-state--error trust-modal__error">{formError}</p> : null}
          <form className="vilo-form-grid" onSubmit={submitVoidPayment}>
            <div className="invoice-action-review">
              <span>Payment source</span>
              <strong>{selectedPayment.payment_source === "trust" ? "Trust Transfer" : "Direct Payment"}</strong>
              <span>Amount</span>
              <strong>{formatMoney(selectedPayment.amount, selectedPayment.currency || currency)}</strong>
            </div>
            <textarea placeholder="Void reason" value={voidReason} onChange={(event) => setVoidReason(event.target.value)} required />
            <div className="vilo-table-actions invoice-create-actions">
              <button type="button" className="vilo-btn vilo-btn--secondary" onClick={closeModal}>Cancel</button>
              <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving}>{saving ? "Voiding..." : "Void payment"}</button>
            </div>
          </form>
        </Modal>
      ) : null}
    </section>
  );
}

export default function InvoiceDetailPage() {
  return (
    <Suspense fallback={<section className="dashboard-page-stack"><EmptyState message="Loading invoice..." /></section>}>
      <InvoiceDetailInner />
    </Suspense>
  );
}
