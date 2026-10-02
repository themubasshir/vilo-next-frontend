"""Presentation contracts and real persisted event actor projections."""
from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess

import pytest
from app.models.case_timeline_event import CaseTimelineEvent
from test_precedent_document_workflow import workflow  # noqa: F401

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("surface", ["dashboard", "portal"])
def test_receipt_is_outside_bubble_and_timestamp_inside(surface):
    source = (ROOT / f"app/{surface}/messages/page.jsx").read_text()
    assert re.search(r'message-bubble__time">\{formatBubbleTime\(msg.created_at\)\}</span>\s*</div>\s*\{mine \? <MessageReceipt status=\{msg.delivery_status\} readAt=\{msg.read_at\}', source)
    receipt = (ROOT / "components/MessageReceipt.jsx").read_text()
    assert 'status === "read" && Boolean(readAt)' in receipt
    assert 'delivered ? "✓✓" : "✓"' in receipt
    assert '`Read ${time}`' in receipt
    assert 'aria-label={label}' in receipt
    css = (ROOT / "app/globals.css").read_text()
    assert '.message-receipt.is-read { color: #2583eb; }' in css
    assert 'letter-spacing: -0.2em' not in css


def test_timeline_columns_display_and_exact_actions():
    source = (ROOT / "app/dashboard/cases/[id]/page.jsx").read_text()
    table = source.split('className="team-table case-timeline-table"', 1)[1].split('</table>', 1)[0]
    assert re.findall(r'<th>(.*?)</th>', table) == ["Title", "Event Type", "Event Date", "Time", "User", "Actions"]
    assert '{formatTimelineEventType(row.eventType)}' in table
    assert '{fmtDate(row.timestamp)}' in table
    assert '{formatTimelineTime(row.timestamp)}' in table
    assert '{row.actorName}' in table
    assert 'actorName: entry.actor_name || "—"' in source
    assert 'timestamp: entry.created_at' in source
    assert 'setMenuOpenId(menuOpenId === row.id ? null : row.id)' in table
    assert 'openModal("view", row)' in table
    assert 'document_id=${encodeURIComponent(selectedRow.metadata.document_id)}' in source
    assert '/dashboard/tasks/${encodeURIComponent(selectedRow.metadata.task_id)}' in source
    # Task panels and manual event forms still retain their existing controls.
    assert '{labelize(t.status)}' in source
    assert 'completed: row.completed === "Yes"' in source


def test_event_formatters_known_types_fallback_and_local_time():
    script = """
      import assert from 'node:assert/strict';
      import {formatTimelineEventType as type, formatTimelineTime as time} from './lib/timeline.js';
      import {formatViloDate} from './lib/dateFormat.js';
      assert.equal(type('Document_onlyoffice_edited'), 'Document Edited');
      assert.equal(type('DOCUMENT_ONLYOFFICE_EDITED'), 'Document Edited');
      assert.equal(type('document_uploaded'), 'Document Uploaded');
      assert.equal(type('task-completed'), 'Task Completed');
      assert.equal(type('custom_onlyoffice_event'), 'Custom Event');
      assert.equal(type(null), 'Event');
      const stamp = new Date(2026, 9, 2, 14, 7);
      assert.equal(time(stamp), '2:07 PM');
      assert.equal(formatViloDate(stamp), '02/10/2026');
      assert.equal(time(new Date(2026, 9, 2, 0, 3)), '12:03 AM');
      assert.equal(time(null), '—');
      assert.equal(time('invalid'), '—');
    """
    subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, check=True, capture_output=True)


@pytest.mark.asyncio
async def test_timeline_projects_each_historical_actor_without_inventing_or_leaking_names(workflow):
    client, sessions, actor = workflow
    stamp = datetime(2026, 10, 2, 14, 7, tzinfo=timezone.utc)
    async with sessions() as db:
        for event_id, actor_id, event_type in [(1, 1, 'document_uploaded'), (2, 3, 'document_onlyoffice_edited'), (3, None, 'legacy_event'), (4, 2, 'legacy_event')]:
            db.add(CaseTimelineEvent(id=event_id, organization_id=1, case_id=1,
                actor_id=actor_id, event_type=event_type, title=f'Historical {event_id}',
                created_at=stamp, metadata_json={'document_id': 51}))
        await db.commit()
    response = await client.get('/api/v1/cases/1/timeline')
    assert response.status_code == 200, response.text
    rows = {row['id']: row for row in response.json()}
    assert rows[1]['actor_name'] == 'Staff 1'
    assert rows[2]['actor_name'] == 'Staff 3'
    assert rows[3]['actor_name'] is None
    assert rows[4]['actor_name'] is None  # Foreign organization actor never resolves.
    assert rows[2]['event_type'] == 'document_onlyoffice_edited'
    assert rows[2]['metadata']['document_id'] == 51
    assert rows[2]['created_at'].startswith('2026-10-02T14:07:00')
    actor['id'] = 2
    assert (await client.get('/api/v1/cases/1/timeline')).status_code == 404


@pytest.mark.asyncio
async def test_document_upload_and_later_edit_keep_the_original_event_actor(workflow):
    client, _sessions, actor = workflow
    uploaded = await client.post('/api/v1/documents/upload', data={'title': 'TEST1', 'case_id': '1'},
        files={'file': ('test.txt', b'Original', 'text/plain')})
    assert uploaded.status_code == 200, uploaded.text
    document_id = uploaded.json()['id']
    await client.patch('/api/v1/cases/1', json={'assigned_user_ids': [3]})
    actor['id'] = 3
    replaced = await client.post(f'/api/v1/documents/{document_id}/replace',
        files={'file': ('test.txt', b'Edited by another user', 'text/plain')})
    assert replaced.status_code == 200, replaced.text
    rows = (await client.get('/api/v1/cases/1/timeline')).json()
    upload = next(row for row in rows if row['event_type'] == 'document_uploaded')
    replace = next(row for row in rows if row['event_type'] == 'document_replaced')
    assert upload['actor_name'] == 'Staff 1'
    assert replace['actor_name'] == 'Staff 3'
    assert upload['metadata']['document_id'] == replace['metadata']['document_id'] == document_id
