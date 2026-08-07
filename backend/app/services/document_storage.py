import os
import re
import mimetypes
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, status


ALLOWED_EXTENSIONS = {"pdf", "doc", "docx", "jpg", "jpeg", "png", "txt"}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
GENERIC_MEDIA_TYPES = {"", "application/octet-stream", "binary/octet-stream"}


def safe_original_name(original: str) -> str:
    name = os.path.basename((original or "").strip())
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid file name")
    return name


def validate_extension(file_name: str, allowed_extensions: set[str] | None = None) -> str:
    parts = file_name.rsplit(".", 1)
    if len(parts) != 2:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File extension is required")
    ext = parts[1].lower()
    allowed = allowed_extensions or ALLOWED_EXTENSIONS
    if ext not in allowed:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported file type")
    return ext


def persist_file(storage_root: Path, organization_id: int, original_name: str, data: bytes) -> tuple[str, str]:
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File exceeds upload size limit")

    ext = validate_extension(original_name)
    resolved_root = storage_root if storage_root.is_absolute() else REPOSITORY_ROOT / storage_root
    org_dir = resolved_root / str(organization_id)
    org_dir.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid4().hex}.{ext}"
    file_path = org_dir / stored_name
    file_path.write_bytes(data)
    return str(file_path), stored_name


def resolve_stored_file(file_reference: str | None, storage_root: Path) -> Path:
    """Resolve a persisted reference inside its approved storage root.

    Historical rows contain repository-relative paths, while services may start
    with either the repository or backend directory as cwd.
    """
    if not file_reference:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    approved_root = (storage_root if storage_root.is_absolute() else REPOSITORY_ROOT / storage_root).resolve()
    approved_roots = [approved_root]
    if not storage_root.is_absolute():
        approved_roots.append((REPOSITORY_ROOT / "backend" / storage_root).resolve())
    raw = Path(file_reference)
    candidates = [raw.resolve()] if raw.is_absolute() else [
        (REPOSITORY_ROOT / raw).resolve(),
        (REPOSITORY_ROOT / "backend" / raw).resolve(),
    ]
    for candidate in candidates:
        if not any(candidate.is_relative_to(root) for root in approved_roots):
            continue
        if candidate.is_file():
            return candidate
    if any(any(candidate.is_relative_to(root) for root in approved_roots) for candidate in candidates):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Stored file not found")
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")


def resolved_media_type(file_name: str | None, stored_media_type: str | None) -> str:
    """Resolve MIME from the validated display filename, then stored metadata."""
    guessed, _encoding = mimetypes.guess_type(file_name or "")
    if guessed:
        return guessed
    normalized = (stored_media_type or "").split(";", 1)[0].strip().lower()
    if normalized not in GENERIC_MEDIA_TYPES:
        return normalized
    return "application/octet-stream"


def build_text_filename(name: str, fallback_stem: str = "document") -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", (name or "").strip()).strip("-.")
    if not stem:
        stem = fallback_stem
    if "." in stem:
        stem = stem.rsplit(".", 1)[0]
    return f"{stem}.txt"
