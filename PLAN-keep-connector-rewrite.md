# Plan: Rewrite google-keep Connector to Use JSON Scraper

## Status: Ready to implement

## Background

The current `google-keep.ts` connector shells out to a Python `keep_fetch.py` script that uses `gkeepapi` — requiring a Google app password, a `.venv`, and a master token file. This is fragile and requires ongoing credential management.

The replacement: a Node.js Playwright scraper (`local-service/keep-scraper.js` in the `playwright-browser-controller` repo) intercepts the Keep internal API via Chrome CDP and writes `~/.local/share/callsheet/keep-data.json`. The scraper is **complete and tested** — it reliably produces 40 notes with stable IDs, timestamps, labels, and colors.

## New Data Source

**File**: `~/.local/share/callsheet/keep-data.json`

```jsonc
{
  "scraped_at": "2026-04-10T07:01:05.454Z",
  "sync_version": "ACBwh0Zd...",           // opaque, for future incremental sync
  "total_notes": 40,
  "notes": [
    {
      "id": "1UtmCJnl0l...",               // stable serverId — use as primary key
      "localId": "19a46abfe...",
      "title": "Shopping list",
      "type": "NOTE" | "LIST",
      "text": "full indexableText...",      // untruncated; null if empty
      "labels": ["184d20a243d.895d7e.."],   // opaque label IDs (no human names yet)
      "color": "DEFAULT",                  // Keep color enum string
      "pinned": true,
      "archived": false,
      "trashed": false,
      "updated": "2025-11-03T...",
      "created": "2025-11-02T..."
    }
  ]
}
```

**Note on `items`**: LIST checked state is not in this data. `text` contains the full `indexableText` for both NOTE and LIST types. `items` should be omitted from the output (or kept as optional/null) — callsheet's description already explains this.

**Note on `labels`**: Opaque IDs only. Human-readable label names are not available from this endpoint yet. The connector should pass them through as-is.

## How to Run the Scraper

```bash
# Prerequisites: Chrome running with CDP (usually already running)
cd ~/projects/playwright-browser-controller/local-service
node keep-scraper.js
# Output: ~/.local/share/callsheet/keep-data.json
```

| Env var | Default | Description |
|---------|---------|-------------|
| `CDP_URL` | `http://localhost:9222` | Chrome CDP endpoint |
| `KEEP_OUTPUT` | `~/.local/share/callsheet/keep-data.json` | Output file path |

Exit 0 = success. Exit 1 = CDP unreachable, not logged in, or API timeout.

## What to Change in `src/connectors/google-keep.ts`

### Delete entirely
- `resolvePython()` function
- `execFilePromise()` function
- All `execFile` / Python script invocation logic
- References to `username`, `credentials_dir`, `token_file`, `password_env` config keys

### Update `KeepNote` interface
```ts
interface KeepNote {
  id: string;
  localId: string;
  title: string;
  type: 'LIST' | 'NOTE';
  text: string | null;
  labels: string[];          // opaque IDs
  color: string;
  pinned: boolean;
  archived: boolean;
  trashed: boolean;
  updated: string | null;
  created: string | null;
  // items removed — not provided by scraper
}
```

### New file-reading shape
```ts
interface KeepFile {
  scraped_at: string;
  sync_version: string | null;
  total_notes: number;
  notes: KeepNote[];
}
```

### New config keys (replace old ones)
| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `scraper_path` | string | `~/projects/playwright-browser-controller/local-service/keep-scraper.js` | Path to scraper (for Option A) |
| `data_file` | string | `~/.local/share/callsheet/keep-data.json` | Path to JSON file |
| `max_stale_minutes` | number | `60` | Warn if `scraped_at` is older than this |
| `updated_days` | number | `2` | Filter: only notes updated within N days |
| `max_notes` | number | `20` | Slice after filtering |
| `include_archived` | boolean | `false` | Include archived notes |
| `include_trashed` | boolean | `false` | Include trashed notes |
| `titles` | string[] | `[]` | Filter by title prefix match |

### New `fetch()` logic

**Option A — run scraper then read** (recommended, same pattern as current Python approach):
```ts
// 1. Run scraper
await execFilePromise('node', [scraperPath], { timeout: 20_000 });
// 2. Read JSON
const raw = readFileSync(dataFilePath, 'utf8');
const file: KeepFile = JSON.parse(raw);
// 3. Filter
let notes = file.notes;
if (!includeArchived) notes = notes.filter(n => !n.archived);
if (!includeTrashed)  notes = notes.filter(n => !n.trashed);
if (updatedDays > 0) {
  const cutoff = Date.now() - updatedDays * 24 * 60 * 60 * 1000;
  notes = notes.filter(n => n.updated && new Date(n.updated).getTime() > cutoff);
}
if (titles.length > 0) {
  notes = notes.filter(n => titles.some(t => n.title.startsWith(t)));
}
const filtered_count = notes.length;
notes = notes.slice(0, maxNotes);
```

### Update `validate()` checks
Replace Python/token/password checks with:
- `PASS/FAIL`: JSON file exists at `data_file` path
- `PASS/WARN`: `scraped_at` freshness (within `max_stale_minutes`)
- `INFO`: filter settings (`updated_days`, `max_notes`, `titles`, etc.)
- `INFO`: scraper path (does it exist?)

### Keep `ConnectorResult` shape the same
The `description` string and `data` shape can stay identical — `notes`, `total_notes`, `filtered_count`. The LLM-facing description text can stay as-is (it already accurately describes the data).

## Verification

```bash
cd ~/projects/callsheet
yarn callsheet --test
# google_keep should show PASS
```

Also spot-check the output:
```bash
yarn callsheet
# google_keep section should show notes with titles, text, labels (IDs), color
```
