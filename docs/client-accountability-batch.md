# VILO client accountability batch — 02/10/2026

Initial state: clean `main`, HEAD `d259a6cfbad16e9f7e89fcba0a34ad0b8ca2ad6e`, Alembic current/head `20260909_36`, backend baseline **485 passed, 2 existing warnings**.

## Persistence audit and migration

`ConversationParticipant.last_read_at` supports unread counts but cannot retain each message's first read time. `DocumentVersion`, generic audit logs, and case timeline events do not uniformly record metadata-only changes or editor name snapshots. Cases have a title and priority, but no case classification field. Precedent PracticeArea records have separate rules and are not reused for Cases.

Additive revision `20261002_37` adds:

- MessageReceipt: id, message_id, user_id, delivered_at, read_at, created_at. Unique (message_id, user_id), foreign keys, message/user indexes. No sender receipt. Current intended recipients are captured when the message is created, including the existing client-portal send route.
- Document: nullable last_edited_by_user_id (SET NULL on user removal), last_edited_by_name snapshot, last_edited_at. Explicit uploader foreign keys prevent ORM ambiguity.
- Case: nullable practice_area, separate from existing title and priority. New CaseCreate requires an allowed enum value; CaseUpdate independently accepts classification changes. Frontend options come from `/api/v1/cases/practice-areas`.

Only `vilo_client_scope_20260808` was used for local PostgreSQL migration checks. Upgrade current/head is `20261002_37`. Before/after preservation checks confirm all 12 historical Case titles/priorities, 4 messages, and 5 Documents are unchanged. An isolated schema on that same DB passed upgrade/downgrade/upgrade and historical backfill checks; its entire transaction was rolled back. Existing application records were never downgraded. Neither protected database was touched.

## Messages

Delivery is application-level: a persisted message and recipient receipt in the same transaction. It is not device/network acknowledgement. Existing staff and client-portal read boundaries update receipts in bulk for the authenticated user, same organization/conversation, incoming nondeleted messages through the fetched cutoff, and only when read_at IS NULL. Reopening cannot overwrite a recorded first read.

One recipient: Sent = one neutral tick, Delivered = grey double ticks, Read = blue double ticks and subtle read time. Groups turn blue only after all captured recipients have read; the displayed timestamp is the latest first read. APIs add delivery_status, read_at, recipient_count and read_count, without returning per-user receipt objects. Outgoing bubbles alone show indicators, with accessible status labels. Visible selected threads refresh on the existing 25-second interval; summary reads never acknowledge messages. Staff and portal entry remain neutral, hidden tabs do not acknowledge, and previous selection is not restored on module entry.

Historical compatibility: backfill creates Delivered receipts only for same-org current participants who joined by message creation. No historical read times are inferred from moving cursors. Historical first-read times and departed-recipient membership cannot be reconstructed. Any subsequent receipt timestamp records the first intentional view observed after rollout; it is not a claim about pre-rollout reading. Existing unread cursors are retained.

## Documents

Notification dropdown, activity sidebar, and popup routes target `/dashboard/documents?document_id={id}`. An exact link overrides stale filters/page and resets page 1. The local menu was subject to scrolling-table clipping, particularly with one filtered row. A body portal uses the clicked trigger's bounding rect and measured menu size, flips up when necessary, clamps horizontally inward, uses z-index 1200, and updates on scroll, resize and menu size changes. Single menu state, exact-row callbacks, outside pointer close and Escape/focus restoration are preserved. Table horizontal scrolling is retained.

A shared server helper records initial uploads/copies, meaningful metadata edits, replacements, content-created versions, and OnlyOffice changed-file saves. Unchanged metadata payloads, preview/view/download, read-only editor sessions, and unchanged OnlyOffice callbacks do not change accountability. Copied Precedents are independent Documents; edits do not alter masters.

OnlyOffice uses the verified signed callback's last editor for save statuses, checked against same-org staff access. Without Document Server JWT it uses the authenticated actor embedded in the VILO-signed edit-session token, ignoring spoofable callback user IDs. Old unsigned sessions without actor context must be reopened; no creator/admin fallback invents an editor. Live Document Server coediting was not available; callback saves were tested through mocked server downloads and real persisted API workflows. Callback semantics were verified against [official ONLYOFFICE documentation](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/).

Authorized viewers see `Last edited by Daniel Brooks on 01/10/2026 at 3:45 PM` using existing local-time VILO formatting. Surfaces: main Documents rows/version details, Case Documents, Client Timeline (including identity-document entries), protected previews and OnlyOffice metadata. Historical editor fields remain unknown until an actual edit. Existing document access scopes protect all returned metadata.

