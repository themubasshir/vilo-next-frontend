"""Static regressions for Final Batch 3 frontend state and intake UX."""
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_messages_unread_filter_uses_server_count_search_and_url_state():
    source = (REPO_ROOT / "app/dashboard/messages/page.jsx").read_text()
    assert 'filter === "unread" && !(conv.unread_count > 0)' in source
    assert "return blob.includes(q)" in source
    assert 'updateRoute({ filter: nextFilter === "all" ? null : nextFilter })' in source
    assert '["unread", "internal", "client", "group"].includes(routeFilter)' in source
    assert 'conv.unread_count > 0 ? " is-unread" : ""' in source
    assert '`${conv.unread_count} unread messages` : "Read"' in source
    assert 'conv.unread_count > 0 ? <em>{conv.unread_count} new</em> : null' in source


def test_messages_only_acknowledge_visible_selected_fetched_thread():
    source = (REPO_ROOT / "app/dashboard/messages/page.jsx").read_text()
    assert 'if (selectedRef.current?.id !== conversationId) return;' in source
    assert 'document.visibilityState !== "visible" || !threadVisible.current' in source
    assert 'read_through=${encodeURIComponent(latest.created_at)}' in source
    assert 'new Date(conv.latest_message.created_at) <= new Date(latest.created_at)' in source
    assert 'if (document.visibilityState === "visible") refresh(true)' in source


def test_client_intake_multiple_id_selection_is_explicit_and_per_file():
    source = (REPO_ROOT / "components/dashboard/ClientIntakeModal.jsx").read_text()
    assert "<p>Upload IDs</p>" in source
    assert "Upload one or more identification documents." in source
    assert "selected for upload" in source
    assert "Drag &amp; drop ID files here" in source
    assert "PDF, DOC/DOCX, JPG, PNG — max 10MB each." in source
    assert "multiple" in source
    assert "+ Add another ID" in source
    assert "Ready to upload" in source
    assert "formatFileSize(entry.file.size)" in source
    assert "current.filter((item) => item.key !== entry.key)" in source
    assert "current.map((item) => item.key === entry.key ? { ...item, idType: event.target.value } : item)" in source
    assert "Selected replacement" not in source


def test_client_intake_submission_keeps_ids_and_documents_separate():
    source = (REPO_ROOT / "app/dashboard/clients/page.jsx").read_text()
    create_position = source.index('selectedDraft ? `/api/v1/clients/intake-drafts/${selectedDraft.id}/complete')
    ids_position = source.index("Promise.allSettled(selectedIds.map", create_position)
    documents_position = source.index("Promise.allSettled(clientDocuments.map", ids_position)
    assert create_position < ids_position < documents_position
    assert 'apiUpload(`/api/v1/clients/${clientId}/id-documents`' in source
    assert 'data.append("category", "client_records")' in source
    assert "Could not upload:" in source
