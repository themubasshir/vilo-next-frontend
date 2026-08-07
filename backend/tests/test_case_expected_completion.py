from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest

from app.api.v1 import cases as cases_module
from app.models.case import CasePriority, CaseStatus
from app.schemas.case import CaseUpdate


class CaseUpdateDBStub:
    def __init__(self):
        self.committed = False

    async def commit(self):
        self.committed = True


@pytest.mark.asyncio
async def test_expected_completion_update_persists_on_authoritative_case_property(monkeypatch):
    original_date = date(2026, 8, 30)
    updated_date = date(2026, 10, 15)
    case = SimpleNamespace(
        id=71,
        organization_id=1,
        title="Matter A",
        description=None,
        client_id=41,
        expected_completion_date=original_date,
        status=CaseStatus.active,
        priority=CasePriority.medium,
        created_by=10,
        assignments=[],
        client=None,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db = CaseUpdateDBStub()
    user = SimpleNamespace(id=10, organization_id=1)
    request = SimpleNamespace(client=None, headers={})

    async def get_case(_db, _case_id, _user):
        return case

    async def no_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(cases_module, "get_case_or_404", get_case)
    monkeypatch.setattr(cases_module, "log_audit_event", no_audit)

    response = await cases_module.update_case(
        case_id=case.id,
        payload=CaseUpdate(expected_completion_date=updated_date),
        request=request,
        db=db,
        current_user=user,
    )

    assert db.committed is True
    assert case.expected_completion_date == updated_date
    assert response.expected_completion_date == updated_date
