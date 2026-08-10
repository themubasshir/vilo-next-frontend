"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDownload, apiRequest } from "../lib/api";

let onlyOfficeInstanceCounter = 0;

export default function OnlyOfficeDocumentModal({
  document,
  mode = "edit",
  downloadPath = "",
  onClose,
}) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("preparing");
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const editorRef = useRef(null);
  const initKeyRef = useRef(null);
  const instanceIdRef = useRef(null);
  if (!instanceIdRef.current) {
    onlyOfficeInstanceCounter += 1;
    instanceIdRef.current = onlyOfficeInstanceCounter;
  }

  const isViewMode = mode === "view";
  const containerId = `onlyoffice-document-${document?.id || "unknown"}-${instanceIdRef.current}`;
  const displayTitle = isViewMode
    ? (document?.file_name || document?.title || "Untitled document")
    : (document?.title || document?.file_name || "Untitled document");
  const sessionKey = useMemo(() => [
    document?.id ?? "unknown",
    session?.version ?? "unknown",
    session?.editor_config?.document?.key ?? "unknown",
    mode,
  ].join(":"), [document?.id, mode, session]);

  const handleClose = useCallback(() => {
    destroyOnlyOfficeEditor(editorRef, initKeyRef, containerId);
    onClose?.();
  }, [containerId, onClose]);

  useEffect(() => {
    if (!document?.id) return undefined;
    let cancelled = false;

    async function createSession() {
      setSession(null);
      setLoading(true);
      setStatus("preparing");
      setError("");
      setDownloadError("");
      try {
        const suffix = isViewMode ? "?mode=view" : "";
        const response = await apiRequest(`/api/v1/documents/${document.id}/onlyoffice/session${suffix}`, {
          method: "POST",
        });
        if (!response?.document_server_url || !response?.editor_config) {
          throw new Error("Backend returned an incomplete ONLYOFFICE session.");
        }
        if (!cancelled) setSession(response);
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        setStatus("error");
        setError(isViewMode
          ? "This Word document could not be opened in the online viewer."
          : (err?.message || "Failed to open the Word editor"));
      }
    }

    void createSession();
    return () => { cancelled = true; };
  }, [document?.id, isViewMode]);

  useEffect(() => {
    if (!session?.document_server_url || !containerId) return undefined;
    if (typeof window === "undefined") return undefined;
    let cancelled = false;

    async function mountEditor() {
      setLoading(true);
      setError("");
      setStatus("script");
      try {
        await loadOnlyOfficeScript(session.document_server_url);
        await waitForDocsAPI();
        if (cancelled) return;
        if (!window.DocsAPI?.DocEditor) throw new Error("ONLYOFFICE DocsAPI is unavailable.");

        destroyOnlyOfficeEditor(editorRef, initKeyRef, containerId);
        const host = window.document.getElementById(containerId);
        if (!host) throw new Error("ONLYOFFICE document container was not found.");
        host.replaceChildren();
        setStatus("opening");
        editorRef.current = new window.DocsAPI.DocEditor(containerId, session.editor_config);
        initKeyRef.current = sessionKey;
        if (!cancelled) setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        destroyOnlyOfficeEditor(editorRef, initKeyRef, containerId);
        setStatus("error");
        setError(isViewMode
          ? "This Word document could not be opened in the online viewer."
          : (err?.message || "Failed to load ONLYOFFICE editor"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void mountEditor();
    return () => {
      cancelled = true;
      destroyOnlyOfficeEditor(editorRef, initKeyRef, containerId);
    };
  }, [containerId, isViewMode, session, sessionKey]);

  useEffect(() => {
    const previousOverflow = window.document.body.style.overflow;
    window.document.body.style.overflow = "hidden";
    const handleKeydown = (event) => {
      if (event.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [handleClose]);

  useEffect(() => {
    const timer = window.setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
    return () => window.clearTimeout(timer);
  }, [fullscreen]);

  async function download() {
    if (!downloadPath || downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      await apiDownload(downloadPath);
    } catch (err) {
      setDownloadError(err?.message || "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      className={`vilo-modal-overlay documents-onlyoffice-overlay${fullscreen ? " documents-onlyoffice-overlay--fullscreen" : ""}`}
      onClick={handleClose}
    >
      <section
        className={`vilo-modal documents-onlyoffice-modal${fullscreen ? " documents-onlyoffice-modal--fullscreen" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onlyoffice-document-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="vilo-modal__header documents-onlyoffice-modal__header">
          <div className="documents-onlyoffice-modal__heading">
            <h3 id="onlyoffice-document-title">{displayTitle}</h3>
            {!fullscreen ? <p className="documents-onlyoffice-modal__subcopy">{isViewMode ? "Word Document Viewer" : "Word Editor"}</p> : null}
          </div>
          <div className="documents-onlyoffice-modal__actions">
            {isViewMode && downloadPath ? (
              <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={download} disabled={downloading}>
                {downloading ? "Downloading..." : "Download"}
              </button>
            ) : null}
            <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setFullscreen((current) => !current)}>
              {fullscreen ? "Exit Full Screen" : "Full Screen"}
            </button>
            <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={handleClose}>Close</button>
          </div>
        </div>
        <div className="vilo-modal__body documents-onlyoffice-modal__body">
          {!fullscreen && !isViewMode ? (
            <div className="documents-onlyoffice-modal__meta">
              <p className="documents-edit-form__warning documents-edit-form__warning--compact documents-onlyoffice-modal__note">
                Edits are saved as a new version. Original versions are preserved.
              </p>
              <p className="documents-onlyoffice-modal__statusline">
                Autosave is enabled. Closing the editor preserves changes as a new version after ONLYOFFICE finishes saving.
              </p>
            </div>
          ) : null}
          <div className={`documents-onlyoffice-editor-shell${fullscreen ? " documents-onlyoffice-editor-shell--fullscreen" : ""}`}>
            <div id={containerId} className="documents-onlyoffice-editor" />
            {error ? (
              <div className="documents-onlyoffice-editor-status">
                <div className="protected-file-preview-message">
                  <p className="vilo-state vilo-state--error">{error}</p>
                  {isViewMode && downloadPath ? <button type="button" className="vilo-btn vilo-btn--primary" onClick={download} disabled={downloading}>{downloading ? "Downloading..." : "Download"}</button> : null}
                </div>
              </div>
            ) : null}
            {!error && (loading || status !== "ready") ? (
              <div className="documents-onlyoffice-editor-status">
                <p className="vilo-state">{isViewMode ? "Opening document preview..." : "Opening Word Editor..."}</p>
              </div>
            ) : null}
          </div>
          {downloadError ? <p className="vilo-state vilo-state--error protected-file-preview-download-error">{downloadError}</p> : null}
        </div>
      </section>
    </div>
  );
}

async function loadOnlyOfficeScript(documentServerUrl) {
  const src = `${String(documentServerUrl || "").replace(/\/$/, "")}/web-apps/apps/api/documents/api.js`;
  const existing = window.document.querySelector(`script[data-onlyoffice-src="${src}"]`);
  if (existing) {
    if (window.DocsAPI?.DocEditor) return;
    await waitForDocsAPI();
    return;
  }
  await new Promise((resolve, reject) => {
    const script = window.document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.onlyofficeSrc = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Failed to load ONLYOFFICE editor assets."));
    window.document.body.appendChild(script);
  });
}

async function waitForDocsAPI(timeoutMs = 4000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (window.DocsAPI?.DocEditor) return;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("ONLYOFFICE DocsAPI is unavailable.");
}

function destroyOnlyOfficeEditor(editorRef, initKeyRef, containerId) {
  if (editorRef.current?.destroyEditor) editorRef.current.destroyEditor();
  editorRef.current = null;
  initKeyRef.current = null;
  if (!containerId || typeof window === "undefined") return;
  const host = window.document.getElementById(containerId);
  if (host) host.replaceChildren();
}
