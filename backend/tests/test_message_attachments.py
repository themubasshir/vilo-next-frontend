"""Persisted participant-only attachment sends, read state, and failure cleanup."""
from io import BytesIO

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from test_message_document_notifications import messaging  # noqa: F401
from test_precedent_document_workflow import workflow  # noqa: F401
from app.models.conversation import Message
from app.models.document import Document
from app.models.message_attachment import MessageAttachment
from app.models.notification import Notification
from app.services import message_attachments

PDF = b'%PDF-1.4\n%%EOF'


async def conversation(client):
    response = await client.post('/api/v1/conversations', json={'title': 'Private', 'conversation_type': 'internal', 'participant_ids': [3]})
    assert response.status_code == 200, response.text
    return response.json()['id']


@pytest.mark.asyncio
@pytest.mark.parametrize('body,count', [('Review this', 1), ('Review all', 3), ('', 2)])
async def test_send_metadata_download_notifications_and_unread(messaging, monkeypatch, tmp_path, body, count):
    client, sessions, actor = messaging
    monkeypatch.setattr(message_attachments, 'STORAGE_ROOT', tmp_path / 'attachments')
    cid = await conversation(client)
    response = await client.post(f'/api/v1/conversations/{cid}/messages-with-attachments', data={'body': body, 'case_reference_ids': '1'}, files=[('files', (f'evidence-{i}.pdf', PDF, 'application/octet-stream')) for i in range(count)])
    assert response.status_code == 200, response.text
    msg = response.json()
    assert msg['body'] == body and len(msg['attachments']) == count
    assert msg['case_references'][0]['case_id'] == 1
    assert 'file_path' not in response.text and str(tmp_path) not in response.text
    assert all(set(a) == {'id', 'file_name', 'file_type', 'file_size', 'created_at'} for a in msg['attachments'])
    async with sessions() as db:
        assert (await db.scalar(select(func.count(Document.id)))) == 0
        rows = (await db.scalars(select(Notification))).all()
        assert [(n.user_id, n.type) for n in rows] == [(3, 'message_received')]
        assert rows[0].metadata_json['conversation_id'] == cid
        assert (await db.scalar(select(func.count(Message.id)))) == 1
    actor['id'] = 3
    response = await client.get(f'/api/v1/conversations/{cid}/messages')
    assert response.json()[0]['attachments'] == msg['attachments']
    response = await client.get(f'/api/v1/conversations/{cid}')
    assert response.json()['unread_count'] == 1
    assert len(response.json()['latest_message']['attachments']) == count
    for attachment in msg['attachments']:
        for action in ('view', 'download'):
            response = await client.get(f"/api/v1/conversations/attachments/{attachment['id']}/{action}")
            assert response.status_code == 200 and response.content == PDF
            assert response.headers['content-type'] == 'application/pdf'
            assert response.headers['content-disposition'].startswith('inline' if action == 'view' else 'attachment')
            assert response.headers['cache-control'] == 'private, no-store'
    await client.post(f'/api/v1/conversations/{cid}/mark-read')
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['unread_count'] == 0
    response = await client.post(f'/api/v1/conversations/{cid}/messages', json={'body': 'Text still works'})
    assert response.status_code == 200 and response.json()['attachments'] == []


@pytest.mark.asyncio
@pytest.mark.parametrize('uid', [4, 2, 5, 6])
async def test_nonparticipant_foreign_tenant_and_client_denied(messaging, monkeypatch, tmp_path, uid):
    client, sessions, actor = messaging
    monkeypatch.setattr(message_attachments, 'STORAGE_ROOT', tmp_path / 'attachments')
    cid = await conversation(client)
    response = await client.post(f'/api/v1/conversations/{cid}/messages-with-attachments', files={'files': ('proof.pdf', PDF, 'application/pdf')})
    aid = response.json()['attachments'][0]['id']
    actor['id'] = uid
    assert (await client.get(f'/api/v1/conversations/{cid}/messages')).status_code in (403, 404)
    assert (await client.post(f'/api/v1/conversations/{cid}/messages-with-attachments', files={'files': ('proof.pdf', PDF, 'application/pdf')})).status_code in (403, 404)
    for guessed in (aid, aid + 1000):
        for action in ('view', 'download'):
            assert (await client.get(f'/api/v1/conversations/attachments/{guessed}/{action}')).status_code in (403, 404)


@pytest.mark.asyncio
async def test_deleted_message_revokes_attachment_and_keeps_file(messaging, monkeypatch, tmp_path):
    client, sessions, actor = messaging
    root = tmp_path / 'attachments'
    monkeypatch.setattr(message_attachments, 'STORAGE_ROOT', root)
    cid = await conversation(client)
    msg = (await client.post(f'/api/v1/conversations/{cid}/messages-with-attachments', files={'files': ('proof.pdf', PDF, 'application/pdf')})).json()
    assert (await client.delete(f"/api/v1/conversations/messages/{msg['id']}")).status_code == 200
    assert (await client.get(f'/api/v1/conversations/{cid}/messages')).json() == []
    assert (await client.get(f'/api/v1/conversations/{cid}')).json()['latest_message'] is None
    for action in ('view', 'download'):
        assert (await client.get(f"/api/v1/conversations/attachments/{msg['attachments'][0]['id']}/{action}")).status_code == 404
    assert len(list(root.rglob('*.pdf'))) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['none', 'count', 'oversized', 'unsupported', 'empty', 'signature', 'unsafe', 'bad_reference', 'bad_parent'])
