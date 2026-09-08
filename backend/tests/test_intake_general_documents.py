"""Intake ordinary uploads use the existing protected Document system."""
import pytest
from sqlalchemy import select
from test_precedent_document_workflow import workflow  # noqa: F401
from app.models.notification import Notification


@pytest.mark.asyncio
async def test_client_records_are_ordinary_documents_and_tenant_scoped(workflow):
    client, sessions, actor = workflow
    created = await client.post('/api/v1/clients', json={'name': 'Intake Client'})
    assert created.status_code == 200, created.text
    cid = created.json()['id']
    ids = {}
    for category in ('client_records', 'client_id'):
        response = await client.post('/api/v1/documents/upload', data={
            'title': 'Engagement Letter', 'client_id': str(cid), 'visibility': 'internal', 'category': category,
        }, files={'file': ('Engagement Letter.pdf', b'%PDF-1.4\n%%EOF', 'application/pdf')})
        assert response.status_code == 200, response.text
        doc = response.json()
        assert doc['client_id'] == cid and doc['case_id'] is None
        assert doc['category'] == category and doc['file_name'] == 'Engagement Letter.pdf'
        ids[category] = doc['id']
    rows = (await client.get('/api/v1/documents', params={'client_id': cid})).json()
    assert ids['client_records'] in [row['id'] for row in rows if row['category'] != 'client_id']
    id_rows = await client.get(f'/api/v1/clients/{cid}/id-documents')
    assert id_rows.status_code == 200, id_rows.text
    assert ids['client_records'] not in [row['id'] for row in id_rows.json()]
    response = await client.get('/api/v1/documents/query', params={'exclude_client_ids': True, 'category': 'client_records'})
    assert response.status_code == 200, response.text
    assert [row['id'] for row in response.json()['items']] == [ids['client_records']]
    response = await client.get('/api/v1/documents/query', params={'exclude_client_ids': True})
    assert ids['client_id'] not in [row['id'] for row in response.json()['items']]
    async with sessions() as db:
        assert (await db.scalars(select(Notification))).all() == []
    actor['id'] = 2
    assert (await client.get('/api/v1/documents/query')).json()['items'] == []
    assert (await client.get(f"/api/v1/documents/{ids['client_records']}/download")).status_code == 404
