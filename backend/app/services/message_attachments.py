"""Validation for private message files; no public or general Document records."""
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from fastapi import HTTPException, UploadFile
from app.services.document_storage import MAX_UPLOAD_BYTES, safe_original_name, validate_extension, resolved_media_type

STORAGE_ROOT = Path(__file__).resolve().parents[2] / "storage" / "message_attachments"
# No existing message attachment count policy: Phase 3 allows five per message.
MAX_MESSAGE_ATTACHMENTS = 5


async def validate_attachment(file: UploadFile) -> tuple[str, str, bytes]:
    original = (file.filename or "").replace("\\", "/")
    if any(ord(char) < 32 or ord(char) == 127 for char in original):
        raise HTTPException(400, "Invalid file name")
    name = safe_original_name(original)
    if len(name) > 255:
        raise HTTPException(400, "File name is too long")
    extension = validate_extension(name)
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "File exceeds upload size limit")
    valid = True
    if extension == "pdf":
        valid = data.startswith(b"%PDF-") and b"%%EOF" in data[-1024:]
    elif extension in {"jpg", "jpeg"}:
        valid = data.startswith(b"\xff\xd8\xff")
    elif extension == "png":
        valid = data.startswith(b"\x89PNG\r\n\x1a\n")
    elif extension == "doc":
        valid = data.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
    elif extension == "docx":
        try:
            with ZipFile(BytesIO(data)) as archive:
                valid = {"[Content_Types].xml", "word/document.xml"} <= set(archive.namelist())
        except BadZipFile:
            valid = False
    elif extension == "txt":
        try:
            data.decode("utf-8")
            valid = b"\x00" not in data
        except UnicodeDecodeError:
            valid = False
    if not valid:
        raise HTTPException(400, "File content does not match its extension")
    # Normalize MIME from the validated extension, never browser Content-Type.
    return name, resolved_media_type(name, None), data
