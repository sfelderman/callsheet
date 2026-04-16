# Local Development with Mock APIs

Callsheet can run against local mock API servers instead of real services. This lets you develop, test, and debug without risking real data or needing API credentials.

## Quick start

```bash
# Terminal 1: Start the mock server
yarn mock:todoist

# Terminal 2: Run callsheet against it
CALLSHEET_MOCK_MODE=true TODOIST_TOKEN_PERSON1=fake yarn start --show-data
```

## Mock mode

Set `CALLSHEET_MOCK_MODE=true` (or `1` or `yes`) to redirect connectors to their mock servers.

### Environment variables

| Variable                  | Default                  | Description                        |
| ------------------------- | ------------------------ | ---------------------------------- |
| `CALLSHEET_MOCK_MODE`     | _(unset)_                | Enable mock mode (`true`/`1`/`yes`)|
| `CALLSHEET_MOCK_URL`      | `http://localhost:4010`  | Base URL for mock Todoist server   |
| `CALLSHEET_MOCK_SCENARIO` | `typical-day`            | Default fixture scenario to load   |

### Visibility safeguards

Mock mode is designed to be impossible to mistake for real data:

1. **CLI banner** — A prominent `━━━ MOCK MODE ENABLED ━━━` banner prints to stderr at startup
2. **Description prefix** — All `ConnectorResult.description` fields are prefixed with `[MOCK DATA]`, which flows into the Claude prompt and `--show-data` output
3. **Test diagnostics** — `yarn test:connector` shows a `[MOCK]` tag next to each connector when mock mode is active

## Mock Todoist server

### Standalone server

```bash
yarn mock:todoist                        # default: port 4010, scenario typical-day
yarn mock:todoist --port 3999            # custom port
yarn mock:todoist --scenario empty       # different fixture
```

### API endpoints

The mock serves these endpoints (matching the real Todoist API v1):

| Method | Endpoint                                      | Response shape               |
| ------ | --------------------------------------------- | ---------------------------- |
| GET    | `/api/v1/projects`                            | `{ results, next_cursor }`   |
| GET    | `/api/v1/tasks`                               | `{ results, next_cursor }`   |
| GET    | `/api/v1/tasks/completed/by_completion_date`  | `{ items, next_cursor }`     |

All endpoints require an `Authorization: Bearer <any-non-empty-value>` header (matching the real API behavior).

### Per-request scenario switching

Without restarting the server, you can switch scenarios per-request:

```bash
curl -H "Authorization: Bearer fake" \
     -H "X-Mock-Scenario: empty" \
     http://localhost:4010/api/v1/tasks
```

### Pagination

The mock supports cursor-based pagination matching the real API. Default page size is 50; fixtures can override with a top-level `"pageSize"` key.

## Fixtures

Fixture data lives in `fixtures/todoist/<scenario>.json`. See [`fixtures/todoist/README.md`](../fixtures/todoist/README.md) for the format, available scenarios, and how to create new ones from real data.

### Shipped scenarios

| Scenario                      | Description                                     |
| ----------------------------- | ----------------------------------------------- |
| `typical-day`                 | Baseline with tasks in every category            |
| `empty`                       | Zero tasks — empty-state testing                 |
| `overdue-heavy`               | 55 tasks with small page size — pagination tests |
| `regression-recurring-overdue`| Recurring overdue tasks categorization           |

## Anonymizer

To create a fixture from real Todoist data without exposing personal information:

```bash
tsx scripts/anonymize-todoist-dump.ts real-data.json anonymized.json
```

The anonymizer:
- Replaces task content with deterministic generic text
- Hashes IDs (preserving referential consistency)
- Genericizes project names (except "Inbox")
- Preserves dates, priorities, recurrence, and completion timestamps

## Integration tests

Integration tests in `test/integration/todoist.integration.test.ts` boot the mock server on a random port and exercise the real connector code end-to-end. They run as part of `yarn test`.

### Adding a regression test

1. Create `fixtures/todoist/regression-<short-id>.json` with the reproducing data
2. Add an `it('regression: <description>', ...)` block in the integration test file
3. The fixture + test pin the correct behavior permanently

## Supported connectors

| Connector | Mock available | Notes                                    |
| --------- | -------------- | ---------------------------------------- |
| Todoist   | Yes            | Full mock with pagination + scenarios    |
| Gmail     | Not yet        | Planned — requires googleapis SDK mocking|
| Others    | Not yet        | Same pattern extends to any connector    |
