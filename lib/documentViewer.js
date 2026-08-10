const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function normalizedMediaType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function filenameExtension(filename) {
  const match = String(filename || "").trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

export function getDocumentViewerType({ filename = "", mediaType = "" } = {}) {
  const normalizedType = normalizedMediaType(mediaType);
  const extension = filenameExtension(filename);

  if (normalizedType === DOCX_MEDIA_TYPE) return "onlyoffice";
  if (normalizedType === "application/pdf") return "pdf";
  if (IMAGE_MEDIA_TYPES.has(normalizedType)) return "image";

  if (extension === "docx") return "onlyoffice";
  if (extension === "pdf") return "pdf";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(extension)) return "image";
  return "unsupported";
}
