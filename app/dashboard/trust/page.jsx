"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getCachedUser, setCachedUser } from "../../../lib/auth";
import { apiDownload, apiRequest } from "../../../lib/api";
import { formatViloDate, formatViloDateTime } from "../../../lib/dateFormat";
import ViloDateInput from "../../../components/ViloDateInput";

const TAB_OPTIONS = ["transactions", "client_ledgers", "matter_ledgers", "receipts"];
const SUPPORTED_CURRENCIES = ["JMD", "USD"];
const TX_TYPES = ["deposit", "disbursement", "refund", "adjustment"];

const EMPTY_FILTERS = {
  client_id: "",
  case_id: "",
  transaction_type: "",
  status: "",
  currency: "JMD",
  date_from: "",
  date_to: "",
  include_reversed: true,
};

const FORM_DEFAULTS = {
  trust_account_id: "",
  client_id: "",
  case_id: "",
  amount: "",
  currency: "JMD",
  transaction_date: "",
  payment_method: "",
  external_reference_number: "",
  description: "",
  payee_name: "",
  payee_type: "",
  adjustment_direction: "increase",
  adjustment_reason: "",
};

function roleCanManage(role) {
  return role === "partner" || role === "admin";
}

function formatMoney(value, currency = "JMD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value || 0));
}

