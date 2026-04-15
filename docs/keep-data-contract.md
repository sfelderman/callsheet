# Google Keep Scraper — Output Contract

**File:** `~/.local/share/callsheet/keep-data.json`
**Produced by:** `~/projects/playwright-browser-controller/local-service/keep-scraper-combined.js`

## Top-level shape

| Field | Type | Description |
|-------|------|-------------|
| `scraped_at` | ISO string | When the scrape ran |
| `sync_version` | string\|null | Opaque Keep sync token (for future incremental sync, not yet used) |
| `total_notes` | number | Total notes in output array |
| `merge_stats` | object | `{ merged, api_only, dom_only }` counts |
| `notes` | KeepNote[] | Notes in DOM visual order (pinned first), then API-only notes appended |

## Note shape

| Field | Type | Description |
|-------|------|-------------|
| `id` | string\|null | Stable server ID. Null for `dom_only` notes (not yet synced or not matched) |
| `localId` | string\|null | Local device ID. Null for `dom_only` |
| `title` | string | Note title (empty string if untitled) |
| `type` | `'NOTE'\|'LIST'` | Note type |
| `text` | string\|null | Full note text (NOTE type) or indexable text (LIST type). Null if empty |
| `checkedItems` | `{text, checked}[]\|null` | Checkbox items (LIST type, from DOM). Null for NOTE type or `api_only` LISTs |
| `labels` | `{id, name}[]` | Label pairs — `id` is opaque API ID, `name` is human label (null for non-DOM notes) |
| `color` | string | Keep color enum (`DEFAULT`, `RED`, `BLUE`, etc.) |
| `pinned` | boolean | Whether note is pinned |
| `pinned_source` | `'dom'\|'api'` | Source of pinned status (`dom` = visually confirmed, `api` = from API metadata) |
| `archived` | boolean | Whether archived |
| `trashed` | boolean | Whether in trash |
| `updated` | ISO string\|null | Last edit timestamp |
| `created` | ISO string\|null | Creation timestamp |
| `source` | `'merged'\|'api_only'\|'dom_only'` | Data completeness indicator (see below) |

## `source` field semantics

| Value | Meaning | Data quality |
|-------|---------|-------------|
| `merged` | Matched between API and DOM | Richest: has server ID, timestamps, AND visual order/checkedItems |
| `dom_only` | Visible in DOM, no API match | Has checkedItems and visual order; missing server ID and timestamps |
| `api_only` | In API response, not in DOM scroll window | Has server ID and timestamps; missing checkedItems |

**Recommendation:** For AI context, prefer `merged` notes. Use `api_only` for recently-modified notes not yet scrolled into view.

## Notes output order

Notes are sorted pinned-first (DOM visual order), then non-pinned DOM notes, then `api_only` notes appended at the end.

## Known gaps

- **Label names**: `labels[].name` is null for `merged` and `api_only` notes. Only DOM-visible notes (`dom_only`) have human-readable label names. Label IDs are available for all.
- **LIST text**: `text` for LIST notes comes from `indexableText` (API), which is plaintext. `checkedItems` (DOM) provides per-item checked state.
- **dom_only IDs**: Notes only visible in DOM have null `id`/`localId` — cannot be used as stable keys.
