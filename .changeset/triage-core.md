---
"callsheet": minor
---

Add triage core: `runTriage()` loads a profile, fetches scoped connector
data, and asks Claude for a summary + per-item action proposals
(`gmail_archive`, `gmail_mark_read`, `gmail_trash`, `gmail_keep`,
`todoist_close`, `todoist_reschedule`, `todoist_keep`). `executeAction()`
dispatches approved actions against Gmail and Todoist APIs, with malformed
responses dropped rather than failing the whole pass. `buildDrillProfile()`
synthesizes an in-memory profile for the `[m]ore` drill-down flow so the
same code path handles both top-level and narrow-by-sender/project passes.
Session logs land in `output/triage/triage_<ISO>.json`. No CLI wiring yet.
