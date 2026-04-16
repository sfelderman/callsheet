# Todoist Mock Fixtures

JSON files in this directory serve as test scenarios for the local mock Todoist API server.

## Format

Each file is a JSON object with three top-level arrays matching the raw Todoist API response shapes:

```json
{
  "projects": [
    { "id": "p_inbox", "name": "Inbox", "inbox_project": true },
    { "id": "p_work", "name": "Work" }
  ],
  "tasks": [
    {
      "id": "t_1",
      "content": "Task description",
      "description": "Optional details",
      "project_id": "p_work",
      "priority": 1,
      "due": { "date": "2026-04-16", "string": "today", "is_recurring": false }
    }
  ],
  "completed": [
    {
      "id": "c_1",
      "content": "Done task",
      "project_id": "p_work",
      "priority": 1,
      "completed_at": "2026-04-15T14:30:00Z"
    }
  ]
}
```

### Optional top-level keys

- `"pageSize": 10` — override the default page size of 50 (useful for testing pagination with fewer items)

## Date placeholders

Use these placeholders in `due.date` and `due.string` fields so fixtures stay date-relative:

| Placeholder   | Expansion            |
| ------------- | -------------------- |
| `<TODAY>`     | Today's date         |
| `<TODAY+N>`   | N days from today    |
| `<TODAY-N>`   | N days before today  |

Placeholders are expanded at fixture load time, so the same fixture file always produces correct test behavior regardless of when the tests run.

## Scenarios

| File                              | Purpose                                                 |
| --------------------------------- | ------------------------------------------------------- |
| `typical-day.json`                | Baseline — tasks across all categories                  |
| `empty.json`                      | Zero tasks — tests empty-state handling                 |
| `overdue-heavy.json`              | 55 tasks (>50) with `pageSize: 10` — exercises pagination |
| `regression-recurring-overdue.json` | Recurring overdue tasks land in `today` bucket         |

## Adding a new scenario

1. Create `fixtures/todoist/<name>.json` following the format above
2. Use date placeholders for any time-relative fields
3. Add a corresponding test in `test/integration/todoist.integration.test.ts`
4. If it's a regression test, name it `regression-<short-id>.json`

## Creating from real data

To turn a real Todoist API dump into an anonymized fixture:

```bash
# 1. Fetch your real data
curl -H "Authorization: Bearer $TODOIST_TOKEN" \
  https://api.todoist.com/api/v1/projects > /tmp/projects.json
curl -H "Authorization: Bearer $TODOIST_TOKEN" \
  https://api.todoist.com/api/v1/tasks > /tmp/tasks.json

# 2. Combine into fixture format
echo '{"projects":' > /tmp/raw.json
cat /tmp/projects.json | jq '.results' >> /tmp/raw.json
echo ',"tasks":' >> /tmp/raw.json
cat /tmp/tasks.json | jq '.results' >> /tmp/raw.json
echo ',"completed":[]}' >> /tmp/raw.json

# 3. Anonymize
tsx scripts/anonymize-todoist-dump.ts /tmp/raw.json fixtures/todoist/my-scenario.json

# 4. Review and clean up
# Replace absolute dates with <TODAY> placeholders as needed
```
