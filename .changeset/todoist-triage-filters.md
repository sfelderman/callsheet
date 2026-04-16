---
"callsheet": minor
---

Add `max_tasks`, `include_overdue_only`, `include_older_than_days`, and
`projects` post-fetch filters to the Todoist connector. These knobs are
unused by the daily brief (which passes none) and exist so triage
sessions can scope Todoist to just the tasks you want to review —
overdue only, a specific project, tasks older than N days. The filters
apply to the flat task list before bucketing so today/inbox/upcoming/
backlog views all narrow consistently.
