---
"callsheet": minor
---

Add triage profile system: `triage.yaml` with named per-connector fetch
overrides (query, max_messages, overdue_only, older_than_days, projects,
accounts). Ships with a strict hand-written validator that flags unknown
keys, wrong value types, and typos with "did you mean?" hints — designed
so Claude can safely edit `triage.yaml` on the user's behalf without
producing silent runtime surprises. `triage.example.yaml` is committed
with four starter profiles: default, inbox_zero, stale_tasks, newsletters.
No runtime wiring yet.
