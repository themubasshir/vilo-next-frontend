"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiDownload, apiView } from "../lib/api";

const CLOSED_PREVIEW = {
  open: false,
  loading: false,
  filename: "",
  objectUrl: "",
  mediaType: "",
  previewType: "",
  downloadPath: "",
  error: "",
};

export function useProtectedFilePreview() {
  const [preview, setPreview] = useState(CLOSED_PREVIEW);
  const objectUrlRef = useRef("");
  const requestRef = useRef({ id: 0, controller: null });

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      window.URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = "";
    }
  }, []);

  const closePreview = useCallback(() => {
    requestRef.current.controller?.abort();
    requestRef.current = { id: requestRef.current.id + 1, controller: null };
    releaseObjectUrl();
    setPreview(CLOSED_PREVIEW);
  }, [releaseObjectUrl]);

  const openPreview = useCallback(async ({ path, downloadPath = "", filename = "File preview" }) => {
    requestRef.current.controller?.abort();
    releaseObjectUrl();

    const controller = new AbortController();
    const requestId = requestRef.current.id + 1;
    requestRef.current = { id: requestId, controller };
    setPreview({
      ...CLOSED_PREVIEW,
      open: true,
      loading: true,
      filename,
      downloadPath,
    });

    try {
      const result = await apiView(path, { signal: controller.signal, fallbackFilename: filename });
      if (requestRef.current.id !== requestId) return;

      const objectUrl = result.previewType === "unsupported"
        ? ""
        : window.URL.createObjectURL(result.blob);
      objectUrlRef.current = objectUrl;
      setPreview({
        open: true,
        loading: false,
        filename: result.filename || filename,
        objectUrl,
        mediaType: result.mediaType,
        previewType: result.previewType,
        downloadPath,
        error: "",
      });
    } catch (error) {
      if (error?.name === "AbortError" || requestRef.current.id !== requestId) return;
      setPreview({
        ...CLOSED_PREVIEW,
        open: true,
        filename,
        downloadPath,
        error: error?.message || "Document could not be loaded",
      });
    }
  }, [releaseObjectUrl]);

  useEffect(() => () => {
    requestRef.current.controller?.abort();
    releaseObjectUrl();
  }, [releaseObjectUrl]);

  return { preview, openPreview, closePreview };
}

export default function ProtectedFilePreviewModal({ preview, onClose }) {
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    if (!preview.open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, preview.open]);

  useEffect(() => {
    setDownloadError("");
    setRenderError(false);
  }, [preview.filename, preview.objectUrl, preview.open]);

  if (!preview.open) return null;

  async function download() {
    if (!preview.downloadPath || downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      await apiDownload(preview.downloadPath);
    } catch (error) {
      setDownloadError(error?.message || "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="vilo-modal-overlay protected-file-preview-overlay" onClick={onClose}>
      <section
        className="vilo-modal protected-file-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="protected-file-preview-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="vilo-modal__header protected-file-preview-header">
          <h3 id="protected-file-preview-title" title={preview.filename}>{preview.filename || "File preview"}</h3>
          <div className="protected-file-preview-actions">
            {preview.downloadPath ? (
              <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={download} disabled={downloading}>
                {downloading ? "Downloading..." : "Download"}
              </button>
            ) : null}
            <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={onClose} aria-label="Close preview">Close</button>
          </div>
        </div>

        <div className="vilo-modal__body protected-file-preview-body">
          {preview.loading ? <p className="vilo-state vilo-state--loading">Loading preview…</p> : null}

          {!preview.loading && preview.error ? (
            <div className="protected-file-preview-message">
              <p className="vilo-state vilo-state--error">Unable to preview this file.</p>
              <p>{preview.error}</p>
            </div>
          ) : null}

          {!preview.loading && !preview.error && !renderError && preview.previewType === "pdf" ? (
            <object className="protected-file-preview-pdf" data={preview.objectUrl} type="application/pdf" aria-label={`Preview of ${preview.filename}`} onError={() => setRenderError(true)}>
              <div className="protected-file-preview-message">
                <p>Preview unavailable. Download the file instead.</p>
                {preview.downloadPath ? <button type="button" className="vilo-btn vilo-btn--primary" onClick={download}>Download</button> : null}
              </div>
            </object>
          ) : null}

          {!preview.loading && !preview.error && !renderError && preview.previewType === "image" ? (
            <div className="protected-file-preview-image-wrap">
              <img className="protected-file-preview-image" src={preview.objectUrl} alt={preview.filename} onError={() => setRenderError(true)} />
            </div>
          ) : null}

          {!preview.loading && !preview.error && (renderError || preview.previewType === "unsupported") ? (
            <div className="protected-file-preview-message">
              <p>Preview unavailable. Download the file instead.</p>
              {preview.downloadPath ? <button type="button" className="vilo-btn vilo-btn--primary" onClick={download}>Download</button> : null}
            </div>
          ) : null}

          {downloadError ? <p className="vilo-state vilo-state--error protected-file-preview-download-error">{downloadError}</p> : null}
        </div>
      </section>
    </div>
  );
}
