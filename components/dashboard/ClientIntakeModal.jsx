"use client";

import { useEffect, useMemo, useState } from "react";
import { DiscardChangesDialog, useModalCloseGuard } from "../useModalCloseGuard";

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
  const [idFile, setIdFile] = useState(null);
  const [errors, setErrors] = useState({});
  const [attachmentRemoved, setAttachmentRemoved] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setIdFile(null);
    setAttachmentRemoved(false);
    setAttachmentError("");
    const next = client ? parseClient(client) : initialState;
    setForm(next);
    setInitialForm(next);
  }, [open, client]);

  const title = useMemo(() => (mode === "edit" ? "Edit Client" : "Client Intake Form"), [mode]);
  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(initialForm) || Boolean(idFile) || attachmentRemoved,
    [attachmentRemoved, form, initialForm, idFile],
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
    await onSubmit(payloadFromState(form, client), idFile, { removeDraftAttachment: attachmentRemoved });
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
                  <button type="button" className="vilo-btn vilo-btn--danger vilo-btn--xs" onClick={() => { setAttachmentRemoved(true); setIdFile(null); }}>Remove</button>
                </div>
              </div>
            ) : null}
            <label className="client-upload-dropzone">
              <strong>{draftAttachment && !attachmentRemoved ? "Replace saved attachment" : "Drag & drop or Browse"}</strong>
              <span>PDF, DOC/DOCX, JPG, PNG. Max file size 10MB</span>
              <input
                type="file"
                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                onChange={(e) => {
                  setIdFile(e.target.files?.[0] || null);
                  if (e.target.files?.[0]) setAttachmentRemoved(false);
                }}
                style={{ display: "none" }}
              />
            </label>
            {idFile ? <p className="vilo-state">Selected replacement: {idFile.name}</p> : null}
            {attachmentRemoved && !idFile ? <p className="vilo-state">The saved attachment will be removed when you save or complete this intake.</p> : null}
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
          await onSaveDraft(form, idFile, { removeDraftAttachment: attachmentRemoved });
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
