"""Persisted Batch 4 assignment-only File access regression tests."""
from datetime import datetime, timezone
import pytest
from sqlalchemy import select
from test_precedent_document_workflow import workflow  # noqa: F401
from app.models.case import Case, CaseAssignment
from app.models.client import ClientAssignment
from app.models.enums import UserRole
from app.models.notification import Notification
from app.models.user import User


@pytest.mark.asyncio
async def test_assignment_only_access_and_removal(workflow):
    client, sessions, actor = workflow
    response = await client.post('/api/v1/cases', json={'title': 'Assigned File', 'client_id': 1, 'status': 'active', 'assigned_user_ids': [3]})
    assert response.status_code == 200, response.text
    cid = response.json()['id']
    async with sessions() as db:
        assert (await db.scalars(select(ClientAssignment))).all() == []
        for notification in (await db.scalars(select(Notification))).all():
            await db.delete(notification)
        db.add(CaseAssignment(case_id=2, user_id=3))  # malformed cross-tenant assignment
        await db.commit()
    response = await client.post('/api/v1/documents/upload', data={'title': 'Evidence', 'case_id': str(cid)}, files={'file': ('evidence.txt', b'proof', 'text/plain')})
    assert response.status_code == 200, response.text
    did = response.json()['id']
    async with sessions() as db:
        assert [(n.user_id, n.type) for n in (await db.scalars(select(Notification))).all()] == [(3, 'document_uploaded')]
    actor['id'] = 3
    for path in ('/api/v1/cases', '/api/v1/cases/query'):
        response = await client.get(path)
        assert response.status_code == 200, response.text
        rows = response.json() if isinstance(response.json(), list) else response.json()['items']
        assert [r['id'] for r in rows] == [cid]
    for suffix in ('', '/team', '/timeline'):
        assert (await client.get(f'/api/v1/cases/{cid}{suffix}')).status_code == 200
        for denied in (1, 2):
            assert (await client.get(f'/api/v1/cases/{denied}{suffix}')).status_code == 404
    response = await client.get('/api/v1/documents', params={'case_id': cid})
    assert response.status_code == 200 and [d['id'] for d in response.json()] == [did]
    for action in ('view', 'download'):
        response = await client.get(f'/api/v1/documents/{did}/{action}')
        assert response.status_code == 200 and response.content == b'proof'
    actor['id'] = 1
    response = await client.patch(f'/api/v1/cases/{cid}', json={'assigned_user_ids': []})
    assert response.status_code == 200, response.text
    actor['id'] = 3
    assert (await client.get(f'/api/v1/cases/{cid}')).status_code == 404
    for action in ('view', 'download'):
        assert (await client.get(f'/api/v1/documents/{did}/{action}')).status_code == 404
    async with sessions() as db:
        assert (await db.get(Case, cid)).client_id == 1
        assert (await db.scalars(select(ClientAssignment))).all() == []


@pytest.mark.asyncio
@pytest.mark.parametrize('role', ['admin', 'partner', 'lawyer'])
async def test_privileged_access_and_required_client(workflow, role):
    client, sessions, actor = workflow
    async with sessions() as db:
        (await db.get(User, 1)).role = UserRole(role)
        await db.commit()
    assert (await client.get('/api/v1/cases/1')).status_code == 200
    assert (await client.get('/api/v1/cases/2')).status_code == 404
    assert (await client.post('/api/v1/cases', json={'title': 'Missing client', 'status': 'active'})).status_code == 422
    assert (await client.post('/api/v1/cases/1/assign', json={'user_ids': [2]})).status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize('assigned', [[3], [3, 4], [3, 5], [5], [1, 3, 4, 5, 6], []])
async def test_query_serializes_assignee_roles(workflow, assigned):
    client, sessions, actor = workflow
    now = datetime.now(timezone.utc)
    async with sessions() as db:
        for uid, role in ((4, UserRole.paralegal), (5, UserRole.lawyer), (6, UserRole.admin)):
            db.add(User(id=uid, organization_id=1, name=f'Team {uid}', email=f'team{uid}@example.test', hashed_password='unused', role=role, created_at=now, updated_at=now))
        await db.commit()
    response = await client.post('/api/v1/cases/1/assign', json={'user_ids': assigned})
    assert response.status_code == 200, response.text
    response = await client.get('/api/v1/cases/query')
    assert response.status_code == 200, response.text
    row = next(r for r in response.json()['items'] if r['id'] == 1)
    assert {u['id'] for u in row['assigned_users']} == set(assigned)
    assert {u['id'] for u in row['assigned_users'] if u['role'] == 'paralegal'} == set(assigned) & {3, 4}
    assert all({'name', 'email', 'role', 'status'} <= u.keys() for u in row['assigned_users'])
    if assigned == [1, 3, 4, 5, 6]:
        assert {u['role'] for u in row['assigned_users']} == {'partner', 'paralegal', 'lawyer', 'admin'}
    async with sessions() as db:
        assert (await db.scalars(select(ClientAssignment))).all() == []
