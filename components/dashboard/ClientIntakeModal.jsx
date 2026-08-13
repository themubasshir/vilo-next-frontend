"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DiscardChangesDialog, useModalCloseGuard } from "../useModalCloseGuard";

const ID_TYPE_OPTIONS = [
  { value: "national_id", label: "National ID" },
  { value: "trn", label: "TRN" },
  { value: "passport", label: "Passport" },
  { value: "driver_licence", label: "Driver's License" },
  { value: "other", label: "Other" },
];
const ACCEPTED_ID_EXTENSIONS = new Set(["pdf", "doc", "docx", "jpg", "jpeg", "png"]);
const MAX_ID_FILE_BYTES = 10 * 1024 * 1024;

function fileIdentity(file) {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function entryKey(file) {
  return globalThis.crypto?.randomUUID?.() || `${fileIdentity(file)}\u0000${Date.now()}\u0000${Math.random()}`;
}

function validateIdFile(file) {
  const extension = String(file.name || "").split(".").pop()?.toLowerCase();
  if (!extension || !ACCEPTED_ID_EXTENSIONS.has(extension)) {
    return `${file.name || "This file"}: This file type is not supported. Please upload PDF, DOC/DOCX, JPG, or PNG.`;
  }
  if (file.size > MAX_ID_FILE_BYTES) {
    return `${file.name} exceeds the 10MB file size limit. Please upload a smaller file.`;
  }
  if (!file.size) return `${file.name}: Empty files cannot be uploaded.`;
  return "";
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

const initialState = {
  client_type: "individual",
  first_name: "",
  last_name: "",
  company_name: "",
  billing_currency: "JMD",
  address: "",
  trn_no: "",
  occupation: "",
  date_of_birth: "",
  email: "",
  phone: "",
  preferred_contact_method: "email",
  notes: "",
};

function readMetaLine(notes, label) {
  const token = `${label}:`;
  const idx = String(notes || "").indexOf(token);
  if (idx === -1) return "";
  return String(notes || "").slice(idx + token.length).split("\n")[0].trim();
}

function parseClient(client) {
  if (client?._draftForm) return { ...initialState, ...client._draftForm };
  const name = String(client?.name || "").trim();
  const [first_name = "", ...rest] = name.split(" ");
  const last_name = rest.join(" ").trim();

  return {
    ...initialState,
    client_type: client?.client_type || readMetaLine(client?.notes, "Client Type").toLowerCase() || "individual",
    first_name: readMetaLine(client?.notes, "First Name") || first_name,
    last_name: readMetaLine(client?.notes, "Last Name") || last_name,
    company_name: readMetaLine(client?.notes, "Company Name"),
    billing_currency: client?.billing_currency || readMetaLine(client?.notes, "Billing Currency") || "JMD",
    address: client?.address || readMetaLine(client?.notes, "Address") || "",
    trn_no: client?.trn_no || readMetaLine(client?.notes, "TRN No") || "",
    occupation: client?.occupation || "",
    date_of_birth: client?.date_of_birth || readMetaLine(client?.notes, "Date of Birth") || "",
    email: client?.email || "",
    phone: client?.phone || "",
    preferred_contact_method: client?.preferred_contact_method || readMetaLine(client?.notes, "Preferred Contact Method") || "email",
    notes: readMetaLine(client?.notes, "Notes") || client?.notes || "",
  };
}

function payloadFromState(state, existingClient) {
  const fullName = `${state.first_name} ${state.last_name}`.trim();
  const fallbackName = state.client_type === "corporate" ? state.company_name : state.first_name;

  return {
    name: fullName || fallbackName || existingClient?.name || "Client",
    email: state.email || null,
    phone: state.phone || null,
    address: state.address || null,
    notes: state.notes || null,
    client_type: state.client_type || "individual",
    trn_no: state.trn_no || null,
    occupation: state.client_type === "corporate" ? null : state.occupation || null,
    preferred_contact_method: state.preferred_contact_method || null,
    date_of_birth: state.date_of_birth || null,
    billing_currency: state.billing_currency || "JMD",
  };
}

function isCorporateType(type) {
  return String(type || "").toLowerCase() === "corporate";
}

export default function ClientIntakeModal({
  open, mode = "create", client = null, draftAttachment = null, saving = false, apiError = "",
  showIdUpload = true, onClose, onSubmit, onSaveDraft, onDiscardDraft, onViewDraftAttachment,
}) {
  const [form, setForm] = useState(initialState);
  const [initialForm, setInitialForm] = useState(initialState);
  const [selectedIds, setSelectedIds] = useState([]);
  const [fileErrors, setFileErrors] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [errors, setErrors] = useState({});
  const [attachmentRemoved, setAttachmentRemoved] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setSelectedIds([]);
    setFileErrors([]);
    setDragActive(false);
    dragDepthRef.current = 0;
    setAttachmentRemoved(false);
    setAttachmentError("");
    const next = client ? parseClient(client) : initialState;
    setForm(next);
    setInitialForm(next);
  }, [open, client]);

  const title = useMemo(() => (mode === "edit" ? "Edit Client" : "Client Intake Form"), [mode]);
  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(initialForm) || selectedIds.length > 0 || attachmentRemoved,
    [attachmentRemoved, form, initialForm, selectedIds.length],
  );
  const closeGuard = useModalCloseGuard({ open, isDirty: dirty, isSubmitting: saving, onClose, onDiscard: onDiscardDraft });

  if (!open) return null;

  function validate() {
    const corporate = isCorporateType(form.client_type);
    const next = {};
    if (!corporate && !form.first_name.trim()) next.first_name = "First name is required.";
    if (!corporate && !form.last_name.trim()) next.last_name = "Last name is required.";
    if (corporate && !form.company_name.trim()) next.company_name = "Company name is required.";
    if (!form.address.trim()) next.address = "Address is required.";
    if (!form.trn_no.trim()) next.trn_no = "TRN No. is required.";
    if (!corporate && !form.date_of_birth.trim()) next.date_of_birth = "Date of birth is required.";
    if (!form.email.trim()) next.email = "Email is required.";
    if (!form.phone.trim()) next.phone = "Phone is required.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    const validatedIds = selectedIds.map((entry) => ({ ...entry, error: validateIdFile(entry.file) }));
    const invalidIds = validatedIds.filter((entry) => entry.error);
    if (invalidIds.length) {
      setSelectedIds(validatedIds);
      return;
    }
    await onSubmit(
      payloadFromState(form, client),
      validatedIds.map(({ file, idType }) => ({ file, idType })),
      { removeDraftAttachment: attachmentRemoved },
    );
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const identities = new Set(selectedIds.map((entry) => fileIdentity(entry.file)));
    const additions = [];
    const rejected = [];
    files.forEach((file) => {
      const identity = fileIdentity(file);
      if (identities.has(identity)) {
        rejected.push({ key: entryKey(file), message: `${file.name} is already selected.` });
        return;
      }
      identities.add(identity);
      const error = validateIdFile(file);
      if (error) {
        rejected.push({ key: entryKey(file), message: error });
        return;
      }
      additions.push({ key: entryKey(file), file, idType: "other", error: "" });
    });
    if (additions.length) setSelectedIds((current) => [...current, ...additions]);
    if (rejected.length) setFileErrors((current) => [...current, ...rejected]);
  }

  function handleFileInput(event) {
    addFiles(event.target.files);
    event.target.value = "";
  }

  function handleDragEnter(event) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    addFiles(event.dataTransfer?.files);
  }

  const corporate = isCorporateType(form.client_type);
  const firstNameLabel = corporate ? "Contact First Name" : "First Name *";
  const lastNameLabel = corporate ? "Contact Last Name" : "Last Name *";
  const companyLabel = corporate ? "Company Name *" : "Company Name";

  return (
    <div className="vilo-modal-overlay" onClick={closeGuard.requestClose}>
      <div className="vilo-modal vilo-modal--intake" onClick={(e) => e.stopPropagation()}>
        <div className="vilo-modal__header">
          <h3>{title}</h3>
          <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={closeGuard.requestClose} disabled={saving}>Close</button>
        </div>
        <form className="vilo-modal__body" onSubmit={handleSubmit}>
          <div className="client-intake-type-row">
            <span>Client Type:</span>
            <label><input type="radio" checked={form.client_type === "individual"} onChange={() => setForm({ ...form, client_type: "individual" })} /> Individual</label>
            <label><input type="radio" checked={form.client_type === "corporate"} onChange={() => setForm({ ...form, client_type: "corporate" })} /> Corporate</label>
          </div>

          <div className="client-intake-grid">
            <Field label={firstNameLabel} value={form.first_name} onChange={(v) => setForm({ ...form, first_name: v })} error={errors.first_name} placeholder={corporate ? "Contact first name (optional)" : "Enter First Name"} />
            <Field label={lastNameLabel} value={form.last_name} onChange={(v) => setForm({ ...form, last_name: v })} error={errors.last_name} placeholder={corporate ? "Contact last name (optional)" : "Enter Last Name"} />
            <Field label={companyLabel} value={form.company_name} onChange={(v) => setForm({ ...form, company_name: v })} error={errors.company_name} placeholder={corporate ? "Enter Company Name" : "Company name (optional)"} />
            <div><label>Billing Currency *</label><select value={form.billing_currency} onChange={(e) => setForm({ ...form, billing_currency: e.target.value })}><option value="JMD">JMD — Jamaican Dollar</option><option value="USD">USD</option><option value="EUR">EUR</option><option value="AED">AED</option></select></div>
            <Field label="Address *" value={form.address} onChange={(v) => setForm({ ...form, address: v })} error={errors.address} placeholder="Enter Address" />
            <Field label="TRN No. *" value={form.trn_no} onChange={(v) => setForm({ ...form, trn_no: v })} error={errors.trn_no} placeholder="Enter TRN" />
            {!corporate ? <Field label="Occupation" value={form.occupation} onChange={(v) => setForm({ ...form, occupation: v })} placeholder="Enter Occupation" /> : null}
            {!corporate ? <Field label="Date of Birth *" value={form.date_of_birth} onChange={(v) => setForm({ ...form, date_of_birth: v })} error={errors.date_of_birth} placeholder="YYYY-MM-DD" /> : null}
            <Field label="Email *" value={form.email} onChange={(v) => setForm({ ...form, email: v })} error={errors.email} placeholder="Enter Email" />
            <Field label="Phone *" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} error={errors.phone} placeholder="Enter Phone" />
            <div><label>Preferred Contact Method *</label><select value={form.preferred_contact_method} onChange={(e) => setForm({ ...form, preferred_contact_method: e.target.value })}><option value="email">Email</option><option value="phone">Phone</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></select></div>
          </div>

          {showIdUpload ? <div className="client-upload-block">
            <p>Upload ID</p>
            {draftAttachment && !attachmentRemoved ? (
              <div className="client-draft-attachment">
                <div>
                  <strong>Saved attachment: {draftAttachment.file_name}</strong>
                  <span>{draftAttachment.file_size ? `${Math.ceil(draftAttachment.file_size / 1024)} KB` : "Stored securely"}</span>
                </div>
                <div className="vilo-table-actions">
                  <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={async () => {
                    setAttachmentError("");
                    try {
                      await onViewDraftAttachment?.();
                    } catch (err) {
                      setAttachmentError(err.message || "Stored attachment could not be loaded.");
                    }
                  }}>View</button>
                  <button type="button" className="vilo-btn vilo-btn--danger vilo-btn--xs" onClick={() => setAttachmentRemoved(true)} aria-label={`Remove saved attachment ${draftAttachment.file_name}`}>Remove</button>
                </div>
              </div>
            ) : null}
            <div
              className={`client-upload-dropzone${dragActive ? " is-drag-active" : ""}`}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <strong>Drag &amp; drop ID files here or <button type="button" className="client-upload-browse" onClick={() => fileInputRef.current?.click()}>Browse</button></strong>
              <span>PDF, DOC/DOCX, JPG, PNG. Max file size 10MB each.</span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                onChange={handleFileInput}
                style={{ display: "none" }}
                aria-label="Browse for ID files"
              />
            </div>
            {selectedIds.length ? <div className="client-selected-ids" aria-live="polite">
              <p className="client-selected-ids__count">{selectedIds.length} ID {selectedIds.length === 1 ? "file" : "files"} selected</p>
              <div className="client-selected-ids__list">
                {selectedIds.map((entry) => <div className="client-selected-id" key={entry.key}>
                  <div className="client-selected-id__type">
                    <label htmlFor={`intake-id-type-${entry.key}`}>ID Type</label>
                    <select
                      id={`intake-id-type-${entry.key}`}
                      value={entry.idType}
                      onChange={(event) => setSelectedIds((current) => current.map((item) => item.key === entry.key ? { ...item, idType: event.target.value } : item))}
                    >
                      {ID_TYPE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                  <div className="client-selected-id__file">
                    <strong title={entry.file.name}>{entry.file.name}</strong>
                    <span>{formatFileSize(entry.file.size)}</span>
                    <small className={entry.error ? "vilo-form-error" : "client-selected-id__ready"}>{entry.error || "Ready to upload"}</small>
                  </div>
                  <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setSelectedIds((current) => current.filter((item) => item.key !== entry.key))} aria-label={`Remove ${entry.file.name}`}>Remove</button>
                </div>)}
              </div>
              <button type="button" className="client-add-another-id" onClick={() => fileInputRef.current?.click()}>+ Add another ID</button>
            </div> : null}
            {fileErrors.length ? <div className="client-upload-errors" aria-live="polite">
              {fileErrors.map((item) => <div className="client-upload-error" key={item.key}>
                <span>{item.message}</span>
                <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setFileErrors((current) => current.filter((error) => error.key !== item.key))} aria-label="Dismiss file error">Dismiss</button>
              </div>)}
            </div> : null}
            {selectedIds.length > 1 && !(draftAttachment && !attachmentRemoved) ? <p className="client-draft-file-notice">This draft can store one ID file. If you save it, {selectedIds[0].file.name} will be retained; {selectedIds.length - 1} additional selected {selectedIds.length - 1 === 1 ? "file" : "files"} must be reselected when the draft is reopened.</p> : null}
            {selectedIds.length && draftAttachment && !attachmentRemoved ? <p className="client-draft-file-notice">The saved attachment will be preserved. Newly selected IDs are available for final submission, but must be reselected if you save and reopen this draft.</p> : null}
            {attachmentRemoved ? <p className="vilo-state">The saved attachment will be removed when you save or complete this intake.</p> : null}
            {attachmentError ? <p className="vilo-state vilo-state--error">{attachmentError}</p> : null}
          </div> : null}

          <div>
            <label>Notes</label>
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notes" />
            {errors.notes ? <small className="vilo-form-error">{errors.notes}</small> : null}
          </div>

          {apiError ? <p className="vilo-state vilo-state--error">{apiError}</p> : null}

          <div className="vilo-table-actions client-intake-footer">
            <button className="vilo-btn vilo-btn--secondary" type="button" onClick={closeGuard.requestClose} disabled={saving}>Cancel</button>
            <button className="vilo-btn vilo-btn--primary" type="submit" disabled={saving}>{saving ? "Saving..." : mode === "edit" ? "Save Client" : "Add Client"}</button>
          </div>
        </form>
      </div>
      <DiscardChangesDialog
        open={closeGuard.confirmDiscard}
        onKeepEditing={closeGuard.keepEditing}
        onDiscard={closeGuard.discard}
        onSaveDraft={mode === "create" && onSaveDraft ? async () => {
          await onSaveDraft(form, selectedIds.map(({ file, idType }) => ({ file, idType })), { removeDraftAttachment: attachmentRemoved });
          closeGuard.keepEditing();
        } : undefined}
        saving={saving}
      />
    </div>
  );
}

function Field({ label, value, onChange, placeholder, error }) {
  return (
    <div>
      <label>{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {error ? <small className="vilo-form-error">{error}</small> : null}
    </div>
  );
}
