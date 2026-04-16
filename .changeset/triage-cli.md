---
"callsheet": minor
---

Add interactive triage CLI. New flags:
`--triage [profile]` runs a full session, `--list-triage-profiles` lists
profile names from `triage.yaml`, and `--validate-triage-profiles` checks
the file without running anything. Each proposed action offers
`[y]es / [n]o / [e]dit / [s]kip / [m]ore / [q]uit`; `[m]ore` drills into
the sender (Gmail) or project (Todoist) by synthesizing an in-memory
profile and recursing. Session outcomes are written to
`output/triage/triage_<ISO>.json`. Also adds `triage` as a valid
`logUsage` purpose and gitignores `triage.yaml`.