async def test_rejected_send_is_atomic(messaging, monkeypatch, tmp_path, kind):
    client, sessions, actor = messaging
    root = tmp_path / 'attachments'
    monkeypatch.setattr(message_attachments, 'STORAGE_ROOT', root)
    cid = await conversation(client)
    files = [('files', ('proof.pdf', PDF, 'application/pdf'))]
    data = {'body': ''}
    if kind == 'none': files = []
    if kind == 'count': files *= 6
    if kind == 'oversized': files = [('files', ('proof.pdf', b'x' * (10 * 1024 * 1024 + 1), 'application/pdf'))]
    if kind == 'unsupported': files = [('files', ('proof.exe', b'exe', 'application/pdf'))]
    if kind == 'empty': files = [('files', ('proof.pdf', b'', 'application/pdf'))]
    if kind == 'signature': files = [('files', ('proof.pdf', b'<html>unsafe</html>', 'application/pdf'))]
    if kind == 'unsafe': files = [('files', ('..', PDF, 'application/pdf'))]
    if kind == 'bad_reference': data['case_reference_ids'] = '2'
    if kind == 'bad_parent': data['parent_message_id'] = '999'
    response = await client.post(f'/api/v1/conversations/{cid}/messages-with-attachments', data=data, files=files)
    assert response.status_code in (400, 422), response.text
    async with sessions() as db:
        for model in (Message, MessageAttachment, Notification):
            assert await db.scalar(select(func.count(model.id))) == 0
    assert not list(root.rglob('*.*'))


@pytest.mark.asyncio
async def test_safe_name_and_cleanup_on_failed_commit(messaging, monkeypatch, tmp_path):
    client, sessions, actor = messaging
    root = tmp_path / 'attachments'
    monkeypatch.setattr(message_attachments, 'STORAGE_ROOT', root)
    cid = await conversation(client)
    response = await client.post(f'/api/v1/conversations/{cid}/messages-with-attachments', files={'files': ('../../Safe name.pdf', PDF, 'text/html')})
    assert response.status_code == 200, response.text
    assert response.json()['attachments'][0]['file_name'] == 'Safe name.pdf'
    before = set(root.rglob('*.pdf'))
    original_commit = AsyncSession.commit
    async def fail_commit(self):
        raise RuntimeError('Simulated DB failure')
    monkeypatch.setattr(AsyncSession, 'commit', fail_commit)
    with pytest.raises(RuntimeError, match='Simulated DB failure'):
        await client.post(f'/api/v1/conversations/{cid}/messages-with-attachments', files={'files': ('new.pdf', PDF, 'application/pdf')})
    assert set(root.rglob('*.pdf')) == before
    monkeypatch.setattr(AsyncSession, 'commit', original_commit)
    async with sessions() as db:
        assert await db.scalar(select(func.count(Message.id))) == 1
        assert await db.scalar(select(func.count(MessageAttachment.id))) == 1
        assert await db.scalar(select(func.count(Notification.id))) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('extension', ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'txt'])
async def test_supported_formats_and_parent_reference(messaging, monkeypatch, tmp_path, extension):
    from docx import Document as WordDocument
    client, sessions, actor = messaging
    monkeypatch.setattr(message_attachments, 'STORAGE_ROOT', tmp_path / 'attachments')
    cid = await conversation(client)
    parent = (await client.post(f'/api/v1/conversations/{cid}/messages', json={'body': 'Parent'})).json()
    word = BytesIO()
    WordDocument().save(word)
    data = {
        'pdf': PDF, 'doc': b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1legacy',
        'docx': word.getvalue(), 'jpg': b'\xff\xd8\xffimage', 'jpeg': b'\xff\xd8\xffimage',
        'png': b'\x89PNG\r\n\x1a\nimage', 'txt': b'Plain text',
    }[extension]
    response = await client.post(f'/api/v1/conversations/{cid}/messages-with-attachments',
        data={'body': 'Reply', 'parent_message_id': str(parent['id']), 'case_reference_ids': '1'},
        files={'files': (f'legal.{extension}', data, 'application/octet-stream')})
    assert response.status_code == 200, response.text
    msg = response.json()
    assert msg['parent_message_id'] == parent['id'] and msg['case_references'][0]['case_id'] == 1
    attachment = msg['attachments'][0]
    response = await client.get(f"/api/v1/conversations/attachments/{attachment['id']}/view")
    assert response.content == data
    assert response.headers['content-disposition'].startswith('attachment' if extension in ('doc', 'docx', 'txt') else 'inline')
    assert (await client.post(f'/api/v1/conversations/{cid}/messages', json={'body': '  '})).status_code == 400
