import json
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_shared_viewer_recognizes_txt_mime_extension_case_and_rejects_binary():
    script = """
      import { getDocumentViewerType } from './lib/documentViewer.js';
      const values = [
        getDocumentViewerType({ filename: 'notes.bin', mediaType: 'text/plain; charset=utf-8' }),
        getDocumentViewerType({ filename: 'notes.txt', mediaType: '' }),
        getDocumentViewerType({ filename: 'NOTES.TXT', mediaType: 'application/octet-stream' }),
        getDocumentViewerType({ filename: 'archive.bin', mediaType: 'application/octet-stream' }),
        getDocumentViewerType({ filename: 'contract.docx', mediaType: 'text/plain' }),
      ];
      console.log(JSON.stringify(values));
    """
    result = subprocess.run(
        ["node", "--experimental-default-type=module", "--input-type=module", "-e", script],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(result.stdout) == ["text", "text", "text", "unsupported", "onlyoffice"]


def test_txt_renderer_is_plain_text_and_shared_entry_points_use_protected_preview():
    modal = (REPO_ROOT / "components/ProtectedFilePreviewModal.jsx").read_text()
    api = (REPO_ROOT / "lib/api.js").read_text()
    assert 'preview.previewType === "text"' in modal
    assert '<pre className="protected-file-preview-text">{preview.textContent}</pre>' in modal
    assert "dangerouslySetInnerHTML" not in modal
    assert 'previewType === "text" ? await previewBlob.text()' in api
    assert 'window.URL.revokeObjectURL' in modal

    for relative in (
        "app/dashboard/documents/page.jsx",
        "app/dashboard/clients/[id]/page.jsx",
        "app/dashboard/cases/[id]/page.jsx",
        "app/dashboard/messages/page.jsx",
        "app/dashboard/precedents/page.jsx",
    ):
        source = (REPO_ROOT / relative).read_text()
        assert "useProtectedFilePreview" in source
        assert "/view" in source
        assert "downloadPath" in source


def test_client_timeline_view_actions_are_styled_and_keep_exact_targets():
    source = (REPO_ROOT / "app/dashboard/clients/[id]/page.jsx").read_text()
    timeline = source[source.index("{timelineRows.map"):source.index("</tbody>", source.index("{timelineRows.map"))]
    assert '<Link href={row.href}>View</Link>' not in timeline
    assert 'vilo-btn vilo-btn--secondary vilo-btn--xs' in timeline
    assert "openTimelineDocument(row)" in timeline
    assert "row.href" in timeline
    assert "id: row.documentId" in source


def test_priority_timeline_menu_and_one_action_fallback_are_semantic():
    source = (REPO_ROOT / "components/dashboard/TodaysOverview.jsx").read_text()
    dashboard = (REPO_ROOT / "app/dashboard/page.jsx").read_text()
    styles = (REPO_ROOT / "app/globals.css").read_text()
    assert "•••" in source
    assert 'className="priority-action-wrap"' in source
    wrapper_styles = styles.split(".priority-action-wrap {", 1)[1].split("}", 1)[0]
    menu_styles = styles.split(".case-actions-menu.priority-timeline-action-menu {", 1)[1].split("}", 1)[0]
    assert "position: relative;" in wrapper_styles
    assert "position: fixed" not in menu_styles
    assert 'aria-haspopup="menu"' in source
    assert 'aria-label="Task actions"' in source
    assert 'aria-expanded={openTaskMenuId === rowKey}' in source
    assert 'role="menu"' in source and 'role="menuitem"' in source
    assert 'event.key === "Escape"' in source
    assert 'document.addEventListener("pointerdown"' in source
    assert "actionWrapRefs.current.get(openTaskMenuId)" in source
    assert 'aria-label={`View task ${row.label}`}' in source
    assert '>\n                          View\n                        </Link>' in source
    assert 'onClick={(event) => toggleMenu(event, rowKey, actions.length)}' in source
    assert "event.stopPropagation();" in source
    assert 'href={actions[0].href}' in source
    assert 'const [openTaskMenuId, setOpenTaskMenuId] = useState(null);' in source
    assert "style={{ left:" not in source
    assert 'label: "View Task", href: `/dashboard/tasks/${task.id}`' in dashboard


def test_priority_timeline_actions_reuse_task_workflows_and_permissions():
    dashboard = (REPO_ROOT / "app/dashboard/page.jsx").read_text()
    assert 'apiRequest(`/api/v1/tasks/${taskId}/complete`, { method: "POST" })' in dashboard
    assert '.filter((task) => Number(task.id) !== Number(taskId))' in dashboard
    assert 'canCompleteTask && !taskIsComplete' in dashboard
    assert '["admin", "partner", "lawyer", "paralegal"].includes(role)' in dashboard
    assert 'role === "admin" || role === "partner"' in dashboard
    assert 'label: "Edit Task", href: `/dashboard/tasks/${task.id}?edit=1`' in dashboard
    assert 'accessibleCaseIds.has(linkedCaseId)' in dashboard
    assert 'label: "Open File"' in dashboard
    assert 'href: `/dashboard/cases/${linkedCaseId}`' in dashboard
    assert "Open Related Case/File" not in dashboard
    assert dashboard.index('label: "View Task"') < dashboard.index('label: "Edit Task"') < dashboard.index('label: "Mark Complete"') < dashboard.index('label: "Open File"')


def test_precedent_frontend_paralegal_management_is_local_and_delete_is_not_exposed():
    source = (REPO_ROOT / "app/dashboard/precedents/page.jsx").read_text()
    assert 'role === "partner" || role === "admin" || role === "paralegal"' in source
    assert "New Precedent" in source
    assert "Edit Master" in source
    assert "Copy to File" in source
    assert ">Delete<" not in source
