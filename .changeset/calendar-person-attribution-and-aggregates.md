---
'callsheet': minor
---

Calendar events now carry per-person attribution and pre-computed counts.

Each event lists the household member(s) whose calendar it came from, and an
event appearing on two calendars is merged into one shared event that keeps
both names rather than being deduplicated down to one person. The connector
also emits an `aggregates` block with per-person totals for the recent, today
and upcoming windows, plus optional per-category tallies driven by a new
`event_categories` config option, so the brief cites counts instead of
computing them.

Alongside that: results are paginated (previously capped at one page, silently
dropping events on busy calendars), per-calendar fetch failures are surfaced in
the payload instead of only logged, query windows are bounded in the configured
timezone rather than the process one, and `lookback_days` now defaults to 7 so
past events are available on every run rather than only on the weekly review
day.