function formatDate(value, includeTime = false) {
  return includeTime ? formatViloDateTime(value) : formatViloDate(value);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function buildSearch(path, params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (typeof value === "boolean") {
      search.set(key, value ? "true" : "false");
      return;
    }
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function typeLabel(type) {
  return String(type || "").replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function txTypeTone(txn) {
  if (txn.status === "reversal") return "reversal";
  if (txn.transaction_type === "deposit") return "deposit";
  if (txn.transaction_type === "disbursement") return "disbursement";
  if (txn.transaction_type === "refund") return "refund";
  if (txn.transaction_type === "transfer_to_operating") return "transfer";
  return "adjustment";
}

function txDirection(txn) {
  if (txn.transaction_type === "deposit") return "inflow";
  if (txn.transaction_type === "adjustment") return txn.adjustment_direction === "decrease" ? "outflow" : "inflow";
  if (txn.status === "reversal" && txn.adjustment_direction !== "decrease") return "inflow";
  return "outflow";
}

function txStatusLabel(status) {
  if (status === "reversed") return "Reversed";
  if (status === "reversal") return "Reversal";
  return "Active";
}

function typeDisplay(txn) {
  if (txn.status === "reversal") return "Reversal";
  if (txn.transaction_type === "transfer_to_operating") return "Applied to Invoice";
  return typeLabel(txn.transaction_type);
}

function stopPropagation(event) {
  event.stopPropagation();
}

function EmptyState({ message }) {
  return (
    <div className="vilo-state-block trust-state-block">
      <p className="vilo-state">{message}</p>
    </div>
  );
}

function Modal({ title, copy, onClose, children }) {
  return (
    <div className="vilo-modal-overlay" onClick={onClose}>
      <div className="vilo-modal trust-modal trust-modal--wide" onClick={(event) => event.stopPropagation()}>
        <div className="vilo-modal__header">
          <div>
            <h3>{title}</h3>
            {copy ? <p className="trust-modal__copy">{copy}</p> : null}
          </div>
          <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={onClose}>Close</button>
        </div>
        <div className="vilo-modal__body">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, required = false, children, helper }) {
  return (
    <label className="trust-form-field">
      <span>{label}{required ? " *" : ""}</span>
      {children}
      {helper ? <small>{helper}</small> : null}
    </label>
  );
}

function TrustPageInner() {
  const searchParams = useSearchParams();
  const queryClientId = searchParams.get("client_id") || "";
  const queryCaseId = searchParams.get("case_id") || "";
  const queryAction = searchParams.get("action") || "";

  const [currentUser, setCurrentUser] = useState(getCachedUser());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [activeTab, setActiveTab] = useState("transactions");
  const [filters, setFilters] = useState({
    ...EMPTY_FILTERS,
    client_id: queryClientId,
    case_id: queryCaseId,
  });
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [clientLedgers, setClientLedgers] = useState([]);
  const [matterLedgers, setMatterLedgers] = useState([]);
  const [clients, setClients] = useState([]);
  const [cases, setCases] = useState([]);
  const [balances, setBalances] = useState(null);
  const [modal, setModal] = useState("");
  const [selectedTransaction, setSelectedTransaction] = useState(null);
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [reversalReason, setReversalReason] = useState("");
  const [formType, setFormType] = useState("deposit");
  const [form, setForm] = useState(FORM_DEFAULTS);
  const [formBalances, setFormBalances] = useState(null);

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

  const canManage = roleCanManage(currentUser?.role || "");
  const unauthorized = currentUser && !["partner", "admin", "lawyer", "paralegal"].includes(currentUser.role);

  const casesForSelectedClient = useMemo(() => {
    if (!filters.client_id) return cases;
    return cases.filter((row) => Number(row.client_id) === Number(filters.client_id));
  }, [cases, filters.client_id]);

  const formCases = useMemo(() => {
    if (!form.client_id) return cases;
    return cases.filter((row) => Number(row.client_id) === Number(form.client_id));
  }, [cases, form.client_id]);

  const accountOptions = useMemo(() => {
    const matches = accounts.filter((row) => (row.currency || "JMD").toUpperCase() === (form.currency || "JMD").toUpperCase());
    if (matches.length === 1) {
      return [{ ...matches[0], display_name: "Main Trust Account" }];
    }
    return matches.map((row) => ({ ...row, display_name: row.name }));
  }, [accounts, form.currency]);

  async function loadData(nextFilters = filters, { initial = false } = {}) {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError("");
    try {
      const txPath = buildSearch("/api/v1/trust/transactions", nextFilters);
      const receiptPath = buildSearch("/api/v1/trust/receipts", {
        client_id: nextFilters.client_id || undefined,
        case_id: nextFilters.case_id || undefined,
        currency: nextFilters.currency || undefined,
        date_from: nextFilters.date_from || undefined,
        date_to: nextFilters.date_to || undefined,
      });
      const balancePath = buildSearch("/api/v1/trust/balances", {
        client_id: nextFilters.client_id || undefined,
        case_id: nextFilters.case_id || undefined,
        currency: nextFilters.currency || "JMD",
      });
      const [accountRows, txRows, receiptRows, clientRows, matterRows, clientList, caseList, balanceRow] = await Promise.all([
        apiRequest("/api/v1/trust/accounts"),
        apiRequest(txPath),
        apiRequest(receiptPath),
        apiRequest(buildSearch("/api/v1/trust/client-ledgers", { currency: nextFilters.currency || "JMD" })),
        apiRequest(buildSearch("/api/v1/trust/matter-ledgers", { currency: nextFilters.currency || "JMD" })),
        apiRequest("/api/v1/clients"),
        apiRequest("/api/v1/cases").catch(() => []),
        apiRequest(balancePath).catch(() => null),
      ]);
      setAccounts(accountRows || []);
      setTransactions(txRows || []);
      setReceipts(receiptRows || []);
      setClientLedgers(clientRows || []);
      setMatterLedgers(matterRows || []);
      setClients(clientList || []);
      setCases(caseList || []);
      setBalances(balanceRow);
    } catch (err) {
      setError(err.message || "Unable to load trust accounting.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadData(filters, { initial: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loading) loadData(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => {
    if (!queryAction || !TX_TYPES.includes(queryAction)) return;
    openForm(queryAction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryAction, accounts.length, clients.length, cases.length]);

  useEffect(() => {
    if (!modal || !TX_TYPES.includes(modal)) return;
    if (!form.client_id || !form.case_id || !form.currency) {
      setFormBalances(null);
      return;
    }
    let cancelled = false;
    apiRequest(buildSearch("/api/v1/trust/balances", {
      client_id: form.client_id,
      case_id: form.case_id,
      trust_account_id: form.trust_account_id || undefined,
      currency: form.currency,
    }))
      .then((row) => {
        if (!cancelled) setFormBalances(row);
      })
      .catch(() => {
        if (!cancelled) setFormBalances(null);
      });
    return () => {
      cancelled = true;
    };
  }, [modal, form]);

  function updateFilters(field, value) {
    setFilters((current) => {
      const next = { ...current, [field]: value };
      if (field === "client_id") next.case_id = "";
      return next;
    });
  }

  function resetSelection() {
    setSelectedTransaction(null);
    setSelectedReceipt(null);
    setReversalReason("");
    setFormError("");
  }

  function closeModal() {
    setModal("");
    resetSelection();
  }

  function openForm(type) {
    const relevantAccounts = accounts.filter((row) => (row.currency || "JMD").toUpperCase() === "JMD");
    setFormType(type);
    setForm({
      ...FORM_DEFAULTS,
      client_id: filters.client_id || "",
      case_id: filters.case_id || "",
      trust_account_id: relevantAccounts[0]?.id ? String(relevantAccounts[0].id) : "",
      currency: "JMD",
      transaction_date: today(),
    });
    setFormBalances(null);
    setFormError("");
    setModal(type);
  }

  function updateForm(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === "client_id") next.case_id = "";
      if (field === "currency") {
        const currencyAccounts = accounts.filter((row) => (row.currency || "JMD").toUpperCase() === value.toUpperCase());
        next.trust_account_id = currencyAccounts[0]?.id ? String(currencyAccounts[0].id) : "";
      }
      if (field === "trust_account_id") {
        const account = accounts.find((row) => Number(row.id) === Number(value));
        if (account?.currency) next.currency = account.currency;
      }
      return next;
    });
  }

  async function submitTransaction(event) {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      const payload = {
        trust_account_id: Number(form.trust_account_id),
        client_id: Number(form.client_id),
        case_id: Number(form.case_id),
        transaction_type: formType,
        amount: Number(form.amount),
        currency: form.currency,
        transaction_date: form.transaction_date,
        payment_method: form.payment_method || null,
        external_reference_number: form.external_reference_number || null,
        description: form.description,
      };
      if (formType === "disbursement") {
        payload.payee_name = form.payee_name || null;
        payload.payee_type = form.payee_type || null;
      }
      if (formType === "adjustment") {
        payload.adjustment_direction = form.adjustment_direction;
        payload.adjustment_reason = form.adjustment_reason;
      }
      const created = await apiRequest("/api/v1/trust/transactions", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await loadData({ ...filters, currency: form.currency });
      closeModal();
      if (created?.receipt?.id) {
        const receipt = await apiRequest(`/api/v1/trust/receipts/${created.receipt.id}`);
        setSelectedReceipt(receipt);
        setModal("receipt");
      }
    } catch (err) {
      setFormError(err.message || "Unable to save trust transaction.");
    } finally {
      setSaving(false);
    }
  }

  async function openTransactionDetail(transactionId) {
    setFormError("");
    try {
      const detail = await apiRequest(`/api/v1/trust/transactions/${transactionId}`);
      setSelectedTransaction(detail);
      setModal("detail");
    } catch (err) {
      setFormError(err.message || "Unable to load trust transaction.");
    }
  }

  async function openReceipt(receiptId) {
    setFormError("");
    try {
      const receipt = await apiRequest(`/api/v1/trust/receipts/${receiptId}`);
      setSelectedReceipt(receipt);
      setModal("receipt");
    } catch (err) {
      setFormError(err.message || "Unable to load trust receipt.");
    }
  }

  async function reverseTransaction(event) {
    event.preventDefault();
    if (!selectedTransaction) return;
    setSaving(true);
    setFormError("");
    try {
      await apiRequest(`/api/v1/trust/transactions/${selectedTransaction.id}/reverse`, {
        method: "POST",
        body: JSON.stringify({ reversal_reason: reversalReason }),
      });
      closeModal();
      await loadData(filters);
    } catch (err) {
      setFormError(err.message || "Unable to reverse trust transaction.");
    } finally {
      setSaving(false);
    }
  }

  if (unauthorized) {
    return (
      <section className="dashboard-page-stack">
        <div className="vilo-state-block">
          <p className="vilo-state vilo-state--error">You are not authorized to view trust accounting.</p>
        </div>
      </section>
    );
  }

  const summaryTotal = accounts
    .filter((row) => (row.currency || "JMD").toUpperCase() === (filters.currency || "JMD").toUpperCase())
    .reduce((sum, row) => sum + Number(row.current_balance || 0), 0);

  return (
    <section className="dashboard-page-stack trust-finance-page">
      <div className="trust-page__top">
        <div className="dashboard-page-heading">
          <h1>Trust Accounting</h1>
          <p className="trust-page__intro">
            Trust deposits stay separate from revenue. Transfers to operating are system-generated from invoice trust application only.
          </p>
        </div>
        <div className="trust-page__actions">
          {canManage ? (
            <>
              <button type="button" className="vilo-btn vilo-btn--primary" onClick={() => openForm("deposit")}>Record Trust Deposit</button>
              <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => openForm("disbursement")}>Record Disbursement</button>
              <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => openForm("refund")}>Issue Refund</button>
              <button type="button" className="vilo-btn vilo-btn--ghost" onClick={() => openForm("adjustment")}>Record Adjustment</button>
            </>
          ) : null}
        </div>
      </div>

      <article className="dashboard-card trust-compliance-banner">
        <strong>Compliance note</strong>
        <span>Every trust transaction must stay client-and-matter specific, cannot be edited after posting, and can only be corrected by reversal or audited adjustment.</span>
      </article>

      {error ? (
        <div className="vilo-state-block">
          <p className="vilo-state vilo-state--error">{error}</p>
        </div>
      ) : null}

      <div className="trust-summary-grid trust-summary-grid--three">
        <article className="dashboard-card trust-stat-card">
          <div>
            <p>Total Trust Balance</p>
            <strong>{formatMoney(summaryTotal, filters.currency)}</strong>
          </div>
          <span className="trust-stat-card__meta">{filters.currency}</span>
        </article>
        <article className="dashboard-card trust-stat-card">
          <div>
            <p>Client Balance Snapshot</p>
            <strong>{formatMoney(balances?.client_balance || 0, filters.currency)}</strong>
          </div>
          <span className="trust-stat-card__meta">{filters.client_id ? "Filtered client" : "Select a client filter"}</span>
        </article>
        <article className="dashboard-card trust-stat-card">
          <div>
            <p>Matter Balance Snapshot</p>
            <strong>{formatMoney(balances?.matter_balance || 0, filters.currency)}</strong>
          </div>
          <span className="trust-stat-card__meta">{filters.case_id ? "Filtered matter" : "Select a matter filter"}</span>
        </article>
      </div>

      <article className="dashboard-card trust-shell-card">
        <div className="trust-toolbar trust-toolbar--finance">
          <div className="trust-filter-grid">
            <Field label="Transaction Type">
              <select value={filters.transaction_type} onChange={(event) => updateFilters("transaction_type", event.target.value)}>
                <option value="">All types</option>
                <option value="deposit">Deposit</option>
                <option value="disbursement">Disbursement</option>
                <option value="refund">Refund</option>
                <option value="adjustment">Adjustment</option>
                <option value="transfer_to_operating">Applied to Invoice</option>
              </select>
            </Field>
            <Field label="Client">
              <select value={filters.client_id} onChange={(event) => updateFilters("client_id", event.target.value)}>
                <option value="">All clients</option>
                {clients.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </Field>
            <Field label="Matter">
              <select value={filters.case_id} onChange={(event) => updateFilters("case_id", event.target.value)}>
                <option value="">All matters</option>
                {casesForSelectedClient.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select value={filters.status} onChange={(event) => updateFilters("status", event.target.value)}>
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="reversed">Reversed</option>
                <option value="reversal">Reversal</option>
              </select>
            </Field>
            <Field label="Currency">
              <select value={filters.currency} onChange={(event) => updateFilters("currency", event.target.value)}>
                {SUPPORTED_CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
              </select>
            </Field>
            <Field label="Date From">
              <ViloDateInput value={filters.date_from} onChange={(value) => updateFilters("date_from", value)} />
            </Field>
            <Field label="Date To">
              <ViloDateInput value={filters.date_to} onChange={(value) => updateFilters("date_to", value)} />
            </Field>
            <label className="trust-toggle trust-toggle--filters">
              <input type="checkbox" checked={filters.include_reversed} onChange={(event) => updateFilters("include_reversed", event.target.checked)} />
              <span>Include reversed entries</span>
            </label>
          </div>
          <div className="trust-tab-row" role="tablist" aria-label="Trust sections">
            {TAB_OPTIONS.map((tab) => (
              <button
                key={tab}
                type="button"
                className={activeTab === tab ? "trust-tab is-active" : "trust-tab"}
                onClick={() => setActiveTab(tab)}
              >
                {tab.replaceAll("_", " ")}
              </button>
            ))}
          </div>
        </div>

        {refreshing ? <p className="vilo-state">Refreshing trust data...</p> : null}
        {loading ? <EmptyState message="Loading trust accounting..." /> : null}

        {!loading && activeTab === "transactions" ? (
          transactions.length ? (
            <div className="vilo-table-wrap">
              <table className="team-table trust-ledger-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Client</th>
                    <th>Matter</th>
                    <th>System Ref</th>
                    <th>Description</th>
                    <th>Amount</th>
                    <th>Running Balance</th>
                    <th>Status</th>
                    <th>Receipt</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((txn) => (
                    <tr key={txn.id} className="trust-ledger-table__row trust-ledger-table__row--clickable" onClick={() => openTransactionDetail(txn.id)}>
                      <td>{formatDate(txn.transaction_date)}</td>
                      <td>
                        <span className={`trust-type-badge trust-type-badge--${txTypeTone(txn)}`}>{typeDisplay(txn)}</span>
                      </td>
                      <td>
                        <Link href={`/dashboard/clients/${txn.client_id}`} onClick={stopPropagation} className="trust-inline-link">
                          {txn.client_name || `Client #${txn.client_id}`}
                        </Link>
                      </td>
                      <td>
                        <Link href={`/dashboard/cases/${txn.case_id}`} onClick={stopPropagation} className="trust-inline-link">
                          {txn.case_title || `Matter #${txn.case_id}`}
                        </Link>
                      </td>
                      <td>{txn.reference_number}</td>
                      <td>{txn.description || "-"}</td>
                      <td className={txDirection(txn) === "inflow" ? "trust-amount trust-amount--inflow" : "trust-amount trust-amount--outflow"}>
                        {txDirection(txn) === "inflow" ? "+" : "-"}
                        {formatMoney(txn.amount, txn.currency)}
                      </td>
                      <td>{formatMoney(txn.running_balance, txn.currency)}</td>
                      <td><span className={`vilo-badge trust-status-badge trust-status-badge--${txn.status}`}>{txStatusLabel(txn.status)}</span></td>
                      <td>
                        {txn.receipt ? (
                          <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={(event) => { stopPropagation(event); openReceipt(txn.receipt.id); }}>
                            View Receipt
                          </button>
                        ) : "-"}
                      </td>
                      <td>
                        {canManage && txn.status === "active" && !(txn.transaction_type === "transfer_to_operating" && txn.linked_invoice_id) ? (
                          <button
                            type="button"
                            className="vilo-btn vilo-btn--secondary vilo-btn--xs"
                            onClick={(event) => {
                              stopPropagation(event);
                              setSelectedTransaction(txn);
                              setReversalReason("");
                              setFormError("");
                              setModal("reverse");
                            }}
                          >
                            Reverse Transaction
                          </button>
                        ) : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState message="No trust transactions match the current filters. Adjust the active filters and try again." />
          )
        ) : null}

        {!loading && activeTab === "client_ledgers" ? (
          clientLedgers.length ? (
            <div className="vilo-table-wrap">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Currency</th>
                    <th>Trust Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {clientLedgers.map((row) => (
                    <tr key={`${row.client_id}-${row.currency}`}>
                      <td><Link href={`/dashboard/clients/${row.client_id}`} className="trust-inline-link">{row.client_name}</Link></td>
                      <td>{row.currency}</td>
                      <td>{formatMoney(row.balance, row.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState message="No client trust balances found for this currency." />
        ) : null}

        {!loading && activeTab === "matter_ledgers" ? (
          matterLedgers.length ? (
            <div className="vilo-table-wrap">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>Matter</th>
                    <th>Client</th>
                    <th>Currency</th>
                    <th>Trust Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {matterLedgers.map((row) => (
                    <tr key={`${row.case_id}-${row.currency}`}>
                      <td><Link href={`/dashboard/cases/${row.case_id}`} className="trust-inline-link">{row.case_title}</Link></td>
                      <td><Link href={`/dashboard/clients/${row.client_id}`} className="trust-inline-link">{row.client_name}</Link></td>
                      <td>{row.currency}</td>
                      <td>{formatMoney(row.balance, row.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState message="No matter trust balances found for this currency." />
        ) : null}

        {!loading && activeTab === "receipts" ? (
          receipts.length ? (
            <div className="vilo-table-wrap">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Client</th>
                    <th>Matter</th>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>System Ref</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((receipt) => (
                    <tr key={receipt.id}>
                      <td>{receipt.receipt_number}</td>
                      <td><Link href={`/dashboard/clients/${receipt.client_id}`} className="trust-inline-link">{clients.find((row) => Number(row.id) === Number(receipt.client_id))?.name || `Client #${receipt.client_id}`}</Link></td>
                      <td><Link href={`/dashboard/cases/${receipt.case_id}`} className="trust-inline-link">{cases.find((row) => Number(row.id) === Number(receipt.case_id))?.title || `Matter #${receipt.case_id}`}</Link></td>
                      <td>{formatDate(receipt.issued_at)}</td>
                      <td>{formatMoney(receipt.amount, receipt.currency)}</td>
                      <td>{receipt.reference_number || "-"}</td>
                      <td className="trust-history-actions">
                        <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => openReceipt(receipt.id)}>View Receipt</button>
                        <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={() => apiDownload(`/api/v1/trust/receipts/${receipt.id}/download`).catch((err) => setFormError(err.message || "Download failed"))}>Download Receipt</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState message="No trust receipts match the current filters." />
        ) : null}
      </article>

      {TX_TYPES.includes(modal) ? (
        <Modal title={typeLabel(formType)} copy={formType === "adjustment" ? "Adjustments should only be used for corrections. They do not replace or edit existing transactions. All adjustments are audited." : "Reference Number is auto-generated after save."} onClose={closeModal}>
          {formError ? <p className="vilo-state vilo-state--error trust-modal__error">{formError}</p> : null}
          <form className="trust-form-shell" onSubmit={submitTransaction}>
            <div className="trust-form-grid">
              <Field label="Client" required>
                <select value={form.client_id} onChange={(event) => updateForm("client_id", event.target.value)} required>
                  <option value="">Select client</option>
                  {clients.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                </select>
              </Field>
              <Field label="Matter / Case" required>
                <select value={form.case_id} onChange={(event) => updateForm("case_id", event.target.value)} required>
                  <option value="">Select matter</option>
                  {formCases.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
                </select>
              </Field>
              <Field label="Amount" required>
                <input type="number" step="0.01" min="0" value={form.amount} onChange={(event) => updateForm("amount", event.target.value)} required />
              </Field>
              <Field label="Currency" required>
                <select value={form.currency} onChange={(event) => updateForm("currency", event.target.value)} required>
                  {SUPPORTED_CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                </select>
              </Field>
              <Field label="Date" required>
                <ViloDateInput value={form.transaction_date} onChange={(value) => updateForm("transaction_date", value)} required />
              </Field>
              <Field label="Payment Method">
                <input value={form.payment_method} onChange={(event) => updateForm("payment_method", event.target.value)} placeholder="Wire, cheque, cash, card" />
              </Field>
              <Field label="Trust Account" required helper={accountOptions.length <= 1 ? "Main Trust Account" : null}>
                <select value={form.trust_account_id} onChange={(event) => updateForm("trust_account_id", event.target.value)} required>
                  <option value="">Select trust account</option>
                  {accountOptions.map((row) => <option key={row.id} value={row.id}>{row.display_name}</option>)}
                </select>
              </Field>
              <Field label="Reference Number" helper="Auto-generated after save">
                <input value="Auto-generated after save" disabled readOnly />
              </Field>
              <Field label="External Reference / Check Number">
                <input value={form.external_reference_number} onChange={(event) => updateForm("external_reference_number", event.target.value)} placeholder="Optional" />
              </Field>
              {formType === "disbursement" ? (
                <>
                  <Field label="Payee Name" required>
                    <input value={form.payee_name} onChange={(event) => updateForm("payee_name", event.target.value)} required />
                  </Field>
                  <Field label="Payee Type">
                    <input value={form.payee_type} onChange={(event) => updateForm("payee_type", event.target.value)} placeholder="Third party, government, vendor" />
                  </Field>
                </>
              ) : null}
              {formType === "adjustment" ? (
                <>
                  <Field label="Adjustment Type" required>
                    <select value={form.adjustment_direction} onChange={(event) => updateForm("adjustment_direction", event.target.value)} required>
                      <option value="increase">Increase</option>
                      <option value="decrease">Decrease</option>
                    </select>
                  </Field>
                  <Field label="Reason" required>
                    <input value={form.adjustment_reason} onChange={(event) => updateForm("adjustment_reason", event.target.value)} required />
                  </Field>
                </>
              ) : null}
            </div>
            <Field label="Description" required>
              <textarea value={form.description} onChange={(event) => updateForm("description", event.target.value)} required />
            </Field>
            {formBalances ? (
              <article className="trust-balance-note">
                <strong>Available Matter Trust Balance</strong>
                <span>{formatMoney(formBalances.matter_balance || 0, form.currency)}</span>
              </article>
            ) : null}
            <div className="vilo-table-actions trust-form-actions">
              <button type="button" className="vilo-btn vilo-btn--secondary" onClick={closeModal}>Cancel</button>
              <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving}>{saving ? "Saving..." : "Save Transaction"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {modal === "detail" && selectedTransaction ? (
        <Modal title={`Transaction ${selectedTransaction.reference_number}`} copy="Reversal creates a new audit entry. It does not edit or delete the original transaction." onClose={closeModal}>
          <div className="trust-detail-grid">
            <p><strong>Transaction Type:</strong> <span className={`trust-type-badge trust-type-badge--${txTypeTone(selectedTransaction)}`}>{typeDisplay(selectedTransaction)}</span></p>
            <p><strong>Status:</strong> {txStatusLabel(selectedTransaction.status)}</p>
            <p><strong>Client:</strong> <Link href={`/dashboard/clients/${selectedTransaction.client_id}`} className="trust-inline-link">{selectedTransaction.client_name || `Client #${selectedTransaction.client_id}`}</Link></p>
            <p><strong>Matter:</strong> <Link href={`/dashboard/cases/${selectedTransaction.case_id}`} className="trust-inline-link">{selectedTransaction.case_title || `Matter #${selectedTransaction.case_id}`}</Link></p>
            <p><strong>Amount:</strong> {formatMoney(selectedTransaction.amount, selectedTransaction.currency)}</p>
            <p><strong>Currency:</strong> {selectedTransaction.currency}</p>
            <p><strong>Date:</strong> {formatDate(selectedTransaction.transaction_date)}</p>
            <p><strong>Payment Method:</strong> {selectedTransaction.payment_method || "-"}</p>
            <p><strong>System Reference Number:</strong> {selectedTransaction.reference_number}</p>
            <p><strong>External Reference Number:</strong> {selectedTransaction.external_reference_number || "-"}</p>
            <p><strong>Running Balance:</strong> {formatMoney(selectedTransaction.running_balance || 0, selectedTransaction.currency)}</p>
            <p><strong>Created By:</strong> {selectedTransaction.created_by_name || `User #${selectedTransaction.created_by_id}`}</p>
            <p><strong>Created Timestamp:</strong> {formatDate(selectedTransaction.created_at, true)}</p>
            <p className="trust-detail-grid__full"><strong>Description:</strong> {selectedTransaction.description || "-"}</p>
            {selectedTransaction.linked_invoice_id ? (
              <p className="trust-detail-grid__full">
                <strong>Linked Invoice:</strong>{" "}
                <Link href={`/dashboard/invoices/${selectedTransaction.linked_invoice_id}`} className="trust-inline-link">
                  Applied to Invoice #{selectedTransaction.linked_invoice_number || selectedTransaction.linked_invoice_id}
                </Link>
              </p>
            ) : null}
            {selectedTransaction.receipt ? (
              <p className="trust-detail-grid__full trust-history-actions">
                <strong>Linked Receipt:</strong>{" "}
                <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => openReceipt(selectedTransaction.receipt.id)}>View Receipt</button>
                <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={() => apiDownload(`/api/v1/trust/receipts/${selectedTransaction.receipt.id}/download`).catch((err) => setFormError(err.message || "Download failed"))}>Download Receipt</button>
              </p>
            ) : null}
            {selectedTransaction.reversal_transaction ? (
              <p><strong>Reversal Info:</strong> Reversal #{selectedTransaction.reversal_transaction.reference_number}</p>
            ) : null}
            <p><strong>Reversed By:</strong> {selectedTransaction.voided_by_name || "-"}</p>
            <p><strong>Reversal Reason:</strong> {selectedTransaction.void_reason || "-"}</p>
            <p><strong>Reversed Timestamp:</strong> {formatDate(selectedTransaction.voided_at, true)}</p>
          </div>
        </Modal>
      ) : null}

      {modal === "reverse" && selectedTransaction ? (
        <Modal title="Reverse Transaction" copy="Reversal creates a new audit entry. It does not edit or delete the original transaction." onClose={closeModal}>
          {formError ? <p className="vilo-state vilo-state--error trust-modal__error">{formError}</p> : null}
          <form className="trust-form-shell" onSubmit={reverseTransaction}>
            <article className="trust-review-card">
              <strong>{selectedTransaction.reference_number}</strong>
              <span>{typeDisplay(selectedTransaction)} for {formatMoney(selectedTransaction.amount, selectedTransaction.currency)}</span>
              <span>{selectedTransaction.description || "No description"}</span>
            </article>
            <Field label="Reversal Reason" required>
              <textarea value={reversalReason} onChange={(event) => setReversalReason(event.target.value)} required />
            </Field>
            <div className="vilo-table-actions trust-form-actions">
              <button type="button" className="vilo-btn vilo-btn--secondary" onClick={closeModal}>Cancel</button>
              <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving}>{saving ? "Reversing..." : "Reverse Transaction"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {modal === "receipt" && selectedReceipt ? (
        <Modal title={`Trust Receipt ${selectedReceipt.receipt_number}`} copy="Every trust deposit creates an immutable receipt." onClose={closeModal}>
          <div className="trust-detail-grid">
            <p><strong>Client:</strong> <Link href={`/dashboard/clients/${selectedReceipt.client_id}`} className="trust-inline-link">{clients.find((row) => Number(row.id) === Number(selectedReceipt.client_id))?.name || `Client #${selectedReceipt.client_id}`}</Link></p>
            <p><strong>Matter:</strong> <Link href={`/dashboard/cases/${selectedReceipt.case_id}`} className="trust-inline-link">{cases.find((row) => Number(row.id) === Number(selectedReceipt.case_id))?.title || `Matter #${selectedReceipt.case_id}`}</Link></p>
            <p><strong>Amount:</strong> {formatMoney(selectedReceipt.amount, selectedReceipt.currency)}</p>
            <p><strong>Currency:</strong> {selectedReceipt.currency}</p>
            <p><strong>Date Received:</strong> {formatDate(selectedReceipt.issued_at, true)}</p>
            <p><strong>Payment Method:</strong> {selectedReceipt.payment_method || "-"}</p>
            <p><strong>System Reference Number:</strong> {selectedReceipt.reference_number || "-"}</p>
            <p><strong>External Reference Number:</strong> {selectedReceipt.external_reference_number || "-"}</p>
            <p><strong>Recorded By:</strong> {selectedReceipt.issued_by_name || `User #${selectedReceipt.issued_by_id}`}</p>
            <p className="trust-detail-grid__full"><strong>Description:</strong> {selectedReceipt.description || "-"}</p>
            <p className="trust-detail-grid__full trust-history-actions">
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => apiDownload(`/api/v1/trust/receipts/${selectedReceipt.id}/download`).catch((err) => setFormError(err.message || "Download failed"))}>Download Receipt</button>
            </p>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

export default function TrustPage() {
  return (
    <Suspense fallback={<section className="dashboard-page-stack"><EmptyState message="Loading trust accounting..." /></section>}>
      <TrustPageInner />
    </Suspense>
  );
}
