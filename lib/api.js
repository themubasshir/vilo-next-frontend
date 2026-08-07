"use client";

import { clearAuth, getToken } from "./auth";

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

function safeErrorMessage(body, fallback) {
  const detail = body?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => item?.msg || item?.message || item?.detail)
      .filter(Boolean)
      .join("; ") || fallback;
  }
  if (detail && typeof detail === "object") {
    return detail.message || detail.detail || fallback;
  }
  return fallback;
}

function requestError(body, fallback, status) {
  const error = new Error(safeErrorMessage(body, fallback));
  error.errors = Array.isArray(body?.errors)
    ? body.errors
    : Array.isArray(body?.detail?.errors)
      ? body.detail.errors
      : [];
  error.status = status;
  return error;
}

export async function apiRequest(path, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    clearAuth();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw requestError(body, "Request failed", response.status);
  }

  return response.json();
}

async function authenticatedFileResponse(path, options = {}, fallback = "Request failed") {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    clearAuth();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw requestError(body, fallback, response.status);
  }

  return response;
}

function responseFilename(response) {
  const disposition = response.headers.get("content-disposition") || "";
  const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const basicMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  let filename = basicMatch?.[1] || "download";
  if (encodedMatch?.[1]) {
    try {
      filename = decodeURIComponent(encodedMatch[1]);
    } catch {
      filename = encodedMatch[1];
    }
  }
  return filename;
}

function triggerBlobDownload(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export async function apiDownload(path, options = {}) {
  const response = await authenticatedFileResponse(path, options, "Download failed");
  const blob = await response.blob();
  triggerBlobDownload(blob, responseFilename(response));
}

export async function apiUpload(path, formData, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    method: options.method || "POST",
    headers,
    body: formData,
  });

  if (response.status === 401) {
    clearAuth();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw requestError(body, "Upload failed", response.status);
  }

  return response.json();
}

export async function apiBlob(path, options = {}) {
  const response = await authenticatedFileResponse(path, options);
  return response.blob();
}

export async function apiView(path, options = {}) {
  const opened = window.open("about:blank", "_blank");
  if (!opened) {
    throw new Error("Document preview was blocked by the browser.");
  }
  opened.opener = null;

  try {
    const response = await authenticatedFileResponse(path, options, "Document could not be loaded");
    const blob = await response.blob();
    const mediaType = String(blob.type || "").split(";", 1)[0].toLowerCase();
    const previewable = mediaType === "application/pdf" || mediaType === "text/plain" || mediaType.startsWith("image/");

    if (!previewable) {
      opened.close();
      triggerBlobDownload(blob, responseFilename(response));
      return { mode: "download" };
    }

    const url = window.URL.createObjectURL(blob);
    opened.location.replace(url);
    window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
    return { mode: "preview" };
  } catch (error) {
    opened.close();
    throw error;
  }
}
