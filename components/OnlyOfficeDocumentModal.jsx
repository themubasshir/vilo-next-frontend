"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDownload, apiRequest } from "../lib/api";

let onlyOfficeInstanceCounter = 0;
const onlyOfficeScriptPromises = new Map();
const ONLYOFFICE_SCRIPT_TIMEOUT_MS = 10000;
const ONLYOFFICE_OPEN_TIMEOUT_MS = 30000;

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
  const [retryNonce, setRetryNonce] = useState(0);
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
    const controller = new AbortController();

    async function createSession() {
      setSession(null);
      setLoading(true);
      setStatus("preparing");
      setError("");
      setDownloadError("");
      try {
        const suffix = isViewMode ? "?mode=view" : "?mode=edit";
        const response = await apiRequest(`/api/v1/documents/${document.id}/onlyoffice/session${suffix}`, {
          method: "POST",
          signal: controller.signal,
        });
        if (!response?.document_server_url || !response?.editor_config) {
          throw new Error("Backend returned an incomplete ONLYOFFICE session.");
        }
        if (!cancelled) setSession(response);
      } catch (err) {
        if (cancelled || err?.name === "AbortError") return;
        setLoading(false);
        setStatus("error");
        setError(isViewMode
          ? "Online viewer could not be prepared."
          : "Online editor could not be prepared.");
      }
    }

    void createSession();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [document?.id, isViewMode, retryNonce]);

  useEffect(() => {
    if (!session?.document_server_url || !containerId) return undefined;
    if (typeof window === "undefined") return undefined;
    let cancelled = false;
    let openingTimer;

    function failToOpen() {
      if (cancelled) return;
      window.clearTimeout(openingTimer);
      setLoading(false);
      setStatus("error");
      setError(isViewMode
        ? "Online viewer could not open this document."
        : "Online editor could not open this document.");
    }

    async function mountEditor() {
      setLoading(true);
      setError("");
      setStatus("script");
      openingTimer = window.setTimeout(failToOpen, ONLYOFFICE_OPEN_TIMEOUT_MS);
      try {
        await loadOnlyOfficeScript(session.document_server_url);
        if (cancelled) return;
        if (!window.DocsAPI?.DocEditor) throw new Error("ONLYOFFICE DocsAPI is unavailable.");

        if (editorRef.current && initKeyRef.current === sessionKey) return;

        destroyOnlyOfficeEditor(editorRef, initKeyRef, containerId);
        const host = window.document.getElementById(containerId);
        if (!host) throw new Error("ONLYOFFICE document container was not found.");
        host.replaceChildren();
        setStatus("opening");
        editorRef.current = new window.DocsAPI.DocEditor(containerId, {
          ...session.editor_config,
          events: {
            onDocumentReady: () => {
              if (cancelled) return;
              window.clearTimeout(openingTimer);
              setError("");
              setLoading(false);
              setStatus("ready");
            },
            onError: failToOpen,
          },
        });
        initKeyRef.current = sessionKey;
      } catch (err) {
        if (cancelled) return;
        destroyOnlyOfficeEditor(editorRef, initKeyRef, containerId);
        failToOpen();
      }
    }

    void mountEditor();
    return () => {
      cancelled = true;
      window.clearTimeout(openingTimer);
      destroyOnlyOfficeEditor(editorRef, initKeyRef, containerId);
    };
  }, [containerId, isViewMode, session, sessionKey]);

  const retry = useCallback(() => {
    destroyOnlyOfficeEditor(editorRef, initKeyRef, containerId);
    setSession(null);
    setError("");
    setDownloadError("");
    setLoading(true);
    setStatus("preparing");
    setRetryNonce((current) => current + 1);
  }, [containerId]);

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
            {downloadPath ? (
              <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={download} disabled={downloading}>
                {downloading ? "Downloading..." : "Download"}
              </button>
            ) : null}
            {!error ? (
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setFullscreen((current) => !current)}>
                {fullscreen ? "Exit Full Screen" : "Full Screen"}
              </button>
            ) : null}
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
              <div className="documents-onlyoffice-editor-status" role="alert">
                <div className="protected-file-preview-message">
                  <p className="vilo-state vilo-state--error">{error}</p>
                  <div className="vilo-table-actions">
                    <button type="button" className="vilo-btn vilo-btn--primary" onClick={retry}>Retry</button>
                    {downloadPath ? <button type="button" className="vilo-btn vilo-btn--secondary" onClick={download} disabled={downloading}>{downloading ? "Downloading..." : "Download"}</button> : null}
                    <button type="button" className="vilo-btn vilo-btn--ghost" onClick={handleClose}>Close</button>
                  </div>
                </div>
              </div>
            ) : null}
            {!error && (loading || status !== "ready") ? (
              <div className="documents-onlyoffice-editor-status" role="status" aria-live="polite">
                <div className="protected-file-preview-message">
                  <span className="protected-file-preview-spinner" aria-hidden="true" />
                  <p className="vilo-state">{loadingMessage(status, isViewMode)}</p>
                </div>
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
  if (window.DocsAPI?.DocEditor) return;
  if (onlyOfficeScriptPromises.has(src)) return onlyOfficeScriptPromises.get(src);

  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let script = Array.from(window.document.scripts).find((item) => item.dataset.onlyofficeSrc === src);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      script?.removeEventListener("load", handleLoad);
      script?.removeEventListener("error", handleError);
      if (error) reject(error);
      else resolve();
    };
    const handleLoad = async () => {
      try {
        await waitForDocsAPI();
        finish();
      } catch (error) {
        finish(error);
      }
    };
    const handleError = () => {
      script?.remove();
      finish(new Error("Failed to load ONLYOFFICE editor assets."));
    };
    const timeout = window.setTimeout(() => {
      script?.remove();
      finish(new Error("ONLYOFFICE editor assets timed out."));
    }, ONLYOFFICE_SCRIPT_TIMEOUT_MS);

    if (!script) {
      script = window.document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.onlyofficeSrc = src;
      script.addEventListener("load", handleLoad, { once: true });
      script.addEventListener("error", handleError, { once: true });
      window.document.body.appendChild(script);
    } else {
      script.addEventListener("error", handleError, { once: true });
      // The tag may have completed before this component subscribed. One
      // shared readiness poll is still bounded by the outer asset timeout.
      void handleLoad();
    }
    if (window.DocsAPI?.DocEditor) finish();
  });
  onlyOfficeScriptPromises.set(src, promise);
  try {
    await promise;
  } catch (error) {
    onlyOfficeScriptPromises.delete(src);
    throw error;
  }
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

function loadingMessage(status, isViewMode) {
  if (status === "preparing") return isViewMode ? "Preparing viewer..." : "Preparing editor...";
  if (status === "script") return isViewMode ? "Loading viewer..." : "Loading editor...";
  return "Opening document...";
}
