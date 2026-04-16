---
"callsheet": minor
---

Add local mock Todoist API server for offline development and regression testing

- New `src/mocks/todoist/` server (zero-dependency, built on `node:http`) that responds to `/projects`, `/tasks`, and `/tasks/completed/by_completion_date` with paginated fixture data
- Set `CALLSHEET_MOCK_MODE=true` to redirect the Todoist connector to the mock (default `http://localhost:4010`, override with `CALLSHEET_MOCK_URL`). Mock mode shows a stderr banner at startup and prefixes the connector's description with `[MOCK DATA]` so output can never be confused with real data
- New `yarn mock:todoist` script for manual end-to-end runs against the mock
- Scenarios in `fixtures/todoist/*.json` use raw API response shapes with date placeholders (`<TODAY>`, `<TODAY+N>`, `<TODAY-N>`). Switch via `CALLSHEET_MOCK_SCENARIO` env var or per-request `X-Mock-Scenario` header
- Ships with `empty`, `typical-day`, `overdue-heavy`, and `regression-recurring-overdue` scenarios
- New `scripts/anonymize-todoist-dump.ts` strips PII from real Todoist exports for fixture creation
- New `test/integration/todoist.integration.test.ts` boots the mock in-process and exercises the real connector end-to-end
