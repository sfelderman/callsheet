---
'callsheet': minor
---

Read airports off the calendar instead of a list that goes stale.

Aviation weather was fetched for whatever stations were configured once and
never revisited, so the brief reported conditions for fields the household no
longer flew from while the calendar plainly said where the flying was
happening. The calendar connector now runs first when aviation weather is
enabled, and any airport named in today's or the coming week's events is added
to the weather request. Configured stations are still honoured — they're the
home fields — and the behaviour can be turned off with `derive_stations:
false`.

Identifiers are read literally from event text; `airport_aliases` maps place
names to stations for fields whose events never spell out the identifier, and
`activity_pattern` narrows the scan to events that actually imply flying.

The hardcoded fallback that pointed the area forecast at one specific region
when no ICAO station was configured is gone — the forecast is skipped instead.
Validation now warns when a station looks like an IATA code, which returns no
data rather than an error.
