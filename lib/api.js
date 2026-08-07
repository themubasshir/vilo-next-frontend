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

const PREVIEW_MEDIA_TYPES = new Map([
  ["application/pdf", "pdf"],
  ["image/jpeg", "image"],
  ["image/png", "image"],
  ["image/gif", "image"],
  ["image/webp", "image"],
]);

const GENERIC_MEDIA_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

const PREVIEW_EXTENSION_TYPES = new Map([
  ["pdf", "application/pdf"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);

function normalizedMediaType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function filenameExtension(filename) {
  const match = String(filename || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

function bytesStartWith(bytes, expected) {
  return expected.every((value, index) => bytes[index] === value);
}

async function hasExpectedFileSignature(blob, mediaType) {
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (mediaType === "application/pdf") return bytesStartWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  if (mediaType === "image/jpeg") return bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
  if (mediaType === "image/png") return bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mediaType === "image/gif") {
    return bytesStartWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
      || bytesStartWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  }
  if (mediaType === "image/webp") {
    return bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46])
      && bytesStartWith(bytes.slice(8), [0x57, 0x45, 0x42, 0x50]);
  }
  return true;
}

async function successfulResponseError(blob, mediaType) {
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    const body = await blob.text().then((text) => JSON.parse(text)).catch(() => ({}));
    return requestError(body, "Unable to preview this file.");
  }
  if (mediaType === "text/html") return new Error("The server returned an HTML page instead of a file.");
  return null;
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
  const { fallbackFilename = "", ...requestOptions } = options;
  const response = await authenticatedFileResponse(path, requestOptions, "Document could not be loaded");
  const blob = await response.blob();
  if (!blob.size) throw new Error("The file is empty and cannot be previewed.");

  const filename = responseFilename(response) === "download"
    ? (fallbackFilename || "download")
    : responseFilename(response);
  const responseType = normalizedMediaType(response.headers.get("content-type"));
  const blobType = normalizedMediaType(blob.type);
  let mediaType = responseType || blobType;

  const responseError = await successfulResponseError(blob, mediaType);
  if (responseError) throw responseError;

  if (GENERIC_MEDIA_TYPES.has(mediaType)) {
    mediaType = PREVIEW_EXTENSION_TYPES.get(filenameExtension(filename)) || mediaType || "application/octet-stream";
  }

  const previewType = PREVIEW_MEDIA_TYPES.get(mediaType) || "unsupported";
  if (previewType !== "unsupported" && !(await hasExpectedFileSignature(blob, mediaType))) {
    throw new Error("The server response does not contain a valid preview file.");
  }

  const previewBlob = blob.type === mediaType ? blob : new Blob([blob], { type: mediaType });
  return { blob: previewBlob, filename, mediaType, previewType };
}
