"""Persisted receipts, editor accountability, case classification and UI regressions."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy import select

from test_message_document_notifications import messaging, new_message  # noqa: F401
from test_precedent_document_workflow import workflow, create_precedent  # noqa: F401
from app.models.case import Case
from app.models.message_receipt import MessageReceipt
from app.models.user import User
from app.schemas.case_practice_area import CasePracticeArea


async def message(client, cid, mid):
    response = await client.get(f'/api/v1/conversations/{cid}/messages')
    assert response.status_code == 200, response.text
    return next(row for row in response.json() if row['id'] == mid)


@pytest.mark.asyncio
async def test_direct_delivery_no_sender_receipt_no_read_from_gets(messaging):
    client, sessions, actor = messaging
    cid, sent = await new_message(client)
    assert sent['delivery_status'] == 'delivered' and sent['recipient_count'] == 1
    assert sent['read_count'] == 0 and sent['read_at'] is None
    async with sessions() as db:
        receipts = (await db.scalars(select(MessageReceipt))).all()
        assert [r.user_id for r in receipts] == [3]
        assert receipts[0].delivered_at is not None and receipts[0].read_at is None
    actor['id'] = 3
    for path in ('/api/v1/conversations', f'/api/v1/conversations/{cid}', f'/api/v1/conversations/{cid}/messages', '/api/v1/reports/dashboard/widgets'):
        assert (await client.get(path)).status_code == 200
    async with sessions() as db:
        assert (await db.scalar(select(MessageReceipt))).read_at is None
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['unread_count'] == 1


@pytest.mark.asyncio
async def test_first_read_write_once_boundary_sender_cannot_spoof(messaging):
    client, _sessions, actor = messaging
    cid, first = await new_message(client)
    second = (await client.post(f'/api/v1/conversations/{cid}/messages', json={'body': 'Later'})).json()
    assert (await client.post(f'/api/v1/conversations/{cid}/mark-read', params={'user_id': 3})).status_code == 200
    assert (await message(client, cid, first['id']))['read_at'] is None
    actor['id'] = 3
    assert (await client.post(f'/api/v1/conversations/{cid}/mark-read', params={'read_through': first['created_at']})).status_code == 200
    read = await message(client, cid, first['id'])
    assert read['delivery_status'] == 'read' and read['read_at'] is not None
    assert (await message(client, cid, second['id']))['delivery_status'] == 'delivered'
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['unread_count'] == 1
    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.now(timezone.utc) + timedelta(hours=2)
    with patch('app.api.v1.conversations.datetime', Later):
        await client.post(f'/api/v1/conversations/{cid}/mark-read')
    assert (await message(client, cid, first['id']))['read_at'] == read['read_at']
    assert (await message(client, cid, second['id']))['delivery_status'] == 'read'
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['unread_count'] == 0


@pytest.mark.asyncio
async def test_group_all_read_latest_first_read_membership_snapshot(messaging):
    client, sessions, actor = messaging
    cid = (await client.post('/api/v1/conversations', json={'title': 'Group', 'conversation_type': 'group', 'participant_ids': [3, 4]})).json()['id']
    sent = (await client.post(f'/api/v1/conversations/{cid}/messages', json={'body': 'Group review'})).json()
    assert sent['recipient_count'] == 2 and sent['delivery_status'] == 'delivered'
    actor['id'] = 3
    await client.post(f'/api/v1/conversations/{cid}/mark-read')
    partial = await message(client, cid, sent['id'])
    assert partial['read_count'] == 1 and partial['delivery_status'] == 'delivered' and partial['read_at'] is None
    async with sessions() as db:
        rows = (await db.scalars(select(MessageReceipt).order_by(MessageReceipt.user_id))).all()
        assert rows[0].read_at is not None and rows[1].read_at is None
    actor['id'] = 4
    await client.post(f'/api/v1/conversations/{cid}/mark-read')
    complete = await message(client, cid, sent['id'])
    assert complete['delivery_status'] == 'read' and complete['read_count'] == 2
    async with sessions() as db:
        rows = (await db.scalars(select(MessageReceipt))).all()
        assert datetime.fromisoformat(complete['read_at']).replace(tzinfo=None) == max(r.read_at for r in rows)
    actor['id'] = 1
    await client.post(f'/api/v1/conversations/{cid}/participants', json={'user_id': 6})
    assert (await message(client, cid, sent['id']))['recipient_count'] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize('uid', [2, 4, 5, 6])
async def test_receipt_access_denies_foreign_org_nonmember_client(messaging, uid):
    client, _sessions, actor = messaging
    cid, _sent = await new_message(client)
    actor['id'] = uid
    for method, path in [('get', f'/api/v1/conversations/{cid}/messages'), ('get', f'/api/v1/conversations/{cid}'), ('post', f'/api/v1/conversations/{cid}/mark-read')]:
        assert (await getattr(client, method)(path)).status_code in (403, 404)


@pytest.mark.asyncio
async def test_pending_receipt_summary_is_sent(messaging):
    client, sessions, _actor = messaging
    cid, sent = await new_message(client)
    async with sessions() as db:
        (await db.scalar(select(MessageReceipt))).delivered_at = None
        await db.commit()
    assert (await message(client, cid, sent['id']))['delivery_status'] == 'sent'


async def upload(client, content=b'Initial'):
    response = await client.post('/api/v1/documents/upload', data={'title': 'Shared review', 'case_id': '1'}, files={'file': ('shared.txt', content, 'text/plain')})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_document_rename_replace_version_actor_snapshot_reads(workflow):
    client, sessions, actor = workflow
    document = await upload(client)
    did = document['id']
    assert document['last_edited_by_user_id'] == 1 and document['last_edited_by_name'] == 'Staff 1'
    renamed = (await client.patch(f'/api/v1/documents/{did}', json={'title': 'Renamed'})).json()
    assert renamed['last_edited_at'] != document['last_edited_at']
    async with sessions() as db:
        (await db.get(User, 1)).name = 'Changed display name'
        await db.commit()
    for action in ('view', 'download'):
        assert (await client.get(f'/api/v1/documents/{did}/{action}')).status_code == 200
    queried = (await client.get(f'/api/v1/documents/{did}')).json()
    assert queried['last_edited_by_name'] == 'Staff 1' and queried['last_edited_at'] == renamed['last_edited_at']
    unchanged = (await client.patch(f'/api/v1/documents/{did}', json={'title': 'Renamed'})).json()
    assert unchanged['last_edited_at'] == renamed['last_edited_at']
    assert (await client.patch('/api/v1/cases/1', json={'assigned_user_ids': [3]})).status_code == 200
    actor['id'] = 3
    replaced = await client.post(f'/api/v1/documents/{did}/replace', files={'file': ('shared.txt', b'User B replacement', 'text/plain')})
    assert replaced.status_code == 200, replaced.text
    replacement = replaced.json()
    assert replacement['last_edited_by_user_id'] == 3 and replacement['last_edited_by_name'] == 'Staff 3'
    assert replacement['last_edited_at'] != renamed['last_edited_at']
    version = await client.post(f'/api/v1/documents/{did}/editable-content', json={'content': 'New text version'})
    assert version.status_code == 200, version.text
    assert version.json()['last_edited_by_user_id'] == 3 and version.json()['last_edited_at'] != replacement['last_edited_at']
    for action in ('view', 'download', 'editable-content', 'versions'):
        assert (await client.get(f'/api/v1/documents/{did}/{action}')).status_code == 200
    assert (await client.get(f'/api/v1/documents/{did}')).json()['last_edited_at'] == version.json()['last_edited_at']
    actor['id'] = 2
    assert (await client.get(f'/api/v1/documents/{did}')).status_code == 404
    assert (await client.get('/api/v1/documents/query', params={'document_id': did})).json()['items'] == []


@pytest.mark.asyncio
async def test_document_exact_notification_query_preserves_editor(workflow):
    client, _sessions, _actor = workflow
    first, second = await upload(client), await upload(client, b'Second')
    result = (await client.get('/api/v1/documents/query', params={'document_id': first['id']})).json()
    assert result['total'] == 1 and [r['id'] for r in result['items']] == [first['id']]
    assert result['items'][0]['last_edited_at'] == first['last_edited_at'] and first['id'] != second['id']


@pytest.mark.asyncio
@pytest.mark.parametrize('area', [area.value for area in CasePracticeArea])
async def test_case_classification_persistence_independence_priority(workflow, area):
    client, sessions, _actor = workflow
    created = await client.post('/api/v1/cases', json={'title': 'Smith v Brown', 'practice_area': area, 'client_id': 1, 'status': 'active', 'priority': 'high'})
    assert created.status_code == 200, created.text
    case = created.json()
    assert case['title'] == 'Smith v Brown' and case['practice_area'] == area and case['priority'] == 'high'
    updated = (await client.patch(f"/api/v1/cases/{case['id']}", json={'title': 'Independent title'})).json()
    assert updated['title'] == 'Independent title' and updated['practice_area'] == area
    updated = (await client.patch(f"/api/v1/cases/{case['id']}", json={'practice_area': 'Other'})).json()
    assert updated['title'] == 'Independent title' and updated['practice_area'] == 'Other'
    async with sessions() as db:
        saved = await db.get(Case, case['id'])
        assert saved.title == 'Independent title' and saved.practice_area == 'Other' and saved.priority.value == 'high'
    for priority in ('high', 'medium', 'low'):
        response = await client.get('/api/v1/cases/query', params={'priority': priority})
        assert response.status_code == 200
        assert all(row['priority'] == priority for row in response.json()['items'])
        assert (case['id'] in [row['id'] for row in response.json()['items']]) is (priority == 'high')


@pytest.mark.asyncio
@pytest.mark.parametrize('classification', [None, '', 'Test', 'civil_litigation'])
async def test_case_rejects_missing_invalid_practice_area(workflow, classification):
    client, _sessions, _actor = workflow
    payload = {'title': 'Smith v Brown', 'client_id': 1, 'status': 'active'}
    if classification is not None:
        payload['practice_area'] = classification
    assert (await client.post('/api/v1/cases', json=payload)).status_code == 422
    if classification is not None:
        assert (await client.patch('/api/v1/cases/1', json={'practice_area': classification})).status_code == 422


@pytest.mark.asyncio
async def test_historical_case_null_untouched_access_preserved(workflow):
    client, sessions, actor = workflow
    case = (await client.get('/api/v1/cases/1')).json()
    assert case['title'] == 'File 1' and case['practice_area'] is None
    await client.patch('/api/v1/cases/1', json={'description': 'Historical edit'})
    async with sessions() as db:
        saved = await db.get(Case, 1)
        assert saved.title == 'File 1' and saved.practice_area is None
    assert (await client.get('/api/v1/cases/practice-areas')).json() == [area.value for area in CasePracticeArea]
    assert (await client.get('/api/v1/cases/query', params={'priority': 'urgent'})).status_code == 422
    actor['id'] = 2
    assert (await client.get('/api/v1/cases/1')).status_code == 404
    assert (await client.patch('/api/v1/cases/1', json={'practice_area': 'Other'})).status_code == 404


def test_frontend_receipt_open_boundary_document_menu_contract():
    root = Path(__file__).resolve().parents[2]
    message_ui = (root / 'app/dashboard/messages/page.jsx').read_text()
    assert 'document.visibilityState !== "visible" || !threadVisible.current' in message_ui
    assert 'read_through=${encodeURIComponent(latest.created_at)}' in message_ui
    assert 'mine ? <span className={`message-receipt' in message_ui
    assert 'Read {formatBubbleTime(msg.read_at)}' in message_ui
    page = (root / 'app/dashboard/documents/page.jsx').read_text()
    assert 'params.set("document_id", requestedDocumentId)' in page
    assert '<DocumentActionsMenu open={menuOpenId === document.id}' in page
    navbar = (root / 'components/layout/Navbar.jsx').read_text()
    assert 'if (meta.document_id) return `/dashboard/documents?document_id=${encodeURIComponent(meta.document_id)}`' in navbar
    popup = (root / 'components/notifications/ReminderPopups.jsx').read_text()
    assert 'if (metadata.document_id) return `/dashboard/documents?document_id=${encodeURIComponent(metadata.document_id)}`' in popup
    menu = (root / 'components/DocumentActionsMenu.jsx').read_text()
    for required in ('createPortal', 'getBoundingClientRect', 'window.innerWidth', 'window.innerHeight', 'upward', 'pointerdown', 'Escape', 'menu.current?.contains', 'window.addEventListener("scroll", place, true)'):
        assert required in menu
    assert 'position: fixed;\n  z-index: 1200;' in (root / 'app/globals.css').read_text()


def test_case_table_priority_filter_title_labels_editor_surfaces():
    root = Path(__file__).resolve().parents[2]
    page = (root / 'app/dashboard/cases/page.jsx').read_text()
    heading = page[page.index('<table className="team-table case-list-table">'):page.index('</thead>', page.index('<table className="team-table case-list-table">'))]
    assert '<th>Practice Area</th>' in heading and '>Priority</th>' not in heading
    assert '<td>{c.practice_area || "—"}</td>' in page
    assert 'params.set("priority", priorityFilter)' in page and '<span>Priority</span>' in page
    assert '/api/v1/cases/practice-areas' in page and 'Practice Area *' in page
    detail = (root / 'app/dashboard/cases/[id]/page.jsx').read_text()
    assert 'Case Type:' not in detail and 'Case/File Title:' in detail
    assert '<span>Practice Area:</span><strong>{item.practice_area || "—"}</strong>' in detail
    for path in ('app/dashboard/documents/page.jsx', 'app/dashboard/cases/[id]/page.jsx', 'app/dashboard/clients/[id]/page.jsx', 'components/ProtectedFilePreviewModal.jsx', 'components/OnlyOfficeDocumentModal.jsx'):
        assert '<DocumentLastEdited' in (root / path).read_text()


@pytest.mark.asyncio
@pytest.mark.parametrize('signed, editor_id, expected_status', [(True, 3, 200), (True, 2, 403), (False, 2, 200)])
async def test_onlyoffice_authenticated_actual_editor_and_unsigned_spoof(workflow, monkeypatch, signed, editor_id, expected_status):
    import httpx
    from urllib.parse import urlsplit
    from jose import jwt
    from app.api.v1 import documents
    client, _sessions, _actor = workflow
    await client.patch('/api/v1/cases/1', json={'assigned_user_ids': [3]})
    pid, _text, _original = await create_precedent(client, 'docx')
    copied = (await client.post(f'/api/v1/precedents/{pid}/copy-to-case', json={'case_id': 1})).json()['document']
    did = copied['id']
    assert copied['last_edited_by_user_id'] == 1
    if not signed:
        monkeypatch.setattr(documents.settings, 'onlyoffice_jwt_secret', None)
    config = (await client.post(f'/api/v1/documents/{did}/onlyoffice/session')).json()['editor_config']
    callback = urlsplit(config['editorConfig']['callbackUrl'])
    payload = {'status': 2, 'key': config['document']['key'], 'url': 'https://office.example.test/edited.docx', 'users': [str(editor_id)]}
    real_client = httpx.AsyncClient
    edited = documents.render_docx_bytes('Actual editor content')
    monkeypatch.setattr(documents.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=edited))))
    body = {'token': jwt.encode(payload, 'test-office-secret', algorithm='HS256')} if signed else payload
    response = await client.post(f'{callback.path}?{callback.query}', json=body)
    assert response.status_code == expected_status, response.text
    latest = (await client.get(f'/api/v1/documents/{did}')).json()
    if expected_status == 200:
        assert latest['last_edited_by_user_id'] == (editor_id if signed else 1)
        assert latest['last_edited_at'] != copied['last_edited_at']
        assert latest['version'] == 2
    else:
        assert latest['last_edited_at'] == copied['last_edited_at'] and latest['version'] == 1


@pytest.mark.asyncio
async def test_client_portal_receipts_delivery_intent_boundary_first_read_and_reply(messaging):
    client, sessions, actor = messaging
    created = await client.post('/api/v1/conversations', json={'title': 'Client receipt', 'conversation_type': 'client', 'case_id': 1, 'participant_ids': [6]})
    assert created.status_code == 200, created.text
    cid = created.json()['id']
    first = (await client.post(f'/api/v1/conversations/{cid}/messages', json={'body': 'Client review'})).json()
    second = (await client.post(f'/api/v1/conversations/{cid}/messages', json={'body': 'Later arrival'})).json()
    actor['id'] = 6
    prefix = f'/api/v1/portal/messages/conversations/{cid}'
    assert (await client.get('/api/v1/portal/messages/conversations')).status_code == 200
    assert (await client.get(f'{prefix}/messages')).status_code == 200
    async with sessions() as db:
        assert all(r.read_at is None for r in (await db.scalars(select(MessageReceipt))).all())
    assert (await client.post(f'{prefix}/mark-read', params={'read_through': first['created_at']})).status_code == 200
    rows = (await client.get(f'{prefix}/messages')).json()
    assert rows[0]['delivery_status'] == 'read' and rows[1]['delivery_status'] == 'delivered'
    original = rows[0]['read_at']
    assert (await client.get(prefix)).json()['unread_count'] == 1
    await client.post(f'{prefix}/mark-read')
    assert (await client.get(f'{prefix}/messages')).json()[0]['read_at'] == original
    assert (await client.get(prefix)).json()['unread_count'] == 0
    reply = await client.post(f'{prefix}/messages', json={'body': 'Client reply'})
    assert reply.status_code == 200, reply.text
    assert reply.json()['delivery_status'] == 'delivered' and reply.json()['recipient_count'] == 1
    async with sessions() as db:
        rows = (await db.scalars(select(MessageReceipt).where(MessageReceipt.message_id == reply.json()['id']))).all()
        assert [r.user_id for r in rows] == [1]
    actor['id'] = 1
    await client.post(f'/api/v1/conversations/{cid}/mark-read')
    actor['id'] = 6
    assert (await client.get(f'{prefix}/messages')).json()[-1]['delivery_status'] == 'read'


def test_portal_ui_intentional_open_no_first_conversation_fallback():
    root = Path(__file__).resolve().parents[2]
    source = (root / 'app/portal/messages/page.jsx').read_text()
    assert 'return prev ? (rows || []).find((r) => r.id === prev.id) || null : null' in source
    assert 'selectedRef.current?.id !== conversationId' in source
    assert 'latest && document.visibilityState === "visible"' in source
    assert 'mark-read?read_through=' in source
    assert 'mine ? <span className={`message-receipt' in source
