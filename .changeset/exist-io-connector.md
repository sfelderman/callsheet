---
"callsheet": minor
---

Add `exist_io` connector. Pulls the user's recent [exist.io](https://exist.io)
daily journal entries (`mood_note`), mood rating, custom tags, and tracked
metrics via the read-only Attributes API, so the brief can ground
observations in how the last few days actually felt. Configurable
`lookback_days` (1-31, capped at the API max), `groups`/`attributes` filters,
and an optional `include_insights` flag for Exist's auto-generated
observations. Auth is a simple personal token in `EXIST_IO_TOKEN`.