## Cases and File table

Allowed values: Civil Litigation; Criminal Law; Family Law; Conveyancing; Probate & Estate; Corporate / Commercial; Employment Law; Personal Injury; Immigration; Real Estate; Other.

Creation dropdown is required, with backend enum validation too. Title and Practice Area remain independent through create/update; historical NULL classification displays —. Existing titles are never rewritten. Main visible table columns: Title, Status, Practice Area, Client, Team Members, Actions. Priority remains in DB/API, intake/edit/details and business logic; the main list now has a top Priority filter querying Case.priority. The prior list lacked that filter. The sole incorrect Case Type label in the Case summary was corrected to Case/File Title, with Practice Area displayed separately. Other title references remain intact.

## Validation

- Final backend: **518 passed, 2 unchanged warnings** (33 additional collected tests; no tests removed).
- Focused suites: **290 passed, 2 unchanged warnings**; cover receipts/read/unread/notifications/attachments, document versions and OnlyOffice, precedent independence, cases and permissions, intake, and frontend static regressions.
- Python compileall: pass for app, tests, alembic.
- Next production build: pass, all 29 pages generated.
- git diff --check: pass.
- Browser: in-app runtime discovered no available browser. Local headless Chromium passed real frontend interaction tests with isolated mocked API fixtures at 100%, 110%, 125% equivalent viewport/device scaling. Covers exact notification click; menu anchoring, topmost hit testing, upward flip, inward bounds, single menu, Escape/outside close and exact View; editor row/preview/Case/Client surfaces; all outgoing tick states and incoming exclusion; neutral entry/return and hidden visibility guard; Case dropdown required validation, create payload, details, table and Priority filter; client-portal neutral entry and ticks. This is not a live multiuser browser session or toolbar zoom test. Persisted backend suites verify actual data mutation and security separately.

The reusable UI check is `scripts/qa_client_accountability.cjs`. Run against a freshly built local server, e.g. `npm run start -- --hostname 127.0.0.1 --port 3100`, with Playwright available via `VILO_PLAYWRIGHT_MODULE` (or ordinary Node resolution), optionally `VILO_CHROMIUM_EXECUTABLE`, `VILO_QA_BASE_URL`, `VILO_QA_ARTIFACT_DIR`. It intercepts API traffic with synthetic fixtures and does not modify application databases. Screenshots/results go to the OS temp directory by default.

No global permission expansion, message architecture rewrite, unrelated redesign, Phase 4 functionality, push or deployment.

## File manifest

- `app/dashboard/cases/[id]/page.jsx`
- `app/dashboard/cases/page.jsx`
- `app/dashboard/clients/[id]/page.jsx`
- `app/dashboard/documents/page.jsx`
- `app/dashboard/messages/page.jsx`
- `app/globals.css`
- `app/portal/messages/page.jsx`
- `backend/alembic/versions/20261002_37_client_accountability.py`
- `backend/app/api/v1/cases.py`
- `backend/app/api/v1/clients.py`
- `backend/app/api/v1/conversations.py`
- `backend/app/api/v1/documents.py`
- `backend/app/api/v1/portal_messages.py`
- `backend/app/api/v1/precedents.py`
- `backend/app/models/__init__.py`
- `backend/app/models/case.py`
- `backend/app/models/document.py`
- `backend/app/models/message_receipt.py`
- `backend/app/models/user.py`
- `backend/app/schemas/case.py`
- `backend/app/schemas/case_practice_area.py`
- `backend/app/schemas/conversation.py`
- `backend/app/schemas/document.py`
- `backend/app/services/document_accountability.py`
- `backend/app/services/message_receipts.py`
- `backend/tests/test_client_accountability_batch.py`
- `backend/tests/test_client_change_request_schemas.py`
- `backend/tests/test_client_intake_draft_attachments.py`
- `backend/tests/test_document_versions.py`
- `backend/tests/test_file_assignment_access.py`
- `backend/tests/test_final_batch1.py`
- `backend/tests/test_message_case_references.py`
- `backend/tests/test_message_document_notifications.py`
- `backend/tests/test_precedent_document_workflow.py`
- `components/DocumentActionsMenu.jsx`
- `components/DocumentLastEdited.jsx`
- `components/OnlyOfficeDocumentModal.jsx`
- `components/ProtectedFilePreviewModal.jsx`
- `components/layout/Navbar.jsx`
- `components/notifications/ReminderPopups.jsx`
- `docs/client-accountability-batch.md`
- `scripts/qa_client_accountability.cjs`
