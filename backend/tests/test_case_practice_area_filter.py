"""Files module Practice Area list filter: backend filtering and frontend regressions."""
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from test_precedent_document_workflow import workflow  # noqa: F401
from app.models.case import Case
from app.models.client import Client
from app.schemas.case_practice_area import CasePracticeArea


async def create_case(client, **overrides):
    payload = {"title": "Smith v Brown", "practice_area": "Civil Litigation", "client_id": 1, "status": "active", "priority": "high"}
    payload.update(overrides)
    response = await client.post("/api/v1/cases", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


async def query_cases(client, **params):
    response = await client.get("/api/v1/cases/query", params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    return [row["title"] for row in body["items"]], body


@pytest.mark.asyncio
async def test_filter_by_civil_litigation_and_employment_law(workflow):
    client, _sessions, _actor = workflow
    await create_case(client)
    await create_case(client, title="Employment Matter", practice_area="Employment Law")
    civil_titles, civil_body = await query_cases(client, practice_area="Civil Litigation")
    assert civil_titles == ["Smith v Brown"] and civil_body["total"] == 1
    employment_titles, employment_body = await query_cases(client, practice_area="Employment Law")
    assert employment_titles == ["Employment Matter"] and employment_body["total"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["Test", "civil_litigation", "Employment"])
async def test_invalid_practice_area_filter_is_rejected(workflow, value):
    client, _sessions, _actor = workflow
    assert (await client.get("/api/v1/cases/query", params={"practice_area": value})).status_code == 422


@pytest.mark.asyncio
async def test_null_historical_practice_area_excluded_from_specific_filter_but_listed_by_default(workflow):
    client, _sessions, _actor = workflow
    await create_case(client)
    for area in (area.value for area in CasePracticeArea):
        titles, _body = await query_cases(client, practice_area=area)
        assert "File 1" not in titles
    titles, _body = await query_cases(client)
    assert "File 1" in titles and "Smith v Brown" in titles


@pytest.mark.asyncio
async def test_practice_area_combines_with_priority(workflow):
    client, _sessions, _actor = workflow
    await create_case(client, title="Employment Matter", practice_area="Employment Law", priority="high")
    await create_case(client, title="Employment Advisory", practice_area="Employment Law", priority="medium")
    titles, _body = await query_cases(client, practice_area="Employment Law", priority="high")
    assert titles == ["Employment Matter"]
    titles, _body = await query_cases(client, practice_area="Employment Law", priority="medium")
    assert titles == ["Employment Advisory"]


@pytest.mark.asyncio
async def test_practice_area_combines_with_client(workflow):
    client, sessions, _actor = workflow
    now = datetime.now(timezone.utc)
    async with sessions() as db:
        db.add(Client(id=5, organization_id=1, name="Olivia Grant", created_at=now, updated_at=now))
        await db.commit()
    await create_case(client, client_id=5)
    await create_case(client, title="Second Civil File", client_id=1)
    titles, _body = await query_cases(client, practice_area="Civil Litigation", client_id=5)
    assert titles == ["Smith v Brown"]
    titles, _body = await query_cases(client, practice_area="Civil Litigation", client_id=1)
    assert titles == ["Second Civil File"]


@pytest.mark.asyncio
async def test_practice_area_combines_with_assigned_staff(workflow):
    client, _sessions, _actor = workflow
    await create_case(client, assigned_user_ids=[3])
    await create_case(client, title="Unassigned Civil File")
    titles, _body = await query_cases(client, practice_area="Civil Litigation", assigned_user_id=3)
    assert titles == ["Smith v Brown"]


@pytest.mark.asyncio
async def test_practice_area_combines_with_search(workflow):
    client, _sessions, _actor = workflow
    await create_case(client, title="Smith v Brown")
    await create_case(client, title="Smith v Reed", practice_area="Employment Law")
    titles, _body = await query_cases(client, search="Smith", practice_area="Civil Litigation")
    assert titles == ["Smith v Brown"]
    titles, _body = await query_cases(client, search="Smith", practice_area="Employment Law")
    assert titles == ["Smith v Reed"]


@pytest.mark.asyncio
async def test_practice_area_combines_with_date_range(workflow):
    client, sessions, _actor = workflow
    await create_case(client, title="Current Filing", practice_area="Corporate / Commercial")
    older = await create_case(client, title="Older Filing", practice_area="Corporate / Commercial")
    async with sessions() as db:
        row = await db.get(Case, older["id"])
        row.created_at = datetime.now(timezone.utc) - timedelta(days=3)
        await db.commit()
    today = datetime.now(timezone.utc).date()
    titles, _body = await query_cases(client, practice_area="Corporate / Commercial", created_from=today.isoformat(), created_to=today.isoformat())
    assert titles == ["Current Filing"]
    titles, _body = await query_cases(client, practice_area="Corporate / Commercial", created_from=(today - timedelta(days=5)).isoformat(), created_to=today.isoformat())
    assert "Older Filing" in titles and "Current Filing" in titles


@pytest.mark.asyncio
async def test_practice_area_filter_preserves_organization_isolation(workflow):
    client, _sessions, actor = workflow
    await create_case(client)
    actor["id"] = 2
    foreign = await create_case(client, title="Foreign Civil File", client_id=2)
    actor["id"] = 1
    titles, _body = await query_cases(client, practice_area="Civil Litigation")
    assert foreign["title"] not in titles and "Smith v Brown" in titles


@pytest.mark.asyncio
async def test_practice_area_filter_preserves_assignment_access_restrictions(workflow):
    client, sessions, actor = workflow
    created = await create_case(client)
    actor["id"] = 3
    titles, _body = await query_cases(client, practice_area="Civil Litigation")
    assert created["title"] not in titles and "File 1" not in titles
    async with sessions() as db:
        from app.models.case import CaseAssignment
        db.add(CaseAssignment(case_id=created["id"], user_id=3))
        await db.commit()
    titles, _body = await query_cases(client, practice_area="Civil Litigation")
    assert created["title"] in titles


def test_frontend_files_practice_area_filter_contract():
    root = Path(__file__).resolve().parents[2]
    page = (root / "app/dashboard/cases/page.jsx").read_text()
    filter_grid = page[page.index('<div className="cases-filter-grid">'):page.index("</div>", page.index('<div className="cases-filter-grid">'))]
    assert '<span>Practice Area</span>' in filter_grid
    assert '<option value="">All Practice Areas</option>' in filter_grid
    assert "practiceAreas.map((area) => <option key={area} value={area}>{area}</option>)" in filter_grid
    assert "/api/v1/cases/practice-areas" in page and "Civil Litigation" not in page
    assert 'params.set("practice_area", practiceAreaFilter)' in page
    assert "changeFilter(setPracticeAreaFilter, event.target.value)" in page
    assert 'const [practiceAreaFilter, setPracticeAreaFilter] = useState(searchParams.get("practice_area") || "")' in page
    clear_filters = page[page.index("function clearFilters()"):page.index("\n  }", page.index("function clearFilters()"))]
    for reset in ("setPriorityFilter", "setStatusFilter", "setStaffFilter", "setClientFilter", "setPracticeAreaFilter", "setCreatedFrom", "setCreatedTo", "setSearchDraft", "setSearch", "setPage"):
        assert reset in clear_filters
    assert "Clear filters" in filter_grid or "Clear filters" in page
    heading = page[page.index('<table className="team-table case-list-table">'):page.index("</thead>", page.index('<table className="team-table case-list-table">'))]
    assert '<th>Practice Area</th>' in heading and ">Priority</th>" not in heading
    assert '<td>{c.practice_area || "—"}</td>' in page
    assert 'params.set("priority", priorityFilter)' in page and '<span>Priority</span>' in page
