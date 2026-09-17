"use client";

import { useRef, useState } from "react";

// Matches the normal protected Document uploader (10 MiB per file).
export const DOCUMENT_ACCEPT = ".pdf,.doc,.docx,.jpg,.jpeg,.png,.txt";
export function formatAttachmentSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
const identity = (file) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

export default function DocumentFileSelection({ files, onChange, disabled = false, maxFiles = Infinity, label = "Client documents", compact = false, showSelection = true, children }) {
  const input = useRef(null);
  const [errors, setErrors] = useState([]);
  function add(fileList) {
    if (disabled) return;
    const next = [...files];
    const rejected = [];
    for (const file of Array.from(fileList || [])) {
      const extension = file.name.split(".").pop()?.toLowerCase();
      const reason = !DOCUMENT_ACCEPT.split(",").includes(`.${extension}`) ? "Unsupported file type."
        : !file.size ? "Empty files cannot be uploaded."
        : file.size > 10 * 1024 * 1024 ? "Exceeds the 10 MiB file size limit."
        : next.some((entry) => identity(entry) === identity(file)) ? "Already selected."
        : next.length >= maxFiles ? `Maximum ${maxFiles} attachments per message.` : "";
      if (reason) rejected.push(`${file.name}: ${reason}`);
      else next.push(file);
    }
    onChange(next);
    setErrors(rejected);
  }
  return (
    <div className="document-file-selection">
      <div className={compact ? "" : "client-upload-dropzone"} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); add(event.dataTransfer.files); }}>
        {!compact ? <span>Drag &amp; drop client documents here or </span> : null}
        <button type="button" className={compact ? "messages-link-case-button" : "client-upload-browse"} disabled={disabled} onClick={() => input.current?.click()} aria-label={`Browse for ${label}`}>{children || (compact ? "Attach documents" : "Browse")}</button>
        <input ref={input} type="file" multiple accept={DOCUMENT_ACCEPT} hidden disabled={disabled} onChange={(event) => { add(event.target.files); event.target.value = ""; }} />
        {!compact ? <span>PDF, DOC/DOCX, JPG, PNG, TXT. Maximum 10 MiB per file.</span> : null}
      </div>
      {showSelection && files.length ? <div className="document-selection-list" aria-live="polite">
        <strong>{files.length} {compact ? "files" : "documents"} selected</strong>
        {files.map((file) => <div className="document-selection-row" key={identity(file)}>
          <span title={file.name}>{file.name}</span><small>{formatAttachmentSize(file.size)} · Ready to upload</small>
          <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" disabled={disabled} aria-label={`Remove ${file.name}`} onClick={() => onChange(files.filter((entry) => entry !== file))}>Remove</button>
        </div>)}
      </div> : null}
      {errors.length ? <div role="alert">{errors.map((error, index) => <p className="vilo-form-error" key={index}>{error}</p>)}</div> : null}
    </div>
  );
}
