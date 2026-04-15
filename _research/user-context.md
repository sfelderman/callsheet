# Sean's Context & Goals

## Who

Sean Felderman — software engineer, SF, solo household. Capture-heavy, review-light productivity style.

## Core Problems Callsheet Solves

1. **Inbox overload** — Todoist inbox 50+ items, Gmail 21k unread — no unified triage view
2. **Multi-source fragmentation** — tasks in Todoist, emails in Gmail, events in Calendar, notes in Keep — no single daily picture
3. **No review habit** — triage only happens when overwhelmed
4. **Todoist noise** — P1/date used as visibility hack → long noisy overdue lists

## Active Connectors & Customizations Made

### Google Calendar
- `colorId` support added — `COLOR_NAMES` map (1-11 → lavender, sage, grape, etc.)
- Color sent as human-readable name on each event
- Context in config: grape=travel, banana=social, flamingo=default

### Gmail
- **Phase 1 query:** `is:unread is:important in:inbox` (was too noisy before)
- **Max messages:** 50
- **Resolution signals:** Phase 2 fetches trash + archived emails (`resolved: true`), 3-day window
- **Renamed field:** `trashed` → `resolved`
- Note: `newer_than:Xd` filters by receive date, not action date — known limitation

### Todoist
- **backlog_limit: 25** — was sending 144 backlog items (17K/21K tokens)
- **backlog_projects_exclude: []** — needs populating after reviewing noisy projects
- **backlog_min_priority** — deferred until data reviewed
- Sort: priority DESC before slicing

### Google Keep
- **BLOCKED** — gkeepapi's Android OAuth flow rejected by Google for personal accounts
- Connector scaffolded (`google-keep.ts`, tests) but fetch doesn't work yet
- **Plan:** Two-phase CDP approach (see google-keep-plan.md)

## Personal Config (`config.yaml`)

```yaml
model: claude-sonnet-4-6
location: San Francisco, CA
coords: 37.769999, -122.422589

connectors enabled: google_calendar, todoist, gmail, weather
connectors disabled: google_keep, aviation_weather, home_assistant, actual_budget, market

context:
  people: "Sean, solo household"
  work: "Software engineer, remote"
  travel: Detroit Apr 1-4, SJC Apr 29, MSP/DCA May 1-3, Hawaii May 5-10
  calendar_colors: flamingo=default, grape=travel, banana=social
```

## Secrets

- `secrets/credentials.json` — Google OAuth app (Desktop type, shared across Calendar + Gmail)
- `secrets/token_calendar_sean.json` — Calendar OAuth token
- `secrets/token_gmail_sean.json` — Gmail OAuth token
- `.env` — ANTHROPIC_API_KEY, TODOIST_TOKEN_1, GOOGLE_KEEP_APP_PASSWORD (unused — auth failed)

## Pending / Known Issues

| Item | Status | Notes |
|------|--------|-------|
| Gmail test: `trash_max_age` | Pre-existing failure | Test uses old config key; connector uses `resolution_days` |
| Todoist `backlog_projects_exclude` | Empty `[]` | Needs populating after reviewing which projects are noisy |
| Google Keep connector | Auth broken | Two-phase CDP plan in progress |
| config.yaml persistence | Not done | Discussed symlink to `~/.config/callsheet/config.yaml` |
| Self-critique issues | Not reviewed | 8 issues logged on 2026-03-29 brief |
